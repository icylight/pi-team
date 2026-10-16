/**
 * /peer-focus 专注模式：对外隐身、不接收消息，自己发出一条后自动退出。
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

function hiddenCount(root: string, cwd: string): number {
	return memberFiles(root, cwd).filter((f) => JSON.parse(fs.readFileSync(f, "utf8")).hidden === true).length;
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

test("进入专注模式后对其他会话隐身，退出后恢复", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.commands.get("peer-focus")!.handler("", h.ctx);

		assert.equal(hiddenCount(h.root, h.cwd), 1, "自己标成隐身");
		assert.match(h.notes.at(-1)!, /已进入专注模式/);
		assert.equal(
			new PeerStore(h.root, h.cwd).listMembers({ includeStale: true }).length,
			0,
			"别的会话列表里看不到它",
		);
		assert.equal(memberFiles(h.root, h.cwd).length, 1, "注册文件还在，只是被别人过滤掉——不是假装掉线");

		await h.commands.get("peer-focus")!.handler("off", h.ctx);
		assert.equal(hiddenCount(h.root, h.cwd), 0);
		assert.equal(new PeerStore(h.root, h.cwd).listMembers({ includeStale: true }).length, 1);
		assert.match(h.notes.at(-1)!, /已退出专注模式/);
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("专注期间不投消息，退出后补投", async () => {
	const h = harness();
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		const selfKey = path.basename(memberFiles(h.root, h.cwd)[0]).replace(/\.json$/, "");
		await h.commands.get("peer-focus")!.handler("", h.ctx);

		// 模拟进入专注前已经落进收件箱、还没来得及取的一条消息
		const store = new PeerStore(h.root, h.cwd);
		const id = newMessageId();
		store.send({
			id,
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
		assert.equal(hiddenCount(h.root, h.cwd), 1);

		const res = await h.tools
			.get("peer_send")
			.execute("synthetic", { to: "helper", text: "在吗" }, undefined, undefined, h.ctx);
		assert.match(JSON.stringify(res), /已写入 helper/);
		assert.equal(hiddenCount(h.root, h.cwd), 0, "发出消息即恢复可见");
		assert.match(h.notes.join("\n"), /已退出专注模式（已发出消息）/);
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("代其他扩展投递不算自己开口，不解除专注", async () => {
	const h = harness();
	try {
		peerSession(h.root, h.cwd, "7950-dddd", "helper");
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.commands.get("peer-focus")!.handler("", h.ctx);

		h.bus.get("peer:deliver")!({ id: "wake-1", targets: ["helper"], text: "该你了" });

		const reply = h.emitted.find((e) => e.name === "peer:deliver:result")?.data as { ok?: boolean } | undefined;
		assert.equal(reply?.ok, true, "代投本身应该成功");
		assert.equal(hiddenCount(h.root, h.cwd), 1, "系统代投不该把会话从专注模式里叫出来");
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("专注时 peer_list 里自己带专注标记，别人照常列", async () => {
	const h = harness();
	try {
		peerSession(h.root, h.cwd, "7900-cccc", "helper");
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.commands.get("peer-focus")!.handler("", h.ctx);

		const res = JSON.stringify(await h.tools.get("peer_list").execute("synthetic", {}, undefined, undefined, h.ctx));
		assert.match(res, /我·专注中/);
		assert.match(res, /helper/);
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});
