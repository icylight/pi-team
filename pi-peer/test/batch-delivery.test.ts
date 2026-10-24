/**
 * 一批普通消息合成一条注入。
 *
 * pi 在空闲时对每条 sendMessage 各起一轮（agent-session 的 sendCustomMessage
 * 非流式分支直接 _startRun），流式期间才进 followUp 队列且默认一轮一条。
 * 所以「一批只跑一轮」由扩展侧合并实现，这里盯着注入次数。
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
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "peer-batch-"));
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "peer.json"), "{}");
	const root = path.join(cwd, "peers");
	const handlers = new Map<string, (...args: any[]) => any>();
	const notes: string[] = [];
	const injected: { content: string; options?: any; customType?: string }[] = [];
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
		registerTool: () => {},
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		events: { on: () => () => {}, emit: () => {} },
		getSessionName: () => "batch-session",
		appendEntry: () => {},
		setModel: async () => true,
		setThinkingLevel: () => {},
		sendMessage: (message: any, options?: any) =>
			injected.push({ content: String(message.content ?? ""), options, customType: message.customType }),
		sendUserMessage: () => {},
	};
	process.chdir(cwd);
	process.env.PI_PEER_ROOT = root;
	delete process.env.PI_PEER_ROLE;
	extension(pi as any);
	return { cwd, root, handlers, notes, injected, ctx };
}

function selfKey(root: string, cwd: string): string {
	const dir = path.join(root, cwdKey(cwd), "members");
	const f = fs.readdirSync(dir).find((name) => name.endsWith(".json"));
	assert.ok(f, "会话已注册");
	return f.replace(/\.json$/, "");
}

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

test("一次到达的三条普通消息只注入一次", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		const ids = [
			incoming(h.root, h.cwd, "第一条：T01 对账"),
			incoming(h.root, h.cwd, "第二条：T02 缺一条证据"),
			incoming(h.root, h.cwd, "第三条：T03 可以收口"),
		];

		await delay(400);
		assert.equal(h.injected.length, 1, "三条合成一条注入，只跑一轮");
		const body = h.injected[0]!.content;
		for (const text of ["第一条：T01 对账", "第二条：T02 缺一条证据", "第三条：T03 可以收口"]) {
			assert.match(body, new RegExp(text));
		}
		for (const id of ids) assert.match(body, new RegExp(`id=${id}`), "每条都带自己的 id，好逐条回复");
		assert.match(body, /^\[peer 批次｜3 条｜helper\]/, "首行标明这是合并批次");
		assert.equal(h.injected[0]!.customType, "peer", "批量消息用固定类型，渲染器不用按发件人注册");
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("忙时到达的几条也立即合成一条注入，这一轮结束不会再补投一次", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		h.handlers.get("agent_start")!({});
		incoming(h.root, h.cwd, "甲：先别动 T04");
		incoming(h.root, h.cwd, "乙：T05 的证据我补了");

		await delay(400);
		assert.equal(h.injected.length, 1, "忙时也取走，不等这一轮结束");
		assert.equal(h.injected[0]!.options?.deliverAs, "steer");
		assert.match(h.injected[0]!.content, /甲：先别动 T04[\s\S]*乙：T05 的证据我补了/);

		h.handlers.get("agent_end")!({});
		await delay(400);
		assert.equal(h.injected.length, 1, "收件箱已空，不会重复注入");
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("单条消息仍走单条路径，格式不变", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		const id = incoming(h.root, h.cwd, "只有一条");

		await delay(400);
		assert.equal(h.injected.length, 1);
		assert.match(h.injected[0]!.content, /^\[peer helper｜\d{2}:\d{2}\]/, "单条保持原首行");
		assert.match(h.injected[0]!.content, new RegExp(`replyTo="${id}"`));
		assert.equal(h.injected[0]!.customType, "helper", "单条仍按发件人当类型");
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("整批都走 steer，不因为来源不同拆成几条", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		incoming(h.root, h.cwd, "甲条");
		incoming(h.root, h.cwd, "乙条", { fromName: "other" });
		incoming(h.root, h.cwd, "丙条");

		await delay(400);
		assert.equal(h.injected.length, 1, "同一批合成一条");
		assert.equal(h.injected[0]!.options?.deliverAs, "steer");
		assert.match(h.injected[0]!.content, /甲条[\s\S]*乙条[\s\S]*丙条/);
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("在忙时默认消息也立即插入，不堆在收件箱", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		h.handlers.get("agent_start")!({});
		incoming(h.root, h.cwd, "在忙也要立刻看到");
		incoming(h.root, h.cwd, "第二条也立刻");

		await delay(400);
		assert.equal(h.injected.length, 1, "忙时也取走并注入，不留在收件箱堆积");
		assert.equal(h.injected[0]!.options?.deliverAs, "steer");
		assert.match(h.injected[0]!.content, /在忙也要立刻看到[\s\S]*第二条也立刻/);
		const pendingDir = new PeerStore(h.root, h.cwd).pendingDir(selfKey(h.root, h.cwd));
		assert.equal(fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json")).length, 0, "收件箱清空");
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});
