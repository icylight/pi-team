/**
 * 忙时消息留在收件箱 + peer_fetch 主动取走。
 *
 * 与 focus.test.ts 同款 mock pi；这里用 agent_start / agent_end 翻忙闲，
 * 因为「在忙」正是这两件事发生与否的判据。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import extension from "../index.ts";
import { cwdKey, newMessageId, type PeerMessage, PeerStore } from "../store.ts";

function harness() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "peer-fetch-"));
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "peer.json"), "{}");
	const root = path.join(cwd, "peers");
	const handlers = new Map<string, (...args: any[]) => any>();
	const tools = new Map<string, any>();
	const notes: string[] = [];
	const injected: string[] = [];
	const ctx = {
		cwd,
		hasUI: true,
		model: { provider: "test", id: "model" },
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
		sessionManager: { getEntries: () => [], getSessionFile: (): string | undefined => undefined },
		ui: {
			notify: (text: string) => notes.push(text),
			setStatus: () => {},
			theme: { fg: (_: string, text: string) => text },
			select: async () => undefined,
		},
	};
	const pi = {
		on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		events: { on: () => () => {}, emit: () => {} },
		getSessionName: () => "busy-session",
		appendEntry: () => {},
		setModel: async () => true,
		setThinkingLevel: () => {},
		sendMessage: (message: any) => injected.push(String(message.content ?? "")),
		sendUserMessage: () => {},
	};
	process.chdir(cwd);
	process.env.PI_PEER_ROOT = root;
	delete process.env.PI_PEER_ROLE;
	extension(pi as any);
	return { cwd, root, handlers, tools, notes, injected, ctx };
}

function selfKey(root: string, cwd: string): string {
	const dir = path.join(root, cwdKey(cwd), "members");
	const f = fs.readdirSync(dir).find((name) => name.endsWith(".json"));
	assert.ok(f, "会话已注册");
	return f.replace(/\.json$/, "");
}

/** 别人投进来的一条消息；priority 不写就是普通消息 */
function incoming(root: string, cwd: string, text: string, extra: Partial<PeerMessage> = {}) {
	const store = new PeerStore(root, cwd);
	const id = newMessageId();
	store.send({
		id,
		from: "7700-aaaa",
		fromName: "helper",
		to: selfKey(root, cwd),
		text,
		ts: Date.now(),
		...extra,
	});
	return id;
}

function pendingCount(root: string, cwd: string): number {
	return new PeerStore(root, cwd).peekPending(selfKey(root, cwd)).length;
}

test("在忙时普通消息留在收件箱，只提示不注入", async () => {
	const h = harness();
	const notified = () => h.notes.filter((n) => n.includes("这一轮结束后送达")).length;
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		h.handlers.get("agent_start")!({});
		incoming(h.root, h.cwd, "先别动那条工单，等我改完配置");

		await delay(400);
		assert.equal(h.injected.length, 0, "在忙时不打断当前这一轮");
		assert.equal(pendingCount(h.root, h.cwd), 1, "消息还在收件箱里等着");
		assert.equal(notified(), 1, "弹了一句提示");
		assert.match(h.notes.find((n) => n.includes("这一轮结束后送达"))!, /helper/);

		await delay(2_500); // 跨过一次轮询：同一条消息不该再提示一遍
		assert.equal(notified(), 1, "轮询重看收件箱不重复提示");
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("peer_fetch 取走后正文直接给到模型，本轮结束不再注入", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		h.handlers.get("agent_start")!({});
		const id = incoming(h.root, h.cwd, "交接前先把 T01 关掉");
		await delay(400);

		const res = await h.tools.get("peer_fetch").execute("fetch-1", {}, undefined, undefined, h.ctx);
		const body = String(res.content[0].text);
		assert.match(body, /交接前先把 T01 关掉/);
		assert.match(body, new RegExp(`id=${id}`));
		assert.match(body, /\[\d{2}:\d{2}｜\d+ 秒前\]/, "取走时要能看到这条是什么时候发的");
		assert.equal(pendingCount(h.root, h.cwd), 0, "取过的离开收件箱");

		h.handlers.get("agent_end")!({});
		await delay(400);
		assert.equal(h.injected.length, 0, "已取走的消息不会再自动注入一遍");
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("不取也照常送达：这一轮结束后自动注入", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		h.handlers.get("agent_start")!({});
		incoming(h.root, h.cwd, "忙完回我一句");
		await delay(400);
		assert.equal(h.injected.length, 0);

		h.handlers.get("agent_end")!({});
		await delay(400);
		assert.equal(h.injected.length, 1, "忙完补投");
		assert.match(h.injected[0]!, /忙完回我一句/);
		assert.match(h.injected[0]!, /^\[peer [^\]]+｜\d{2}:\d{2}\]/, "注入正文首行带发送时刻");
		assert.equal(pendingCount(h.root, h.cwd), 0);
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("紧急消息不受影响：在忙也立即插入", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		h.handlers.get("agent_start")!({});
		incoming(h.root, h.cwd, "立刻停下", { priority: "urgent" });

		await delay(400);
		assert.equal(h.injected.length, 1, "urgent 照旧 steer 插队");
		assert.equal(pendingCount(h.root, h.cwd), 0);
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("收件箱为空时 peer_fetch 直接说明，不报错", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		const res = await h.tools.get("peer_fetch").execute("fetch-2", {}, undefined, undefined, h.ctx);
		assert.match(String(res.content[0].text), /没有等着投递的消息/);
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});
