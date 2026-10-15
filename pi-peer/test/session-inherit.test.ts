import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import extension, { seedSessionEntries } from "../index.ts";
import { PeerStore } from "../store.ts";

/** 捕获 newSession 的 setup 写进新会话的条目，模拟创建方与新会话之间只靠会话文件交接 */
function harness(config: object) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "peer-inherit-"));
	fs.mkdirSync(path.join(cwd, ".pi", "characters"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "characters", "dev.md"), "dev card");
	fs.writeFileSync(path.join(cwd, ".pi", "characters", "reviewer.md"), "reviewer card");
	fs.writeFileSync(path.join(cwd, ".pi", "peer.json"), JSON.stringify(config));
	const root = path.join(cwd, "peers");
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>();
	const entries: any[] = [];
	const seeded: any[] = [];
	const calls: string[] = [];
	const notes: string[] = [];
	const ui = {
		notify: (text: string) => notes.push(text),
		setStatus: () => {},
		theme: { fg: (_: string, text: string) => text },
		select: async () => undefined,
	};
	// 宿主在会话替换开始时就废掉旧 ctx，之后的任何访问都会抛错；只有真正替换才失效，取消不算
	let stale = false;
	let cancelNext = false;
	const base: any = {
		cwd,
		hasUI: true,
		isIdle: () => true,
		model: { provider: "original", id: "model" },
		thinkingLevel: "low",
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
		sessionManager: { getEntries: () => entries, getSessionFile: () => path.join(cwd, "session.jsonl") },
		ui,
		async newSession(options: any) {
			if (cancelNext) {
				cancelNext = false;
				return { cancelled: true };
			}
			// 宿主顺序：先拆旧会话（session_shutdown，此刻旧 ctx 仍有效），再废掉旧 ctx，然后才跑 setup
			await handlers.get("session_shutdown")?.();
			stale = true;
			const collected: any[] = [];
			await options.setup?.({
				appendCustomEntry: (customType: string, data?: unknown) =>
					collected.push({ type: "custom", customType, data }),
			});
			seeded.splice(0, seeded.length, ...collected);
			await options.withSession?.({ hasUI: true, ui });
			return { cancelled: false };
		},
	};
	const ctx: any = new Proxy(base, {
		get(target, prop) {
			if (stale) throw new Error("旧上下文已失效");
			return Reflect.get(target, prop);
		},
		set(target, prop, value) {
			if (stale) throw new Error("旧上下文已失效");
			return Reflect.set(target, prop, value);
		},
	});
	const pi = {
		on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
		registerTool: () => {},
		registerCommand: (name: string, def: { handler: (args: string, ctx: any) => Promise<void> | void }) =>
			commands.set(name, def),
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
	const oldCwd = process.cwd();
	const oldRoot = process.env.PI_PEER_ROOT;
	process.chdir(cwd);
	process.env.PI_PEER_ROOT = root;
	delete process.env.PI_PEER_ROLE;
	extension(pi as any);
	return {
		cwd,
		root,
		handlers,
		commands,
		entries,
		seeded,
		calls,
		notes,
		ctx,
		/** 下一次新建会话被宿主取消 */
		cancelNextSession: () => {
			cancelNext = true;
		},
		member: () => new PeerStore(root, cwd).listMembers()[0],
		/** 切到另一个会话：旧会话已被 newSession 拆掉，条目换成新会话已有的那些 */
		switchTo: (next: any[]) => {
			entries.splice(0, entries.length, ...next);
			calls.length = 0;
			stale = false;
		},
		close: () => {
			stale = false;
			handlers.get("session_shutdown")?.();
			process.chdir(oldCwd);
			if (oldRoot === undefined) delete process.env.PI_PEER_ROOT;
			else process.env.PI_PEER_ROOT = oldRoot;
		},
	};
}

const written = (list: any[]) => list.map((entry) => [entry.customType, entry.data]);

test("初始条目只写有值的部分", () => {
	const seen: any[] = [];
	const manager = { appendCustomEntry: (customType: string, data?: unknown) => seen.push({ customType, data }) };
	seedSessionEntries(manager, { role: "dev", name: "dev-2", model: "manual/picked", thinkingLevel: "xhigh" });
	assert.deepEqual(written(seen), [
		["peer-role", { role: "dev", name: "dev-2" }],
		["peer-name", { name: "dev-2" }],
		["peer-inherit", { model: "manual/picked", thinkingLevel: "xhigh" }],
	]);
	seen.length = 0;
	seedSessionEntries(manager, { role: "dev" });
	assert.deepEqual(written(seen), [["peer-role", { role: "dev" }]]);
	seen.length = 0;
	seedSessionEntries(manager, { thinkingLevel: "max" });
	assert.deepEqual(written(seen), [["peer-inherit", { thinkingLevel: "max" }]]);
	seen.length = 0;
	seedSessionEntries(manager, {});
	assert.deepEqual(written(seen), []);
});

test("/peer-reload 继承当前角色、名字与模型，压过角色配置的默认值", async () => {
	const h = harness({ roles: { dev: { model: "role/default", thinkingLevel: "medium" } } });
	try {
		h.entries.push({ type: "custom", customType: "peer-role", data: { role: "dev" } });
		await h.handlers.get("session_start")!({}, h.ctx);
		assert.deepEqual(h.calls, ["model:role/default", "thinking:medium"]);

		// 角色默认值应用之后手动换了模型与思考等级
		h.calls.length = 0;
		h.ctx.model = { provider: "manual", id: "picked" };
		h.ctx.thinkingLevel = "xhigh";
		await h.commands.get("peer-reload")!.handler("", h.ctx);
		assert.deepEqual(written(h.seeded), [
			["peer-role", { role: "dev", name: "dev" }],
			["peer-name", { name: "dev" }],
			["peer-inherit", { model: "manual/picked", thinkingLevel: "xhigh" }],
		]);

		// 新会话：只有继承下来的条目可看，模型按继承项而不是角色配置
		h.switchTo(h.seeded);
		h.ctx.model = { provider: "host", id: "default" };
		h.ctx.thinkingLevel = "off";
		await h.handlers.get("session_start")!({}, h.ctx);
		assert.deepEqual(h.calls, ["model:manual/picked", "thinking:xhigh"]);
		const member = h.member();
		assert.equal(member.role, "dev");
		assert.equal(member.name, "dev");
		assert.equal(member.model, "manual/picked");

		// 恢复会话不重复应用继承项
		h.calls.length = 0;
		await h.handlers.get("session_start")!({}, h.ctx);
		assert.deepEqual(h.calls, []);
	} finally {
		h.close();
	}
});

test("/peer-reload 在普通会话上只继承名字与模型", async () => {
	const h = harness({ roles: { dev: { model: "role/default" } } });
	try {
		h.ctx.model = { provider: "manual", id: "picked" };
		h.ctx.thinkingLevel = "high";
		await h.handlers.get("session_start")!({}, h.ctx);
		assert.deepEqual(h.calls, []);
		await h.commands.get("peer-reload")!.handler("", h.ctx);
		assert.deepEqual(written(h.seeded), [
			["peer-name", { name: "test" }],
			["peer-inherit", { model: "manual/picked", thinkingLevel: "high" }],
		]);

		h.switchTo(h.seeded);
		h.ctx.model = { provider: "host", id: "default" };
		await h.handlers.get("session_start")!({}, h.ctx);
		assert.deepEqual(h.calls, ["model:manual/picked", "thinking:high"]);
		const member = h.member();
		assert.equal(member.role, undefined);
		assert.equal(member.name, "test");
	} finally {
		h.close();
	}
});

test("/peer-new 换角色按目标角色的配置，同名角色保持当前模型", async () => {
	const h = harness({ roles: { reviewer: { model: "role/review", thinkingLevel: "medium" } } });
	try {
		h.ctx.model = { provider: "manual", id: "picked" };
		h.ctx.thinkingLevel = "xhigh";
		await h.handlers.get("session_start")!({}, h.ctx);

		// 换角色：不写继承项，模型由新角色的配置决定
		await h.commands.get("peer-new")!.handler("--role reviewer", h.ctx);
		assert.deepEqual(written(h.seeded), [["peer-role", { role: "reviewer" }]]);
		h.switchTo(h.seeded);
		h.ctx.model = { provider: "host", id: "default" };
		await h.handlers.get("session_start")!({}, h.ctx);
		assert.deepEqual(h.calls, ["model:role/review", "thinking:medium"]);

		// 同名角色：保持当前模型
		h.calls.length = 0;
		h.ctx.model = { provider: "manual", id: "second" };
		h.ctx.thinkingLevel = "high";
		await h.commands.get("peer-new")!.handler("--role reviewer", h.ctx);
		assert.deepEqual(written(h.seeded), [
			["peer-role", { role: "reviewer" }],
			["peer-inherit", { model: "manual/second", thinkingLevel: "high" }],
		]);
	} finally {
		h.close();
	}
});

test("/peer-reload 被宿主取消：不写条目，旧上下文仍能提示", async () => {
	const h = harness({});
	try {
		await h.handlers.get("session_start")!({}, h.ctx);
		h.cancelNextSession();
		await h.commands.get("peer-reload")!.handler("", h.ctx);
		assert.deepEqual(h.seeded, []);
		assert.match(h.notes.join("\n"), /新建会话被取消/);
	} finally {
		h.close();
	}
});

test("/peer-reload 不接受参数", async () => {
	const h = harness({});
	try {
		h.ctx.model = undefined;
		await h.handlers.get("session_start")!({}, h.ctx);
		await h.commands.get("peer-reload")!.handler("dev", h.ctx);
		assert.deepEqual(h.seeded, []);
		assert.match(h.notes.join("\n"), /用法：\/peer-reload/);
	} finally {
		h.close();
	}
});
