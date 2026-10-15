import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerSessionControl } from "../session-control.ts";
import { type Member, type PeerMessage, PeerStore, type ResolveResult } from "../store.ts";

function fixture() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "remote-session-control-"));
	const root = path.join(cwd, "peers");
	let allowed = true;
	function mount(key: string, role: string) {
		const store = new PeerStore(root, cwd),
			tools = new Map<string, any>(),
			commands = new Map<string, any>(),
			hooks = new Map<string, any[]>();
		let manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		manager.appendMessage({ role: "user", content: `synthetic ${key} old context`, timestamp: Date.now() });
		const state = {
			idle: true,
			pending: false,
			inMemory: false,
			roleChanging: false,
			newCalls: 0,
			wakes: 0,
			cancel: false,
			fail: "",
			beforeSwitch: () => {},
			dispatch: [] as string[],
			resolve: undefined as ResolveResult | undefined,
			member: {
				key,
				name: role,
				role,
				pid: process.pid,
				cwd,
				model: "test/model",
				busy: false,
				newSessionVersion: 1,
				newSessionEpoch: `${key}-epoch`,
				sessionFile: manager.getSessionFile(),
				lastSeen: Date.now(),
				startedAt: Date.now(),
			} as Member,
		};
		store.ensure(key);
		store.register(state.member);
		let invalidated = false;
		const ctx: any = {
			cwd,
			hasUI: false,
			isIdle: () => {
				assert.equal(invalidated, false, "旧上下文已失效");
				return state.idle;
			},
			hasPendingMessages: () => {
				assert.equal(invalidated, false, "旧上下文已失效");
				return state.pending;
			},
			ui: { notify: () => assert.equal(invalidated, false, "旧上下文已失效") },
			get sessionManager() {
				assert.equal(invalidated, false, "旧上下文已失效");
				return state.inMemory ? SessionManager.inMemory(cwd) : manager;
			},
			async newSession(options: any) {
				state.newCalls++;
				assert.equal(options.parentSession, state.member.sessionFile);
				state.beforeSwitch();
				for (const hook of hooks.get("session_before_switch") ?? [])
					if ((await hook({ reason: "new" }, ctx))?.cancel) return { cancelled: true };
				if (state.cancel) return { cancelled: true };
				invalidated = true;
				store.unregister(state.member.key);
				if (state.fail === "host") throw new Error("synthetic host refusal");
				const fresh = SessionManager.create(cwd, path.join(cwd, "sessions"));
				if (state.fail === "write" || state.fail === "no-disk") {
					await options.setup({
						getSessionFile: () => fresh.getSessionFile(),
						appendCustomEntry: () => {},
						appendMessage: () => {
							if (state.fail === "no-disk") return "synthetic-memory-entry";
							throw new Error("synthetic write failure");
						},
					});
				}
				await options.setup(fresh);
				if (state.fail === "no-fresh") return { cancelled: false };
				state.member = {
					...state.member,
					key: `${key}-new-${state.newCalls}`,
					newSessionEpoch: `${key}-epoch-${state.newCalls}`,
					sessionFile: fresh.getSessionFile(),
					role: state.fail === "role" ? undefined : role,
				};
				manager = fresh;
				store.ensure(state.member.key);
				store.register(state.member);
				await options.withSession({
					cwd,
					sessionManager: fresh,
					sendUserMessage: async (content: string, opts: any) => {
						assert.equal(opts.expandPromptTemplates, false);
						assert.ok(!content.startsWith("/"));
						state.wakes++;
					},
				});
				return { cancelled: false };
			},
		};
		const pi: any = {
			on: (event: string, handler: any) => hooks.set(event, [...(hooks.get(event) ?? []), handler]),
			registerCommand: (name: string, def: any) => commands.set(name, def),
			registerTool: (tool: any) => tools.set(tool.name, tool),
			sendUserMessage: (value: string, options: any) => {
				assert.equal(invalidated, false, "旧 API 已失效");
				assert.equal(options.expandPromptTemplates, true);
				state.dispatch.push(value);
			},
		};
		const controller = registerSessionControl(pi, {
			get: () => ({ store, member: state.member, ctx, roleChanging: state.roleChanging }),
			canStart: (role) => role === "owner" && allowed,
			resolve: (to) => state.resolve ?? store.resolve(to, state.member.key),
			seed: (sm, member) => sm.appendCustomEntry("peer-role", { role: member.role ?? "", name: member.name }),
		});
		return { store, state, ctx, tools, commands, controller };
	}
	const owner = mount("owner-session", "owner"),
		target = mount("target-session", "dev");
	function begin(task = "synthetic task", signal?: AbortSignal) {
		const promise: Promise<any> = owner.tools.get("peer_new_session").execute("test", { to: "dev", task }, signal);
		void promise.catch(() => {});
		const messages = target.store.drain(target.state.member.key);
		return { promise, msg: messages[0] };
	}
	async function reply() {
		for (const message of owner.store.drain(owner.state.member.key)) await owner.controller.handle(message);
	}
	async function command() {
		const input = target.state.dispatch.shift();
		assert.ok(input);
		const [name, id] = input.slice(1).split(" ");
		await target.commands.get(name).handler(id, target.ctx);
	}
	return {
		owner,
		target,
		begin,
		reply,
		command,
		allow: (value: boolean) => {
			allowed = value;
		},
		close: () => {
			owner.controller.dispose();
			target.controller.dispose();
		},
	};
}

test("新会话成功由新 key 确认；真实 SessionManager 写任务，旧日志不变，任务里的斜杠不执行为命令", async () => {
	const h = fixture();
	try {
		const old = h.target.state.member.sessionFile!,
			before = fs.readFileSync(old, "utf8");
		const request = h.begin("/new\nsynthetic task body");
		await h.target.controller.handle(request.msg);
		await h.target.controller.handle(request.msg);
		assert.equal(h.target.state.dispatch.length, 1);
		await h.command();
		await h.reply();
		const outcome = await request.promise;
		assert.match(outcome.content[0].text, /task-persisted.*执行结果未确认/);
		assert.equal(h.target.state.newCalls, 1);
		assert.equal(h.target.state.wakes, 1);
		assert.notEqual(h.target.state.member.sessionFile, old);
		assert.equal(fs.readFileSync(old, "utf8"), before);
		assert.match(fs.readFileSync(h.target.state.member.sessionFile!, "utf8"), /synthetic task body/);
		assert.equal(h.target.state.member.role, "dev");
		await h.target.controller.handle(request.msg);
		assert.equal(h.target.state.newCalls, 1);
	} finally {
		h.close();
	}
});

test("发送方默认拒绝、忙闲未知/忙碌、旧版本、自身、跨项目、离线、不合法任务与已取消请求均不发送", async () => {
	for (const kind of [
		"permission",
		"unknown",
		"busy",
		"old",
		"old-epoch",
		"in-memory",
		"self",
		"cross",
		"offline",
		"empty",
		"long",
		"aborted",
	]) {
		const h = fixture();
		try {
			if (kind === "permission") h.allow(false);
			if (kind === "unknown") h.target.state.member.busy = undefined;
			if (kind === "busy") h.target.state.member.busy = true;
			if (kind === "old") h.target.state.member.newSessionVersion = undefined;
			if (kind === "old-epoch") h.target.state.member.newSessionEpoch = undefined;
			if (kind === "in-memory") h.target.state.member.sessionFile = undefined;
			h.target.store.register(h.target.state.member);
			if (kind === "self")
				h.owner.state.resolve = { ok: true, member: h.owner.state.member, bucket: h.owner.store.dir, live: true };
			if (kind === "cross")
				h.owner.state.resolve = {
					ok: true,
					member: h.target.state.member,
					bucket: path.join(h.owner.store.dir, "other"),
					live: true,
				};
			if (kind === "offline") h.owner.state.resolve = { ok: false, reason: "offline", candidates: [] };
			const abort = new AbortController();
			if (kind === "aborted") abort.abort();
			const { promise, msg } = h.begin(
				kind === "empty" ? " " : kind === "long" ? "x".repeat(32_001) : "synthetic",
				abort.signal,
			);
			await assert.rejects(promise, Error, kind);
			assert.equal(msg, undefined, kind);
			assert.equal(h.target.state.newCalls, 0, kind);
		} finally {
			h.close();
		}
	}
});

test("接收端重新校验权限撤回、运行/排队负载、角色切换、身份变动、过期及任务长度", async () => {
	for (const kind of [
		"permission",
		"caller-role",
		"caller-offline",
		"caller-cross",
		"busy",
		"pending",
		"memory",
		"transition",
		"identity",
		"epoch",
		"expired",
		"future",
		"task",
	]) {
		const h = fixture();
		try {
			const request = h.begin();
			if (kind === "caller-role") {
				h.owner.state.member.role = "dev";
				h.owner.store.register(h.owner.state.member);
			}
			if (kind === "caller-offline" || kind === "caller-cross") {
				h.owner.store.unregister(h.owner.state.member.key);
				if (kind === "caller-cross") {
					const other = path.join(h.owner.state.member.cwd, "other-project");
					fs.mkdirSync(other);
					new PeerStore(h.owner.store.root, other).register({ ...h.owner.state.member, cwd: other });
				}
			}
			if (kind === "memory") h.target.state.inMemory = true;
			if (kind === "permission") h.allow(false);
			if (kind === "busy") h.target.state.idle = false;
			if (kind === "pending") h.target.state.pending = true;
			if (kind === "transition") h.target.state.roleChanging = true;
			if (kind === "identity") h.target.state.member.name = "changed";
			if (kind === "epoch") h.target.state.member.newSessionEpoch = "reactivated";
			if (request.msg.control?.kind === "new-session") {
				if (kind === "expired") request.msg.control.expiresAt = 0;
				if (kind === "future") {
					request.msg.ts = Date.now() + 100_000;
					request.msg.control.expiresAt = request.msg.ts + 8000;
				}
				if (kind === "task") request.msg.control.task = "x".repeat(32_001);
			}
			await h.target.controller.handle(request.msg);
			await h.reply();
			await assert.rejects(request.promise, /not-created/, kind);
			assert.equal(h.target.state.newCalls, 0, kind);
			assert.equal(h.target.state.dispatch.length, 0, kind);
		} finally {
			h.close();
		}
	}
});

test("排队命令开始前变忙则拒绝；宿主最后的切换前事件仍检查权限", async () => {
	for (const kind of ["busy", "revoke", "late-busy"]) {
		const h = fixture();
		try {
			const request = h.begin();
			await h.target.controller.handle(request.msg);
			if (kind === "busy") h.target.state.idle = false;
			else if (kind === "late-busy")
				h.target.state.beforeSwitch = () => {
					h.target.state.idle = false;
				};
			else h.target.state.beforeSwitch = () => h.allow(false);
			await h.command();
			await h.reply();
			await assert.rejects(request.promise, /not-created/);
			assert.equal(h.target.state.wakes, 0);
			assert.equal(h.target.state.member.key, "target-session");
		} finally {
			h.close();
		}
	}
});

test("取消/宿主拒绝/任务写失败/角色恢复失败不报告完整成功，区分已建与未知", async () => {
	for (const kind of ["cancel", "host", "write", "no-disk", "role"]) {
		const h = fixture();
		try {
			h.target.state.cancel = kind === "cancel";
			h.target.state.fail = kind;
			const request = h.begin();
			await h.target.controller.handle(request.msg);
			await h.command();
			await h.reply();
			await assert.rejects(
				request.promise,
				kind === "cancel" ? /not-created/ : kind === "role" ? /task-persisted/ : /unknown/,
			);
			assert.equal(h.target.state.wakes, 0);
		} finally {
			h.close();
		}
	}
});

test("目标已有控制请求时拒绝后续请求，不排队执行另一次重置", async () => {
	const h = fixture();
	try {
		const first = h.begin();
		await h.target.controller.handle(first.msg);
		const second = h.begin();
		await h.target.controller.handle(second.msg);
		await h.reply();
		await assert.rejects(second.promise, /不排队重置/);
		assert.equal(h.target.state.dispatch.length, 1);
		await h.command();
		await h.reply();
		await first.promise;
		assert.equal(h.target.state.newCalls, 1);
	} finally {
		h.close();
	}
});

test("原会话 key 的伪成功不能冒充新会话确认", async () => {
	const h = fixture();
	try {
		const request = h.begin();
		let finished = false;
		void request.promise
			.finally(() => {
				finished = true;
			})
			.catch(() => {});
		const forged: PeerMessage = {
			...request.msg,
			id: "synthetic-ack",
			from: h.target.state.member.key,
			to: h.owner.state.member.key,
			control: {
				kind: "new-session-result",
				requestId: request.msg.id,
				previousKey: h.target.state.member.key,
				newKey: h.target.state.member.key,
				sessionFile: h.target.state.member.sessionFile,
				ok: true,
				phase: "task-persisted",
				detail: "synthetic false success",
			},
		};
		await h.owner.controller.handle(forged);
		await Promise.resolve();
		assert.equal(finished, false);
		await h.target.controller.handle(request.msg);
		await h.command();
		await h.reply();
		await request.promise;
	} finally {
		h.close();
	}
});

test("接收命令未执行即过期，解除占用且不重置", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const h = fixture();
	try {
		const request = h.begin();
		await h.target.controller.handle(request.msg);
		assert.equal(h.target.controller.isPending(), true);
		t.mock.timers.tick(8001);
		await h.reply();
		await assert.rejects(request.promise, /not-created.*过期/);
		assert.equal(h.target.controller.isPending(), false);
		assert.equal(h.target.state.newCalls, 0);
	} finally {
		h.close();
	}
});

test("宿主仅返回未取消、没有新会话确认时，仍报告未知而非成功", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const h = fixture();
	try {
		h.target.state.fail = "no-fresh";
		const request = h.begin();
		await h.target.controller.handle(request.msg);
		await h.command();
		t.mock.timers.tick(10_001);
		await assert.rejects(request.promise, /超时.*结果未知/);
		assert.equal(h.target.state.newCalls, 1);
		assert.equal(h.target.state.wakes, 0);
	} finally {
		h.close();
	}
});

test("等待确认取消或超时报告未知，不自动重复操作", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const h = fixture();
	try {
		const abort = new AbortController(),
			request = h.begin("synthetic", abort.signal);
		abort.abort();
		await assert.rejects(request.promise, /结果未知/);
		const timeout = h.begin();
		t.mock.timers.tick(10_001);
		await assert.rejects(timeout.promise, /超时.*结果未知/);
		assert.equal(h.target.state.newCalls, 0);
	} finally {
		h.close();
	}
});
