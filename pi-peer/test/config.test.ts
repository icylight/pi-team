import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	configWarnings,
	describeConfig,
	discoverRoles,
	loadProjectConfig,
	renderConfigReport,
	resolveFlow,
	resolveRoleCard,
} from "../config.ts";

/**
 * 配置来源：文件里写了什么、哪些字段生效、哪些走了兜底。
 *
 * 这一组的判据是「每个生效项都带来源」：declared / fallback / absent 三选一，
 * 报告能逐项回答，会话提示只在「兜底真生效」或「文件本身有问题」时出声。
 */

function project(files: Record<string, string | object> = {}) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "peer-config-"));
	const cwd = path.join(base, "example-project");
	fs.mkdirSync(cwd, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const file = path.join(cwd, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
	}
	return { cwd, file: path.join(cwd, ".pi", "peer.json") };
}

function load(cwd: string) {
	return loadProjectConfig(path.join(cwd, ".pi", "peer.json"));
}

// ── 读取与字段校验 ──────────────────────────────────

test("没有配置文件：state=missing，不报问题", () => {
	const { cwd, file } = project();
	const loaded = load(cwd);
	assert.equal(loaded.state, "missing");
	assert.deepEqual(loaded.problems, []);
	assert.deepEqual(loaded.config, {});
	assert.equal(file, path.join(cwd, ".pi", "peer.json"));
});

test("正常配置：读到的字段进 config，别的顶层键单独列出来", () => {
	const { cwd } = project({
		".pi/peer.json": {
			enabled: true,
			group: { name: "ipd", flow: ".pi/flows/ipd.md", roles: { owner: { card: ".pi/characters/owner.md" } } },
			workOrders: { followRole: "owner" },
		},
	});
	const loaded = load(cwd);
	assert.equal(loaded.state, "loaded");
	assert.deepEqual(loaded.problems, []);
	assert.equal(loaded.config.enabled, true);
	assert.equal(loaded.config.group?.name, "ipd");
	assert.equal(loaded.config.group?.roles?.owner?.card, ".pi/characters/owner.md");
	// pi-peer 不认识 workOrders，但不能让它看起来像没读到
	assert.deepEqual(loaded.foreignKeys, ["workOrders"]);
});

test("角色表字符串简写也收", () => {
	const { cwd } = project({ ".pi/peer.json": { roles: { dev: ".pi/characters/dev.md" } } });
	assert.equal(load(cwd).config.roles?.dev?.card, ".pi/characters/dev.md");
});

test("字段写错：一处一条，写错的字段不让它生效，别的字段照读", () => {
	const { cwd } = project({
		".pi/peer.json": {
			enabled: "yes",
			group: { name: 7, roles: { owner: 42 } },
			flow: { path: "x" },
			roles: "dev",
		},
	});
	const loaded = load(cwd);
	assert.equal(loaded.state, "loaded");
	assert.equal(loaded.config.enabled, undefined, "写错不改开关");
	assert.equal(loaded.config.group?.name, undefined);
	assert.equal(loaded.config.group?.roles, undefined);
	assert.equal(loaded.config.flow, undefined);
	assert.equal(loaded.config.roles, undefined);
	const all = loaded.problems.join("\n");
	for (const expected of ["enabled", "group.name", "group.roles.owner", "flow", "roles"]) {
		assert.match(all, new RegExp(expected), `该报出 ${expected} 写错：\n${all}`);
	}
});

test("整份解析不了：state=broken，一个字段都不生效", () => {
	const { cwd } = project({ ".pi/peer.json": "{ enabled: true }" });
	const loaded = load(cwd);
	assert.equal(loaded.state, "broken");
	assert.deepEqual(loaded.config, {});
	assert.equal(loaded.problems.length, 1);
	assert.match(loaded.problems[0], /JSON 解析失败/);
});

test("顶层不是对象：也算 broken", () => {
	const { cwd } = project({ ".pi/peer.json": "[1, 2]" });
	assert.equal(load(cwd).state, "broken");
});

// ── 单项来源 ────────────────────────────────────────

test("角色卡：声明了就是 declared，没声明按 characters/ 命中算 fallback", () => {
	const { cwd } = project({
		".pi/peer.json": { roles: { owner: ".pi/characters/owner.md" } },
		".pi/characters/owner.md": "我是 owner",
		".pi/characters/qa.md": "我是 qa",
	});
	const loaded = load(cwd);

	const declared = resolveRoleCard(cwd, loaded.config, "owner");
	assert.equal(declared.origin.kind, "declared");
	assert.equal(declared.path, path.join(cwd, ".pi/characters/owner.md"));

	const fallback = resolveRoleCard(cwd, loaded.config, "qa");
	assert.equal(fallback.origin.kind, "fallback");
	assert.match(fallback.origin.detail, /没声明 qa/);

	const absent = resolveRoleCard(cwd, loaded.config, "nope");
	assert.equal(absent.origin.kind, "absent");
	assert.equal(absent.path, undefined);
});

test("角色卡：声明了但文件不在，报的是声明的路径、不是兜底路径", () => {
	const { cwd } = project({ ".pi/peer.json": { roles: { owner: ".pi/cards/owner.md" } } });
	const card = resolveRoleCard(cwd, load(cwd).config, "owner");
	assert.equal(card.origin.kind, "absent");
	assert.match(card.origin.detail, /配置指定/);
});

test("流程文档：声明走声明，没声明按 group.name 找，都没有退到 flow.md", () => {
	const withName = project({ ".pi/peer.json": { group: { name: "ipd" } } });
	const byName = resolveFlow(withName.cwd, load(withName.cwd).config);
	assert.equal(byName.origin.kind, "fallback");
	assert.equal(byName.path, path.join(withName.cwd, ".pi", "flows", "ipd.md"));

	const bare = project();
	assert.equal(resolveFlow(bare.cwd, {}).path, path.join(bare.cwd, ".pi", "flow.md"));

	const declared = project({ ".pi/peer.json": { group: { flow: "docs/flow.md" } } });
	const byConfig = resolveFlow(declared.cwd, load(declared.cwd).config);
	assert.equal(byConfig.origin.kind, "declared");
	assert.equal(byConfig.path, path.join(declared.cwd, "docs", "flow.md"));
});

// ── 报告 ────────────────────────────────────────────

test("报告逐项写出来源：项目标签、可用角色、本次角色卡、流程文档", () => {
	const { cwd } = project({
		".pi/characters/owner.md": "我是 owner",
		".pi/characters/qa.md": "我是 qa",
	});
	const loaded = load(cwd);
	const report = describeConfig(loaded, { cwd, role: "owner" });
	const byKey = Object.fromEntries(report.items.map((item) => [item.key, item]));

	assert.equal(byKey.identity.value, "example-project");
	assert.equal(byKey.identity.origin.kind, "fallback", "没写 group.name 就是兜底");
	assert.equal(byKey.roles.value, "owner、qa");
	assert.equal(byKey.roles.origin.kind, "fallback", "扫目录来的");
	assert.equal(byKey.role.origin.kind, "fallback");
	assert.equal(byKey.flow.origin.kind, "absent", "文件不在，连兜底都没命中");

	const text = renderConfigReport(report);
	assert.match(text, /项目配置：.*\.pi\/peer\.json（不存在（全部按兜底））/);
	assert.match(text, /项目标签：example-project ｜ 兜底：group.name 没写，按目录名/);
	assert.match(text, /角色卡（owner）：\.pi\/characters\/owner\.md ｜ 兜底：/);
});

test("声明齐全时，报告里每项都是「配置」来源，没有兜底字样", () => {
	const { cwd } = project({
		".pi/peer.json": {
			group: {
				name: "ipd",
				flow: ".pi/flows/ipd.md",
				roles: { owner: { card: ".pi/characters/owner.md", model: "test/model", thinkingLevel: "high" } },
			},
		},
		".pi/characters/owner.md": "我是 owner",
		".pi/flows/ipd.md": "流程在这里",
	});
	const report = describeConfig(load(cwd), { cwd, role: "owner" });
	assert.deepEqual(
		report.items.map((item) => `${item.key}:${item.origin.kind}`),
		[
			"identity:declared",
			"roles:declared",
			"role:declared",
			"model:declared",
			"thinkingLevel:declared",
			"flow:declared",
		],
	);
	assert.ok(!renderConfigReport(report).includes("兜底："));
});

// ── 会话提示 ────────────────────────────────────────

test("配置文件不在、也没用到角色与流程：不出声（项目标签兜底是常态）", () => {
	const { cwd } = project();
	const report = describeConfig(load(cwd), { cwd });
	assert.deepEqual(configWarnings(report), []);
});

test("配置文件不在、但角色卡按兜底命中：说出来（同事 clone 的场景）", () => {
	const { cwd } = project({ ".pi/characters/owner.md": "我是 owner" });
	const report = describeConfig(load(cwd), { cwd, role: "owner" });
	const warnings = configWarnings(report);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /按兜底生效：.*可用角色 owner/);
	assert.match(warnings[0], /角色卡（owner）/);
	assert.match(warnings[0], /\/peer-config/);
});

test("配置文件在但字段写错：当场报，不静默按默认值跑", () => {
	const { cwd } = project({ ".pi/peer.json": { group: { name: 7 } } });
	const warnings = configWarnings(describeConfig(load(cwd), { cwd }));
	assert.equal(warnings.length, 2, warnings.join(" / "));
	assert.match(warnings[0], /group\.name 要写字符串/);
	assert.match(
		warnings[1],
		/项目标签 example-project（group\.name 没写，按目录名）/,
		"写错了但没说的字段，按兜底生效就说兜底",
	);
});

test("配置文件在、声明齐全：不出声", () => {
	const { cwd } = project({
		".pi/peer.json": { group: { name: "ipd", roles: { owner: ".pi/characters/owner.md" } } },
		".pi/characters/owner.md": "我是 owner",
	});
	assert.deepEqual(configWarnings(describeConfig(load(cwd), { cwd, role: "owner" })), []);
});

test("配置文件在、group.name 没写：项目标签走兜底也要说，因为有人在配", () => {
	const { cwd } = project({ ".pi/peer.json": { enabled: true } });
	const warnings = configWarnings(describeConfig(load(cwd), { cwd }));
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /项目标签/);
});

test("整份读不了：直接说全按兜底", () => {
	const { cwd } = project({ ".pi/peer.json": "不是 JSON" });
	const warnings = configWarnings(describeConfig(load(cwd), { cwd, role: "owner" }));
	assert.match(warnings[0], /JSON 解析失败/);
});

test("扫目录得到的角色名与配置声明的分开：发现是兜底，声明是声明", () => {
	const { cwd } = project({
		".pi/peer.json": { roles: { owner: ".pi/characters/owner.md" } },
		".pi/characters/owner.md": "x",
		".pi/characters/qa.md": "y",
		".pi/characters/README": "不是角色卡",
	});
	assert.deepEqual(discoverRoles(cwd).sort(), ["owner", "qa"]);
	const report = describeConfig(load(cwd), { cwd });
	assert.equal(report.items.find((item) => item.key === "roles")?.origin.kind, "declared");
});
