import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import workOrders from "../../pi-work-orders/index.ts";
import peerExtension from "../index.ts";

async function mounted(native = false, options: { wake?: boolean } = {}) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-integration-"));
	fs.mkdirSync(path.join(cwd, ".pi", "characters"), { recursive: true });
	for (const name of ["dev", "qa"])
		fs.writeFileSync(path.join(cwd, ".pi", "characters", `${name}.md`), `${name} card`);
	// 唤醒默认关；这里的用例验的是唤醒链路，所以要显式开
	fs.writeFileSync(
		path.join(cwd, ".pi", "peer.json"),
		JSON.stringify(options.wake === false ? {} : { wakeOnHandoff: true }),
		"utf8",
	);
	const previousCwd = process.cwd();
	const previousRoot = process.env.PI_PEER_ROOT;
	const previousRole = process.env.PI_PEER_ROLE;
	process.chdir(cwd);
	process.env.PI_PEER_ROOT = path.join(cwd, "peers");
	process.env.PI_PEER_ROLE = "dev";
	const handlers = new Map<string, any[]>();
	const channels = new Map<string, any[]>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const sent: any[] = [];
	const runtime = { confirm: true, wakes: 0, persist: true, messageEnd: false, wakeError: false };
	const manager = native ? SessionManager.create(cwd, path.join(cwd, "sessions")) : undefined;
	const sessionFile = manager?.getSessionFile() ?? path.join(cwd, "session.jsonl");
	const ctx = {
		cwd,
		hasUI: false,
		isIdle: () => true,
		model: { provider: "test", id: "model" },
		modelRegistry: { find: () => undefined },
		sessionManager: manager ?? { getEntries: () => entries, getSessionFile: (): string | undefined => sessionFile },
		ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_: string, text: string) => text } },
	};
	const pi: any = {
		on: (name: string, fn: any) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, def: any) => commands.set(name, def),
		registerMessageRenderer: () => {},
		getSessionName: () => "dev",
		setModel: async () => true,
		setThinkingLevel: () => {},
		appendEntry: (customType: string, data: unknown) =>
			manager ? manager.appendCustomEntry(customType, data) : entries.push({ type: "custom", customType, data }),
		sendMessage: (message: any, options: any) => {
			sent.push({ message, options });
			if (manager)
				manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
			else {
				const entry = {
					id: `mock-${sent.length}`,
					type: "custom_message",
					customType: message.customType,
					details: message.details,
				};
				entries.push(entry);
				if (runtime.persist) fs.appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
			}
			if (runtime.messageEnd)
				for (const fn of handlers.get("message_end") ?? []) fn({ message: { ...message, role: "custom" } }, ctx);
		},
		sendUserMessage: () => {
			runtime.wakes++;
			if (runtime.wakeError) throw new Error("synthetic wake failure");
		},
		events: {
			on: (name: string, fn: any) => {
				channels.set(name, [...(channels.get(name) ?? []), fn]);
				return () =>
					channels.set(
						name,
						(channels.get(name) ?? []).filter((f) => f !== fn),
					);
			},
			emit: (name: string, data: unknown) => {
				if (name === "work-orders:handoff-injected" && !runtime.confirm) return;
				for (const fn of channels.get(name) ?? []) fn(data);
			},
		},
	};
	peerExtension(pi);
	workOrders(pi);
	const emit = async (name: string) => {
		for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
	};
	const call = async (name: string, params: unknown) =>
		tools.get(name).execute("test", params, undefined, undefined, ctx);
	await emit("session_start");
	await call("orders_init", {});
	return {
		manager,
		sessionFile,
		runtime,
		cwd,
		ctx,
		tools,
		commands,
		sent,
		emit,
		call,
		async close() {
			await emit("session_shutdown");
			process.chdir(previousCwd);
			if (previousRoot === undefined) delete process.env.PI_PEER_ROOT;
			else process.env.PI_PEER_ROOT = previousRoot;
			if (previousRole === undefined) delete process.env.PI_PEER_ROLE;
			else process.env.PI_PEER_ROLE = previousRole;
		},
	};
}
async function waitFor(check: () => boolean, timeout = 7500) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (check()) return;
		await delay(40);
	}
	assert.fail("集成条件超时");
}

test("跨包真实 SessionManager: 空白会话不能早报送达，首次用户消息落盘后才确认且只唤醒一次", async () => {
	const h = await mounted(true);
	try {
		await h.call("orders_create", { title: "synthetic first task", nextActors: ["dev"], actor: "owner" });
		await waitFor(() => h.sent.length === 1 && h.runtime.wakes === 1);
		assert.equal(fs.existsSync(h.sessionFile), false);
		assert.equal(
			JSON.parse((await h.call("orders_notifications", { id: "T01" })).content[0].text)[0].status,
			"sending",
		);
		h.manager!.appendMessage({ role: "user", content: "synthetic wake persisted", timestamp: Date.now() });
		await waitFor(() => {
			const db = new DatabaseSync(path.join(h.cwd, ".work-orders", "notifications.sqlite"), { readOnly: true });
			try {
				return (db.prepare("SELECT status FROM notifications").get() as { status: string })?.status === "delivered";
			} finally {
				db.close();
			}
		});
		assert.equal(h.runtime.wakes, 1);
		assert.match((await h.call("orders_show", { id: "T01" })).content[0].text, /待认领/);
	} finally {
		await h.close();
	}
});

test("跨包: API 返回和模拟 message_end 不能代替真实文件，唤醒不落盘仍不报送达", async () => {
	const h = await mounted();
	try {
		h.runtime.persist = false;
		h.runtime.messageEnd = true;
		h.runtime.wakeError = true;
		await h.call("orders_create", { title: "synthetic lost persistence", nextActors: ["dev"], actor: "owner" });
		await waitFor(() => h.sent.length === 1 && h.runtime.wakes === 1);
		await delay(150);
		assert.equal(fs.existsSync(h.sessionFile), false);
		assert.equal(
			JSON.parse((await h.call("orders_notifications", { id: "T01" })).content[0].text)[0].status,
			"sending",
		);
		assert.equal(h.runtime.wakes, 1);
		const expire = () => {
			const db = new DatabaseSync(path.join(h.cwd, ".work-orders", "notifications.sqlite"));
			try {
				db.prepare("UPDATE notifications SET lease_until=0 WHERE order_id='T01'").run();
			} finally {
				db.close();
			}
		};
		for (const expected of [2, 3]) {
			expire();
			await h.call("orders_update", {
				id: "T01",
				appendBody: "synthetic retry",
				reason: "synthetic lease fault",
				actor: "owner",
			});
			await waitFor(() => h.sent.length === expected);
		}
		expire();
		await h.call("orders_update", {
			id: "T01",
			appendBody: "synthetic final retry",
			reason: "synthetic lease fault",
			actor: "owner",
		});
		const final = JSON.parse((await h.call("orders_notifications", { id: "T01" })).content[0].text)[0];
		assert.equal(final.status, "failed");
		assert.equal(final.attempts, 3);
		assert.equal(h.sent.length, 3);
		assert.equal(h.runtime.wakes, 1);
	} finally {
		await h.close();
	}
});

test("跨包: 默认不叫醒——交接落进会话并确认送达，但不注入唤醒消息", async () => {
	const h = await mounted(true, { wake: false });
	try {
		await h.call("orders_create", { title: "synthetic quiet handoff", nextActors: ["dev"], actor: "owner" });
		await waitFor(() => h.sent.length === 1);
		await delay(300);
		assert.equal(h.runtime.wakes, 0);
		assert.equal(h.sent[0].options.triggerTurn, false, "交接正文不自己开一轮");
	} finally {
		await h.close();
	}
});

test("跨包: 内存会话无持久路径，不标送达也不启动无法确认的模型轮", async () => {
	const h = await mounted();
	try {
		h.runtime.persist = false;
		h.ctx.sessionManager.getSessionFile = () => undefined;
		await h.call("orders_create", { title: "synthetic in-memory target", nextActors: ["dev"], actor: "owner" });
		await waitFor(() => h.sent.length === 1);
		assert.equal(h.runtime.wakes, 0);
		assert.equal(
			JSON.parse((await h.call("orders_notifications", { id: "T01" })).content[0].text)[0].status,
			"sending",
		);
	} finally {
		await h.close();
	}
});

test("跨包完整链路：忙时耐久等待，重启后自动恢复，注入才记送达且不自动认领", async () => {
	const h = await mounted();
	try {
		await h.emit("agent_start");
		const created = await h.call("orders_create", { title: "合成忙碌任务", nextActors: ["dev"], actor: "owner" });
		assert.match(created.content[0].text, /waiting/);
		assert.equal(h.sent.length, 0);
		// 模拟忙碌期间进程消失，没有 agent_end；新会话不能继承旧 busy 标记。
		await h.emit("session_shutdown");
		await h.emit("session_start");
		await waitFor(() => h.sent.length === 1);
		assert.equal(h.sent[0].options.deliverAs, "steer");
		const states = await h.call("orders_notifications", { id: "T01" });
		assert.equal(JSON.parse(states.content[0].text)[0].status, "delivered");
		assert.match((await h.call("orders_show", { id: "T01" })).content[0].text, /待认领/);
	} finally {
		await h.close();
	}
});

test("跨包确认丢失：重启后用持久历史补确认，不重复注入且确认后首次唤醒", async () => {
	const h = await mounted();
	let queue: DatabaseSync | undefined;
	try {
		h.runtime.confirm = false;
		await h.call("orders_create", { title: "合成确认丢失", nextActors: ["dev"], actor: "owner" });
		await waitFor(() => h.sent.length === 1);
		queue = new DatabaseSync(path.join(h.cwd, ".work-orders", "notifications.sqlite"));
		assert.equal(queue.prepare("SELECT status FROM notifications").get()?.status, "sending");
		assert.equal(h.runtime.wakes, 0);
		await h.emit("session_shutdown");
		queue.exec("UPDATE notifications SET lease_until=0");
		h.runtime.confirm = true;
		await h.emit("session_start");
		await waitFor(() => queue?.prepare("SELECT status FROM notifications").get()?.status === "delivered");
		assert.equal(h.sent.length, 1);
		assert.equal(h.runtime.wakes, 1);
		assert.equal(queue.prepare("SELECT attempts FROM notifications").get()?.attempts, 1);
	} finally {
		queue?.close();
		await h.close();
	}
});

test("跨包离线恢复：目标出现后自动投，工单通知与普通消息都走 steer", async () => {
	const h = await mounted();
	try {
		const created = await h.call("orders_create", { title: "合成离线任务", nextActors: ["qa"], actor: "owner" });
		assert.match(created.content[0].text, /waiting/);
		assert.equal(h.sent.length, 0);
		await h.commands.get("peer-role").handler("qa", h.ctx);
		await waitFor(() => h.sent.length === 1);
		const own = await h.call("orders_create", { title: "切换角色后的自派", nextActors: ["qa"] });
		assert.match(own.content[0].text, /当前无须通知/);
		assert.equal(h.sent.length, 1);
		const actualPeer = await import("../store.ts");
		const store = new actualPeer.PeerStore(path.join(h.cwd, "peers"), h.cwd);
		const me = store.listMembers()[0];
		store.send({
			id: actualPeer.newMessageId(),
			from: "other",
			fromName: "owner",
			to: me.key,
			text: "第二条普通消息",
			ts: Date.now(),
		});
		await waitFor(() => h.sent.length === 2);
		assert.deepEqual(
			h.sent.map((s) => s.options.deliverAs),
			["steer", "steer"],
		);
	} finally {
		await h.close();
	}
});
