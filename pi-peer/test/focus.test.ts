/**
 * /peer-focus 专注模式：仍然可见，但消息被拒发；自己发出一条后自动退出。
 *
 * 用与 peer-role-command.test.ts 同款的 mock pi；这里额外捕获 sendMessage，
 * 好判断消息有没有真的投进会话。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import extension from "../index.ts";
import { cwdKey, newMessageId, PeerStore } from "../store.ts";

function harness() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "peer-focus-"));
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "peer.json"), "{}");
	const root = path.join(cwd, "peers");
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>();
	const tools = new Map<string, any>();
	const notes: string[] = [];
	const injected: string[] = [];
	const bus = new Map<string, (data: unknown) => void>();
	const emitted: { name: string; data: unknown }[] = [];
	const ctx = {
		isIdle: () => true,
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
		registerCommand: (name: string, def: any) => commands.set(name, def),
		registerMessageRenderer: () => {},
		events: {
			on: (name: string, handler: (data: unknown) => void) => {
				bus.set(name, handler);
				return () => bus.delete(name);
			},
			emit: (name: string, data: unknown) => {
				emitted.push({ name, data });
				bus.get(name)?.(data);
			},
		},
		getSessionName: () => "focused-session",
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
	return { cwd, root, handlers, commands, tools, notes, injected, bus, emitted, ctx };
}

function memberFiles(root: string, cwd: string): string[] {
	try {
		return fs
			.readdirSync(path.join(root, cwdKey(cwd), "members"))
			.filter((f) => f.endsWith(".json"))
			.map((f) => path.join(root, cwdKey(cwd), "members", f));
	} catch {
		return [];
	}
}

test("发给专注中的同伴直接拒发，并说明原因", async () => {
	const h = harness();
	try {
		const store = new PeerStore(h.root, h.cwd);
		store.ensure("7999-eeee");
		store.register({
			key: "7999-eeee",
			name: "busy-peer",
			model: "test/model",
			pid: process.pid,
			cwd: h.cwd,
			muted: true,
			messageProtocol: 1,
			startedAt: Date.now(),
			lastSeen: Date.now(),
		});
		await h.handlers.get("session_start")!({}, h.ctx);

		const sent = JSON.stringify(
			await h.tools
				.get("peer_send")
				.execute("synthetic", { to: "busy-peer", text: "在吗" }, undefined, undefined, h.ctx),
		);
		assert.match(sent, /专注中，不接收消息/, "拒发要带上原因，不能报成找不到");
		assert.equal(store.drain("7999-eeee").length, 0, "没写进收件箱");

		const listed = JSON.stringify(
			await h.tools.get("peer_list").execute("synthetic", {}, undefined, undefined, h.ctx),
		);
		assert.match(listed, /busy-peer（专注中，不收消息）/, "列表里看得出它只是不收");
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

function mutedCount(root: string, cwd: string): number {
	return memberFiles(root, cwd).filter((f) => JSON.parse(fs.readFileSync(f, "utf8")).muted === true).length;
}

/** 同项目里另一个会话；专注用例拿它当「别人」的视角 */
function peerSession(root: string, cwd: string, key: string, name: string): PeerStore {
	const store = new PeerStore(root, cwd);
	store.ensure(key);
	store.register({
		key,
		name,
		model: "test/model",
		pid: process.pid,
		cwd,
		messageProtocol: 1,
		startedAt: Date.now(),
		lastSeen: Date.now(),
	});
	return store;
}

test("进入专注后别人仍看得见，但解析与被投递都被拒", async () => {
	const h = harness();
	try {
		peerSession(h.root, h.cwd, "7700-aaaa", "helper");
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.commands.get("peer-focus")!.handler("", h.ctx);

		assert.equal(mutedCount(h.root, h.cwd), 1, "自己标成 muted");
		assert.match(h.notes.at(-1)!, /已进入专注模式/);

		const outsider = new PeerStore(h.root, h.cwd);
		assert.ok(
			outsider
				.listMembers({ includeStale: true })
				.map((m) => m.name)
				.includes("focused-session"),
			"别人列表里仍然看得到——隐身会让发送方以为掉线",
		);
		const seen = outsider.resolve("focused-session", "7700-aaaa");
		assert.equal(seen.ok === false && seen.reason, "muted", "寻得到，但报「专注中」而不是「找不到」");
		const delivered = outsider.deliverTo("focused-session", { from: "7700-aaaa", fromName: "helper", text: "在吗" });
		assert.equal(delivered.ok, false, "拒发");
		assert.equal(
			new PeerStore(h.root, h.cwd).drain(
				memberFiles(h.root, h.cwd)[0]
					.split("/")
					.pop()!
					.replace(/\.json$/, ""),
			).length,
			0,
			"被拒的消息不写进收件箱",
		);

		await h.commands.get("peer-focus")!.handler("off", h.ctx);
		assert.equal(mutedCount(h.root, h.cwd), 0);
		assert.match(h.notes.at(-1)!, /已退出专注模式/);
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("专注期间不取收件箱：进入前积压的消息退出后补投", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		const selfKey = path.basename(memberFiles(h.root, h.cwd)[0]).replace(/\.json$/, "");
		await h.commands.get("peer-focus")!.handler("", h.ctx);

		// 模拟进入专注前已经落进收件箱、还没来得及取的一条消息
		const store = new PeerStore(h.root, h.cwd);
		store.send({
			id: newMessageId(),
			from: "7700-aaaa",
			fromName: "helper",
			to: selfKey,
			text: "在吗",
			ts: Date.now(),
		});

		await delay(2_500); // > POLL_MS，轮询至少跑过一轮
		assert.equal(h.injected.length, 0, "专注期间不取收件箱，也不唤醒本轮");

		await h.commands.get("peer-focus")!.handler("off", h.ctx);
		await delay(300);
		assert.equal(h.injected.length, 1, "退出后积压的消息补投");
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("自己发出一条消息后自动退出专注", async () => {
	const h = harness();
	try {
		peerSession(h.root, h.cwd, "7800-bbbb", "helper");
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.commands.get("peer-focus")!.handler("", h.ctx);
		assert.equal(mutedCount(h.root, h.cwd), 1);

		const res = await h.tools
			.get("peer_send")
			.execute("synthetic", { to: "helper", text: "在吗" }, undefined, undefined, h.ctx);
		assert.match(JSON.stringify(res), /已写入 helper/);
		assert.equal(mutedCount(h.root, h.cwd), 0, "发出消息即恢复接收");
		assert.match(h.notes.join("\n"), /已退出专注模式（已发出消息）/);
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("系统代投不算自己开口，专注保持", async () => {
	const h = harness();
	try {
		peerSession(h.root, h.cwd, "7950-dddd", "helper");
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.commands.get("peer-focus")!.handler("", h.ctx);

		h.bus.get("peer:deliver")!({ id: "wake-1", targets: ["helper"], text: "该你了" });
		const toOther = h.emitted.find((e) => e.name === "peer:deliver:result")?.data as { ok?: boolean } | undefined;
		assert.equal(toOther?.ok, true, "代投别人的消息照常成功");
		assert.equal(mutedCount(h.root, h.cwd), 1, "系统代投不该把会话从专注模式里叫出来");
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("专注时 peer_list 里自己带不收消息标记，别人照常列", async () => {
	const h = harness();
	try {
		peerSession(h.root, h.cwd, "7900-cccc", "helper");
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.commands.get("peer-focus")!.handler("", h.ctx);

		const res = JSON.stringify(await h.tools.get("peer_list").execute("synthetic", {}, undefined, undefined, h.ctx));
		assert.match(res, /我·专注中，不收消息/);
		assert.match(res, /helper/);
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("peer_focus 工具能自己进出专注", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		const tool = h.tools.get("peer_focus");
		assert.ok(tool, "工具已注册");

		const enter = await tool.execute("synthetic", {}, undefined, undefined, h.ctx);
		assert.match(JSON.stringify(enter), /已进入专注模式/);
		assert.equal(mutedCount(h.root, h.cwd), 1);

		const again = await tool.execute("synthetic", {}, undefined, undefined, h.ctx);
		assert.match(JSON.stringify(again), /已在专注模式/);

		const leave = await tool.execute("synthetic", { on: false }, undefined, undefined, h.ctx);
		assert.match(JSON.stringify(leave), /已退出专注模式/);
		assert.equal(mutedCount(h.root, h.cwd), 0);
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});
