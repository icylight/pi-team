import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import extension from "../index.ts";
import { SESSION_TASK_ENTRY } from "../session-control.ts";
import { type PeerMessage, PeerStore } from "../store.ts";

/** 与 role-defaults.test.ts 同款的 mock：这里额外捕获 registerCommand，好直接调命令处理器 */
function harness(config: object) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "peer-role-cmd-"));
	fs.mkdirSync(path.join(cwd, ".pi", "characters"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "characters", "dev.md"), "dev card");
	fs.writeFileSync(path.join(cwd, ".pi", "characters", "reviewer.md"), "reviewer card");
	fs.writeFileSync(path.join(cwd, ".pi", "characters", "owner.md"), "owner card");
	fs.writeFileSync(path.join(cwd, ".pi", "peer.json"), JSON.stringify(config));
	const root = path.join(cwd, "peers");
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>();
	const tools = new Map<string, any>();
	const entries: any[] = [];
	const calls: string[] = [];
	const notes: string[] = [];
	let pickNext: string | undefined;
	const ctx = {
		isIdle: () => true,
		cwd,
		hasUI: true,
		model: { provider: "original", id: "model" },
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
		sessionManager: { getEntries: () => entries, getSessionFile: (): string | undefined => undefined },
		ui: {
			notify: (text: string) => notes.push(text),
			setStatus: () => {},
			theme: { fg: (_: string, text: string) => text },
			select: async () => pickNext,
		},
	};
	const pi = {
		on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: (name: string, def: any) => commands.set(name, def),
		registerMessageRenderer: () => {},
		events: { on: () => () => {}, emit: () => {} },
		getSessionName: () => "test",
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		setModel: async (model: { provider: string; id: string }) => {
			calls.push(`model:${model.provider}/${model.id}`);
			ctx.model = model;
			return true;
		},
		setThinkingLevel: (level: string) => calls.push(`thinking:${level}`),
	};
	process.chdir(cwd);
	process.env.PI_PEER_ROOT = root;
	delete process.env.PI_PEER_ROLE;
	extension(pi as any);
	return {
		cwd,
		root,
		handlers,
		commands,
		tools,
		entries,
		calls,
		notes,
		ctx,
		pi,
		setPick: (v: string | undefined) => {
			pickNext = v;
		},
	};
}

function member(root: string, cwd: string) {
	return new PeerStore(root, cwd).listMembers()[0];
}

test("远程新会话保留已分配角色，不被原启动环境角色覆盖", async () => {
	const h = harness({});
	try {
		process.env.PI_PEER_ROLE = "dev";
		h.entries.push(
			{ type: "custom", customType: "peer-role", data: { role: "reviewer", name: "reviewer" } },
			{ type: "custom", customType: SESSION_TASK_ENTRY, data: { requestId: "synthetic" } },
		);
		await h.handlers.get("session_start")!({}, h.ctx);
		assert.equal(member(h.root, h.cwd).role, "reviewer");
		assert.equal(member(h.root, h.cwd).newSessionVersion, 1);
		assert.equal(member(h.root, h.cwd).busy, false);
	} finally {
		h.handlers.get("session_shutdown")?.();
		delete process.env.PI_PEER_ROLE;
	}
});

test("实际扩展的新会话权限默认拒绝，已声明权限及 group 覆盖每次重读", async () => {
	const h = harness({ roles: { owner: { canStartSessions: true } } });
	try {
		h.entries.push({ type: "custom", customType: "peer-role", data: { role: "owner" } });
		await h.handlers.get("session_start")!({}, h.ctx);
		const call = () => h.tools.get("peer_new_session").execute("synthetic", { to: "nonexistent", task: "synthetic" });
		await assert.rejects(call, /目标不在线/);
		fs.writeFileSync(
			path.join(h.cwd, ".pi", "peer.json"),
			JSON.stringify({
				roles: { owner: { canStartSessions: true } },
				group: { roles: { owner: { canStartSessions: false } } },
			}),
		);
		await assert.rejects(call, /没有 canStartSessions/);
		fs.writeFileSync(path.join(h.cwd, ".pi", "peer.json"), "{}");
		await assert.rejects(call, /没有 canStartSessions/);
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("会话 cwd 与工厂 cwd 不同，权限只读取实际会话项目", async () => {
	const h = harness({ roles: { owner: { canStartSessions: true } } });
	try {
		const actual = path.join(h.cwd, "session-project");
		fs.mkdirSync(path.join(actual, ".pi", "characters"), { recursive: true });
		fs.writeFileSync(path.join(actual, ".pi", "characters", "owner.md"), "synthetic owner");
		h.ctx.cwd = actual;
		h.entries.push({ type: "custom", customType: "peer-role", data: { role: "owner" } });
		await h.handlers.get("session_start")!({}, h.ctx);
		const call = () => h.tools.get("peer_new_session").execute("synthetic", { to: "nonexistent", task: "synthetic" });
		await assert.rejects(call, /没有 canStartSessions/);
		fs.writeFileSync(
			path.join(actual, ".pi", "peer.json"),
			JSON.stringify({ roles: { owner: { canStartSessions: true } } }),
		);
		await assert.rejects(call, /目标不在线/);
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("角色选择对话框未结束时拒绝远程新会话，不把模型空闲误作命令空闲", async () => {
	const h = harness({ roles: { owner: { canStartSessions: true } } });
	let release: ((value: string | undefined) => void) | undefined;
	let selecting: Promise<void> | void;
	try {
		h.ctx.sessionManager.getSessionFile = () => path.join(h.cwd, "synthetic-ui-session.jsonl");
		h.entries.push({ type: "custom", customType: "peer-role", data: { role: "dev" } });
		await h.handlers.get("session_start")!({}, h.ctx);
		h.ctx.ui.select = () =>
			new Promise<string | undefined>((resolve) => {
				release = resolve;
			});
		selecting = h.commands.get("peer-role")!.handler("", h.ctx);
		const store = new PeerStore(h.root, h.cwd),
			me = member(h.root, h.cwd),
			now = Date.now();
		store.register({
			key: "owner-other",
			name: "owner",
			role: "owner",
			cwd: h.cwd,
			pid: process.pid,
			model: "synthetic/model",
			startedAt: now,
			lastSeen: now,
		});
		store.send({
			id: "synthetic-reset",
			from: "owner-other",
			fromName: "owner",
			to: me.key,
			text: "synthetic",
			ts: now,
			control: {
				kind: "new-session",
				expectedKey: me.key,
				expectedEpoch: me.newSessionEpoch!,
				expectedRole: me.role,
				expectedName: me.name,
				task: "synthetic",
				expiresAt: now + 8000,
			},
		});
		let ack: PeerMessage | undefined;
		const end = Date.now() + 1500;
		while (Date.now() < end && !ack) {
			await delay(40);
			ack = store.drain("owner-other")[0];
		}
		if (ack?.control?.kind !== "new-session-result") assert.fail("没有目标拒绝确认");
		assert.equal(ack.control.phase, "not-created");
		assert.match(ack.control.detail, /目标不空闲/);
	} finally {
		release?.(undefined);
		await selecting;
		h.handlers.get("session_shutdown")?.();
	}
});

test("中途领角色：换卡、认领槽位、应用默认模型，重启沿用", async () => {
	const h = harness({ roles: { dev: { model: "target/org/model", thinkingLevel: "high" } } });
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		assert.equal(member(h.root, h.cwd).role, undefined);

		await h.commands.get("peer-role")!.handler("dev", h.ctx);
		const m = member(h.root, h.cwd);
		assert.equal(m.role, "dev");
		assert.equal(m.name, "dev");
		assert.equal(m.model, "target/org/model");
		assert.deepEqual(h.calls, ["model:target/org/model", "thinking:high"]);
		assert.ok(h.entries.some((e) => e.customType === "peer-role" && e.data.role === "dev" && e.data.name === "dev"));

		// 角色卡进 system prompt（下一轮生效）
		const sections: Record<string, string> = {};
		h.handlers.get("before_agent_start")!({ systemPromptOptions: { sections } }, h.ctx);
		assert.match(sections.peer_role ?? "", /dev card/);

		// 无参：报当前角色，弹列表；Esc 取消不动现状
		const before = h.notes.length;
		h.setPick(undefined);
		await h.commands.get("peer-role")!.handler("", h.ctx);
		assert.match(h.notes.slice(before).join("\n"), /当前角色：dev/);
		assert.equal(member(h.root, h.cwd).name, "dev");

		// 重启恢复：条目里的角色沿用，且默认值不重复应用
		h.calls.length = 0;
		await h.handlers.get("session_start")!({}, h.ctx);
		assert.equal(member(h.root, h.cwd).role, "dev");
		assert.deepEqual(h.calls, []);
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("中途换角色：释放旧槽位再认领新槽位", async () => {
	const h = harness({});
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.commands.get("peer-role")!.handler("dev", h.ctx);
		assert.equal(member(h.root, h.cwd).name, "dev");

		await h.commands.get("peer-role")!.handler("reviewer", h.ctx);
		const m = member(h.root, h.cwd);
		assert.equal(m.role, "reviewer");
		assert.equal(m.name, "reviewer");

		const sections: Record<string, string> = {};
		h.handlers.get("before_agent_start")!({ systemPromptOptions: { sections } }, h.ctx);
		assert.match(sections.peer_role ?? "", /reviewer card/);

		// 旧槽位已释放：同目录另一个会话能拿到 dev
		const other = fs.mkdtempSync(path.join(os.tmpdir(), "peer-role-other-"));
		const store2 = new PeerStore(h.root, other);
		assert.equal(store2.claimRoleName("dev", "other-key", process.pid), "dev");
		store2.releaseRoleName("dev", "dev", "other-key");
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("none 取消角色：摘卡、释放槽位，重启后不再恢复角色", async () => {
	const h = harness({});
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.commands.get("peer-role")!.handler("dev", h.ctx);
		await h.commands.get("peer-role")!.handler("none", h.ctx);

		const m = member(h.root, h.cwd);
		assert.equal(m.role, undefined);
		assert.equal(m.name, "test");
		const sections: Record<string, string> = {};
		h.handlers.get("before_agent_start")!({ systemPromptOptions: { sections } }, h.ctx);
		assert.equal(sections.peer_role, undefined);

		// 空串标记让重启后的 restoreRole 判为「取消过」
		await h.handlers.get("session_start")!({}, h.ctx);
		assert.equal(member(h.root, h.cwd).role, undefined);
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("不带参弹列表选：选中即切换，选取消项即摘卡", async () => {
	const h = harness({});
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		// 当前是普通会话：列表里所有角色都不带「（当前）」标记
		h.setPick("dev");
		await h.commands.get("peer-role")!.handler("", h.ctx);
		assert.equal(member(h.root, h.cwd).role, "dev");

		// 已有角色时当前项带标记，选它幂等
		h.setPick("dev（当前）");
		await h.commands.get("peer-role")!.handler("", h.ctx);
		assert.match(h.notes.join("\n"), /已是角色 dev/);

		// 选「－ 取消角色」摘卡释放槽位
		h.setPick("－ 取消角色");
		await h.commands.get("peer-role")!.handler("", h.ctx);
		const m = member(h.root, h.cwd);
		assert.equal(m.role, undefined);
		const sections: Record<string, string> = {};
		h.handlers.get("before_agent_start")!({ systemPromptOptions: { sections } }, h.ctx);
		assert.equal(sections.peer_role, undefined);
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});

test("非法角色名与缺失角色卡：拒绝且不改动现状", async () => {
	const h = harness({});
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.commands.get("peer-role")!.handler("1bad", h.ctx);
		await h.commands.get("peer-role")!.handler("ghost", h.ctx);
		const m = member(h.root, h.cwd);
		assert.equal(m.role, undefined);
		assert.equal(m.name, "test");
		assert.match(h.notes.join("\n"), /找不到角色 ghost 的角色卡/);
	} finally {
		h.handlers.get("session_shutdown")?.();
	}
});
