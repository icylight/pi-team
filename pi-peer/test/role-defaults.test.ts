import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { describeConfig, loadProjectConfig, THINKING_LEVELS } from "../config.ts";
import extension from "../index.ts";
import { PeerStore } from "../store.ts";

function project(config: object) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "peer-defaults-"));
	fs.mkdirSync(path.join(cwd, ".pi", "characters"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".pi", "characters", "dev.md"), "dev");
	const file = path.join(cwd, ".pi", "peer.json");
	fs.writeFileSync(file, JSON.stringify(config));
	return { cwd, file };
}

test("角色默认配置逐字段验证，保留模型 ID 中的斜杠，支持全部思考等级", () => {
	for (const thinkingLevel of THINKING_LEVELS) {
		const { file } = project({ roles: { dev: { model: "openrouter/org/model", thinkingLevel } } });
		const loaded = loadProjectConfig(file);
		assert.deepEqual(loaded.problems, []);
		assert.equal(loaded.config.roles?.dev?.thinkingLevel, thinkingLevel);
		assert.equal(loaded.config.roles?.dev?.model, "openrouter/org/model");
	}
	const { file } = project({ roles: { dev: { card: "x.md", model: "missing-provider", thinkingLevel: "huge" } } });
	const loaded = loadProjectConfig(file);
	assert.deepEqual(loaded.config.roles?.dev, { card: "x.md" });
	assert.equal(loaded.problems.length, 2);
	assert.match(loaded.problems.join("\n"), /roles.dev.model/);
	assert.match(loaded.problems.join("\n"), /roles.dev.thinkingLevel/);
});

for (const scenario of [
	"success",
	"unknown",
	"unauthorized",
	"throw",
	"thinking-only",
	"model-only",
	"unconfigured",
	"missing-card",
	"ordinary",
] as const) {
	test(`角色默认设置生命周期：${scenario}`, async () => {
		const modelDefault =
			scenario === "thinking-only" || scenario === "unconfigured" ? {} : { model: "target/org/model" };
		const thinkingDefault = scenario === "model-only" || scenario === "unconfigured" ? {} : { thinkingLevel: "high" };
		const config = {
			roles: { dev: { ...modelDefault, ...thinkingDefault } },
			group: { roles: { dev: { ...(scenario === "missing-card" ? { card: "missing.md" } : {}) } } },
		};
		const { cwd, file } = project(config);
		const oldCwd = process.cwd();
		const oldRole = process.env.PI_PEER_ROLE;
		const oldRoot = process.env.PI_PEER_ROOT;
		process.chdir(cwd);
		if (scenario === "ordinary") delete process.env.PI_PEER_ROLE;
		else process.env.PI_PEER_ROLE = "dev";
		const root = path.join(cwd, "peers");
		process.env.PI_PEER_ROOT = root;
		const handlers = new Map<string, (...args: any[]) => any>();
		const entries: any[] = [];
		const calls: string[] = [];
		const notes: string[] = [];
		const ctx = {
			cwd,
			hasUI: true,
			model: { provider: "original", id: "model" },
			modelRegistry: {
				find: (provider: string, id: string) => (scenario === "unknown" ? undefined : { provider, id }),
			},
			sessionManager: { getEntries: () => entries, getSessionFile: () => undefined },
			ui: {
				notify: (text: string) => notes.push(text),
				setStatus: () => {},
				theme: { fg: (_: string, text: string) => text },
			},
		};
		const pi = {
			on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
			registerTool: () => {},
			registerCommand: () => {},
			registerMessageRenderer: () => {},
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "test",
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
			setModel: async (model: { provider: string; id: string }) => {
				calls.push(`model:${model.provider}/${model.id}`);
				if (scenario === "throw") throw new Error("failed");
				if (scenario !== "unauthorized") ctx.model = model;
				return scenario !== "unauthorized";
			},
			setThinkingLevel: (level: string) => calls.push(`thinking:${level}`),
		};
		try {
			extension(pi as any);
			await handlers.get("session_start")!({}, ctx);
			const failed = ["unknown", "unauthorized", "throw"].includes(scenario);
			const skipped = ["missing-card", "ordinary"].includes(scenario);
			if (failed) {
				assert.match(notes.join("\n"), /默认模型.*未应用/);
				assert.ok(!calls.includes("thinking:high"));
				assert.ok(!entries.some((e) => e.customType === "peer-role-defaults"));
			} else if (skipped) assert.deepEqual(calls, []);
			else {
				assert.deepEqual(calls, [
					...(modelDefault.model ? ["model:target/org/model"] : []),
					...(thinkingDefault.thinkingLevel ? ["thinking:high"] : []),
				]);
				const report = describeConfig(loadProjectConfig(file), { cwd, role: "dev" });
				if (modelDefault.model)
					assert.equal(report.items.find((i) => i.key === "model")?.origin.detail, "roles.dev.model");
				const count = calls.length;
				await handlers.get("session_start")!({}, ctx);
				assert.equal(calls.length, count, "恢复不重新应用默认值");
			}
			const store = new PeerStore(root, cwd);
			const members = store.listMembers();
			assert.equal(
				members[0].model,
				!failed && !skipped && modelDefault.model ? "target/org/model" : "original/model",
			);
			await handlers.get("model_select")!({ model: { provider: "manual", id: "new" } }, ctx);
			assert.equal(store.listMembers()[0].model, "manual/new");
		} finally {
			handlers.get("session_shutdown")?.();
			process.chdir(oldCwd);
			if (oldRole === undefined) delete process.env.PI_PEER_ROLE;
			else process.env.PI_PEER_ROLE = oldRole;
			if (oldRoot === undefined) delete process.env.PI_PEER_ROOT;
			else process.env.PI_PEER_ROOT = oldRoot;
		}
	});
}
