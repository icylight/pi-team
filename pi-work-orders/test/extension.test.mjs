import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import extension from "../index.ts";

/** 把扩展挂到一个假的 pi 上，收集它注册的工具与命令 */
function mount(sessionName = "dev", extra = {}) {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const channels = new Map();
	const pi = {
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, opts) => commands.set(name, opts),
		on: (name, fn) => handlers.set(name, fn),
		getSessionName: () => sessionName,
		sendUserMessage: (text) => extra.sent?.push(String(text)),
		// 事件总线的最小实现：只够验「投出去 / 收到回复」两条路径
		events: {
			emit: (channel, data) => {
				for (const fn of channels.get(channel) ?? []) fn(data);
			},
			on: (channel, fn) => {
				const list = channels.get(channel) ?? [];
				list.push(fn);
				channels.set(channel, list);
				return () =>
					channels.set(
						channel,
						(channels.get(channel) ?? []).filter((f) => f !== fn),
					);
			},
		},
	};
	// 假装 pi-peer 在场：身份一问就答
	if (extra.roleName !== undefined) {
		channels.set("peer:whoami", [
			(data) => pi.events.emit("peer:whoami:result", { id: data?.id, name: extra.roleName }),
		]);
	}
	extension(pi);
	return { tools, commands, handlers, channels, pi };
}

function ctxFor(cwd) {
	return {
		cwd,
		hasUI: false,
		ui: { notify: () => {} },
		isIdle: () => true,
	};
}

function tmpProject() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "orders-ext-"));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, timeout = 3000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (condition()) return;
		await sleep(30);
	}
	throw new Error("等到超时也没发生");
}

/** 项目配置：这个项目跟随哪个角色（写在 pi-peer 的项目配置里） */
function writeProjectConfig(cwd, value) {
	const file = path.join(cwd, ".pi", "peer.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

/** 交接默认不发：要验「投给下一步的人」的用例，先打开 workOrders.handoff */
function enableHandoff(cwd) {
	writeProjectConfig(cwd, { workOrders: { handoff: true } });
}

/** 把一条单的等待时刻推到阈值之外 */
function ageOrder(cwd, orderId, minutes) {
	const db = new DatabaseSync(path.join(cwd, ".work-orders", "work-orders.sqlite"));
	db.prepare("UPDATE events SET at = strftime('%Y-%m-%dT%H:%M:%fZ','now',?) WHERE order_id=?").run(
		`-${minutes} minutes`,
		orderId,
	);
	db.close();
}

async function call(tools, name, params, ctx) {
	const tool = tools.get(name);
	assert.ok(tool, `工具未注册：${name}`);
	const out = await tool.execute("call-1", params, undefined, undefined, ctx);
	return out.content.map((c) => c.text).join("\n");
}

test("工具层能锁内容：锁定后改正文被拒，解锁要单独一次调用", async () => {
	const cwd = tmpProject();
	const { tools } = mount();
	const ctx = ctxFor(cwd);
	assert.ok(tools.get("orders_update").parameters.properties.contentLock);
	await call(tools, "orders_init", {}, ctx);
	const created = await call(
		tools,
		"orders_create",
		{ title: "锁定演示", body: "原始口径", nextActors: ["dev"] },
		ctx,
	);
	const id = /^(T\d+)/.exec(created)?.[1];
	assert.ok(id, "建单应回报工单号");

	const locked = await call(tools, "orders_update", { id, reason: "口径定稿", contentLock: true }, ctx);
	assert.match(locked, /内容已锁定：dev 于 /);
	const listed = await call(tools, "orders_list", {}, ctx);
	assert.match(listed, /锁 {2}下一步找/, "列表有锁列");
	const row = listed.split("\n").find((line) => line.startsWith(id));
	assert.match(row ?? "", /锁/, "这一行在锁列标出已锁定");

	const refused = await call(tools, "orders_update", { id, reason: "想改", body: "新口径" }, ctx);
	assert.match(refused, /内容已锁定/);
	assert.doesNotMatch(refused, /新口径/, "被拒的改动不该出现在回显里");
	const shown = await call(tools, "orders_show", { id }, ctx);
	assert.match(shown, /原始口径/);

	const unlockAndEdit = await call(
		tools,
		"orders_update",
		{ id, reason: "需求变了", contentLock: false, body: "新口径" },
		ctx,
	);
	assert.match(unlockAndEdit, /解锁与改内容分两步/);
	await call(tools, "orders_update", { id, reason: "需求变了" }, ctx);
	await call(tools, "orders_update", { id, reason: "需求变了", contentLock: false }, ctx);
	const edited = await call(tools, "orders_update", { id, reason: "按新需求改", body: "新口径" }, ctx);
	assert.match(edited, /新口径/);
});

test("工具支持内容入口的建单、替换、清空与版本冲突", async () => {
	const cwd = tmpProject();
	const { tools } = mount();
	const ctx = ctxFor(cwd);
	assert.ok(tools.get("orders_create").parameters.properties.contents);
	assert.ok(tools.get("orders_update").parameters.properties.contents);
	await call(tools, "orders_init", {}, ctx);
	const created = await call(
		tools,
		"orders_create",
		{
			title: "横向内容",
			body: "摘要",
			nextActors: ["dev"],
			contents: [
				{ name: "需求", path: "docs/需求.md" },
				{ name: "方案", path: "docs/方案.md" },
			],
		},
		ctx,
	);
	assert.match(created, /内容入口：\n- 需求：docs\/需求.md\n- 方案：docs\/方案.md/);
	const changed = await call(
		tools,
		"orders_update",
		{
			id: "T01",
			reason: "补验证",
			expectedRevision: 1,
			contents: [{ name: "验证", path: "docs/验证.md" }],
		},
		ctx,
	);
	assert.match(changed, /- 验证：docs\/验证.md/);
	assert.doesNotMatch(changed, /- 需求：/);
	assert.match(changed, /rev 2/);
	const conflict = await call(
		tools,
		"orders_update",
		{
			id: "T01",
			reason: "旧版本",
			expectedRevision: 1,
			contents: [],
		},
		ctx,
	);
	assert.match(conflict, /失败：版本冲突/);
	const bad = await call(
		tools,
		"orders_update",
		{
			id: "T01",
			reason: "非法路径",
			expectedRevision: 2,
			contents: [{ name: "验证", path: "../outside.md" }],
			appendBody: "不能落库",
		},
		ctx,
	);
	assert.match(bad, /失败：.*项目内.*相对.*md/);
	const shown = await call(tools, "orders_show", { id: "T01" }, ctx);
	assert.match(shown, /- 验证：docs\/验证.md/);
	assert.doesNotMatch(shown, /不能落库/);
	assert.match(shown, /rev 2/);
	const clear = await call(
		tools,
		"orders_update",
		{
			id: "T01",
			reason: "清空入口",
			expectedRevision: 2,
			contents: [],
		},
		ctx,
	);
	assert.doesNotMatch(clear, /内容入口/);
	assert.match(clear, /rev 3/);
});

test("扩展注册工单工具、通知查询和 orders 命令", () => {
	const { tools, commands } = mount();
	assert.deepEqual([...tools.keys()].sort(), [
		"orders_comment",
		"orders_create",
		"orders_dep",
		"orders_init",
		"orders_list",
		"orders_notifications",
		"orders_requirement",
		"orders_show",
		"orders_update",
	]);
	assert.ok(commands.has("orders"));
	assert.equal(commands.size, 1);
});

test("工具链跑通：建库 → 建单 → 认领 → 交付 → 收口", async () => {
	const cwd = tmpProject();
	const { tools } = mount();
	const ctx = ctxFor(cwd);

	const init = await call(tools, "orders_init", { goal: "让商店助手给出建议", idPrefix: "S" }, ctx);
	assert.match(init, /工单库已建/);

	const created = await call(
		tools,
		"orders_create",
		{ title: "实现排序", nextActors: ["dev"], body: "目标：把候选商品排序" },
		ctx,
	);
	assert.match(created, /S01/);
	assert.match(created, /待认领/);

	// 未给 actor 时取会话名（dev）
	const claimed = await call(tools, "orders_update", { id: "S01", state: "在做", reason: "接了" }, ctx);
	assert.match(claimed, /在做/);

	const delivered = await call(
		tools,
		"orders_update",
		{ id: "S01", state: "待复核", nextActors: ["qa"], reason: "实现完成" },
		ctx,
	);
	assert.match(delivered, /待复核/);
	assert.match(delivered, /qa/);

	// 结单缺证据要失败
	const badClose = await call(tools, "orders_update", { id: "S01", state: "已收口", reason: "过了" }, ctx);
	assert.match(badClose, /失败：结单必须给终止依据/);

	const closed = await call(
		tools,
		"orders_update",
		{
			id: "S01",
			state: "已收口",
			closingBasis: "docs/validation/shop.md",
			reason: "复核通过",
		},
		ctx,
	);
	assert.match(closed, /已收口/);

	const list = await call(tools, "orders_list", { history: true }, ctx);
	assert.match(list, /S01/);
});

test("一个角色同时只能有一条在做（走工具也一样拦）", async () => {
	const cwd = tmpProject();
	const { tools } = mount();
	const ctx = ctxFor(cwd);
	await call(tools, "orders_init", {}, ctx);
	await call(tools, "orders_create", { title: "甲", nextActors: ["dev"] }, ctx);
	await call(tools, "orders_create", { title: "乙", nextActors: ["dev"] }, ctx);

	await call(tools, "orders_update", { id: "T01", state: "在做", reason: "接甲" }, ctx);
	const conflict = await call(tools, "orders_update", { id: "T02", state: "在做", reason: "接乙" }, ctx);
	assert.match(conflict, /失败：dev 已有在做的一条/);
});

test("依赖与 ready：上游没收口下游不开工", async () => {
	const cwd = tmpProject();
	const { tools } = mount();
	const ctx = ctxFor(cwd);
	await call(tools, "orders_init", {}, ctx);
	await call(tools, "orders_create", { title: "设计", nextActors: ["ux"] }, ctx);
	await call(tools, "orders_create", { title: "实现", nextActors: ["dev"], dependsOn: ["T01"] }, ctx);

	const ready = await call(tools, "orders_list", { ready: true }, ctx);
	assert.match(ready, /T01/);
	assert.ok(!/T02/.test(ready), "上游未收口时 T02 不该出现在可开工里");

	const show = await call(tools, "orders_show", { id: "T02" }, ctx);
	assert.match(show, /依赖：T01/);

	const cycle = await call(tools, "orders_dep", { id: "T01", dep: "T02", action: "add", reason: "试环" }, ctx);
	assert.match(cycle, /失败：加这条依赖会成环/);
});

test("orders_update：空串 body 不清正文，追加与字段补丁同一次事务", async () => {
	const cwd = tmpProject();
	const { tools } = mount();
	const ctx = ctxFor(cwd);
	await call(tools, "orders_init", {}, ctx);
	await call(tools, "orders_create", { title: "甲", nextActors: ["dev"], body: "## 目标\n做 A" }, ctx);

	// 缺陷 1：body 传空串曾被当成「清空正文」，还吞掉同一次调用里的追加
	const merged = await call(
		tools,
		"orders_update",
		{ id: "T01", state: "在做", body: "", appendBody: "## 范围修订\n改为 A+B", reason: "接单并改范围" },
		ctx,
	);
	assert.match(merged, /做 A/);
	assert.match(merged, /范围修订/);
	assert.match(merged, /在做/);
	assert.match(merged, /rev 2/);

	// 缺陷 2：字段那步会失败时，追加不能先落库
	await call(tools, "orders_update", { id: "T01", state: "待复核", nextActors: ["qa"], reason: "交付" }, ctx);
	const failed = await call(
		tools,
		"orders_update",
		{ id: "T01", state: "已收口", appendBody: "## 第二次追加", reason: "结单" },
		ctx,
	);
	assert.match(failed, /失败：结单必须给终止依据/);
	const show = await call(tools, "orders_show", { id: "T01" }, ctx);
	assert.ok(!/第二次追加/.test(show), "字段补丁失败时追加不该落库");
	assert.match(show, /rev 3/);
});

// ── 派工：写库后把「该你了」投出去 ──────────────────

/** 冒充 pi-peer：应答一次投递，并把收到的内容记下来 */
function fakePeer(channels, reply = { ok: true, to: "dev" }) {
	const got = [];
	channels.set("peer:deliver", [
		(data) => {
			got.push(data);
			channels.set("peer:deliver:result", channels.get("peer:deliver:result") ?? []);
			for (const fn of channels.get("peer:deliver:result") ?? []) fn({ id: data.id, ...reply });
		},
	]);
	return got;
}

test("建单后唤醒下一步的人，并把结果写在返回里", async () => {
	const cwd = tmpProject();
	const { tools, channels } = mount("owner");
	const ctx = ctxFor(cwd);
	const sent = fakePeer(channels);
	enableHandoff(cwd);
	await call(tools, "orders_init", {}, ctx);

	const out = await call(tools, "orders_create", { title: "实现排序", nextActors: ["dev", "qa"] }, ctx);
	assert.match(out, /sending：.*等待目标会话持久化确认/);
	assert.equal(sent.length, 1, "只投一次，候选列表交给 peer 挑在线的那个");
	assert.deepEqual(sent[0].targets, ["dev", "qa"]);
	assert.match(sent[0].text, /工单交接 T01/);
	assert.equal(sent[0].requireIdle, true, "交接只在目标空闲时注入");
	assert.equal(sent[0].priority, undefined, "不再带优先级：普通消息一律 steer");
	assert.equal(typeof sent[0].handoff.lease, "string");
});

test("peer 不在场时不算失败：库已落，返回里说明没唤到", async () => {
	const cwd = tmpProject();
	const { tools } = mount("owner");
	const ctx = ctxFor(cwd);
	await call(tools, "orders_init", {}, ctx);

	const out = await call(tools, "orders_create", { title: "实现排序", nextActors: ["dev"] }, ctx);
	assert.match(out, /待认领/, "建单本身照样成功");
	assert.ok(!/已通知/.test(out), "没有 peer 就不谎报通知");
});

test("派给自己不唤：认领与自派都跳过", async () => {
	const cwd = tmpProject();
	const { tools, channels } = mount("dev");
	const ctx = ctxFor(cwd);
	const sent = fakePeer(channels);
	await call(tools, "orders_init", {}, ctx);
	const created = await call(tools, "orders_create", { title: "自己干", nextActors: ["dev"] }, ctx);
	assert.equal(sent.length, 0, "建单时唯一的候选就是自己，不该投给自己");

	await call(tools, "orders_update", { id: "T01", state: "在做", reason: "接了" }, ctx);
	assert.equal(sent.length, 0, "认领也不发给自己");
	assert.ok(!/已通知/.test(created), "返回里也不谎报通知");
});

test("交付时唤醒复核人，收口时改为唤醒刚解锁的下游", async () => {
	const cwd = tmpProject();
	const { tools, channels } = mount("dev");
	const ctx = ctxFor(cwd);
	const sent = fakePeer(channels);
	enableHandoff(cwd);
	await call(tools, "orders_init", {}, ctx);
	await call(tools, "orders_create", { title: "实现", nextActors: ["dev"] }, ctx);
	await call(tools, "orders_create", { title: "验收", nextActors: ["qa"], dependsOn: ["T01"] }, ctx);

	await call(tools, "orders_update", { id: "T01", state: "在做", reason: "接了" }, ctx);
	await call(tools, "orders_update", { id: "T01", state: "待复核", nextActors: ["qa"], reason: "做完了" }, ctx);
	assert.match(sent.at(-1).text, /状态：待复核/);

	// 收口解锁下游 T02：这时该动的是 T02 的人，不是 T01 的复核人
	await call(tools, "orders_update", { id: "T01", state: "已收口", closingBasis: "a.md", reason: "过了" }, ctx);
	assert.match(sent.at(-1).text, /状态：待认领/);
	assert.match(sent.at(-1).text, /T02/);
});

// ── 会话启动注入：显式开 workOrders.digest 才有 ────────────────

test("没配 digest 时不注入摘要：有在等的单也不占上下文", async () => {
	const cwd = tmpProject();
	const { tools, handlers } = mount("qa");
	const ctx = ctxFor(cwd);
	await call(tools, "orders_init", {}, ctx);
	await call(tools, "orders_create", { title: "等 qa 复核", nextActors: ["qa"] }, ctx);

	const sections = {};
	handlers.get("before_agent_start")({ systemPromptOptions: { sections } }, ctx);
	assert.equal(sections.work_orders, undefined, "默认关：不配就不注入");
});

test("开 digest 后点出等自己的、停滞的、可开工没人接的", async () => {
	const cwd = tmpProject();
	const { tools, handlers } = mount("qa");
	const ctx = ctxFor(cwd);
	await call(tools, "orders_init", {}, ctx);
	await call(tools, "orders_create", { title: "等 qa 复核", nextActors: ["qa"], state: "待复核" }, ctx);
	await call(tools, "orders_create", { title: "等 dev 实现", nextActors: ["dev"] }, ctx);
	writeProjectConfig(cwd, { workOrders: { digest: true } });

	const sections = {};
	handlers.get("before_agent_start")({ systemPromptOptions: { sections } }, ctx);
	const text = sections.work_orders;
	assert.ok(text, "开了就该注入");
	assert.match(text, /等你的 1 条/);
	assert.match(text, /T01 待复核/);
	assert.match(text, /可开工还没人接：T02/, "刚建的单按「没人接」出现，不会立刻算停滞");
});

test("库没建时不报错", async () => {
	const emptyProject = tmpProject();
	const { handlers } = mount("qa");
	writeProjectConfig(emptyProject, { workOrders: { digest: true } });
	const sections = {};
	handlers.get("before_agent_start")({ systemPromptOptions: { sections } }, ctxFor(emptyProject));
	assert.equal(sections.work_orders, undefined, "库不存在时静默不注入");

	const cwd = tmpProject();
	const { tools, handlers: h2 } = mount("qa");
	writeProjectConfig(cwd, { workOrders: { digest: true } });
	await call(tools, "orders_init", {}, ctxFor(cwd));
	const sections2 = {};
	h2.get("before_agent_start")({ systemPromptOptions: { sections: sections2 } }, ctxFor(cwd));
	assert.equal(sections2.work_orders, undefined, "空台账不占上下文");
});

// ── 空结果与历史 ────────────────────────────────

test("orders_list 查已收口不再返回空，orders_show 带最近动作", async () => {
	const cwd = tmpProject();
	const { tools } = mount("dev");
	const ctx = ctxFor(cwd);
	await call(tools, "orders_init", {}, ctx);
	await call(tools, "orders_create", { title: "甲", nextActors: ["dev"] }, ctx);
	await call(tools, "orders_update", { id: "T01", state: "在做", reason: "接了" }, ctx);
	await call(tools, "orders_update", { id: "T01", state: "待复核", nextActors: ["qa"], reason: "做完" }, ctx);
	await call(tools, "orders_update", { id: "T01", state: "已收口", closingBasis: "a.md", reason: "过了" }, ctx);

	// 曾经的病灶：不带 history 时 state=已收口 恒空
	const closed = await call(tools, "orders_list", { state: "已收口" }, ctx);
	assert.match(closed, /T01/);

	const miss = await call(tools, "orders_list", { next: "nobody" }, ctx);
	assert.match(miss, /库里共 1 条/, "空结果要说清库里有什么");

	const show = await call(tools, "orders_show", { id: "T01" }, ctx);
	assert.match(show, /最近动作/);
	assert.match(show, /待复核 → 已收口｜过了/);
});

test("doctor 报出会话 key 形式的下一步对象", async () => {
	const cwd = tmpProject();
	const { tools, commands } = mount("owner");
	const ctx = ctxFor(cwd);
	await call(tools, "orders_init", {}, ctx);
	await call(tools, "orders_create", { title: "甲", nextActors: ["dev"] }, ctx);

	// 直接改库模拟历史遗留的坏数据（写入口已经拦了）
	const dbPath = path.join(cwd, ".work-orders", "work-orders.sqlite");
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(dbPath);
	db.prepare("UPDATE orders SET next_actors=? WHERE id='T01'").run(JSON.stringify(["1423-311c"]));
	db.close();

	const notes = [];
	await commands.get("orders").handler("doctor", { ...ctx, ui: { notify: (t) => notes.push(t) } });
	assert.match(notes.join("\n"), /会话 key/);
	assert.match(notes.join("\n"), /1423-311c/);
});

test("收口一条没有下游的单：不把已收口的单再交回给刚收口的人", async () => {
	const cwd = tmpProject();
	const { tools, channels } = mount("qa");
	const ctx = ctxFor(cwd);
	const sent = fakePeer(channels, { ok: true, to: "qa" });
	enableHandoff(cwd);
	await call(tools, "orders_init", {}, ctx);
	// owner 派给 qa（本会话），再自己认领、收口：全程只有派单那一次该叫人
	await call(tools, "orders_create", { title: "复核某项", nextActors: ["qa"], actor: "owner" }, ctx);
	await call(tools, "orders_update", { id: "T01", state: "在做", reason: "接了" }, ctx);
	await call(tools, "orders_update", { id: "T01", state: "已收口", closingBasis: "a.md", reason: "过了" }, ctx);

	// 建单时投过一次；在做不叫人；收口没有下游，也不该把 T01 交回给 qa
	assert.equal(sent.length, 1);
	assert.match(sent[0].text, /工单交接 T01/);
});

// ── 身份：没有 peer 也要有个稳定的 actor ─────────────

test("会话没名字时 actor 落在「用户」上，不写成 pid 形式的死链", async () => {
	const cwd = tmpProject();
	const { tools } = mount("");
	const ctx = ctxFor(cwd);
	await call(tools, "orders_init", {}, ctx);
	await call(tools, "orders_create", { title: "自己干", nextActors: ["用户"] }, ctx);
	const show = await call(tools, "orders_show", { id: "T01" }, ctx);

	assert.match(show, /最近动作/);
	assert.match(show, /rev1 用户 待认领｜建单/, "记的是用户，不是 目录名-pid");

	// 认领后归属也留在「用户」上，重启会话照样接得住
	const claimed = await call(tools, "orders_update", { id: "T01", state: "在做", reason: "开始做" }, ctx);
	assert.match(claimed, /下一步找谁：用户/);
});

test("会话启动时问一次 peer 身份，之后工具调用都按角色名记账", async () => {
	const cwd = tmpProject();
	const { tools, handlers, channels } = mount("");
	const ctx = ctxFor(cwd);
	await call(tools, "orders_init", {}, ctx);

	// 冒充 peer 应答 whoami
	channels.set("peer:whoami", [
		(data) => {
			for (const fn of channels.get("peer:whoami:result") ?? []) fn({ id: data.id, name: "qa" });
		},
	]);
	await handlers.get("session_start")({ type: "session_start" }, ctx);

	await call(tools, "orders_create", { title: "复核某项", nextActors: ["qa"] }, ctx);
	const show = await call(tools, "orders_show", { id: "T01" }, ctx);
	assert.match(show, /rev1 qa 待认领｜建单/);
});

test("派工要求对方空闲：忙的不投，如实回报", async () => {
	const cwd = tmpProject();
	const { tools, channels } = mount("owner");
	const ctx = ctxFor(cwd);
	const sent = [];
	channels.set("peer:deliver", [
		(data) => {
			sent.push(data);
			for (const fn of channels.get("peer:deliver:result") ?? []) {
				fn({ id: data.id, ok: false, detail: "dev 在忙", to: undefined });
			}
		},
	]);
	enableHandoff(cwd);
	await call(tools, "orders_init", {}, ctx);

	const out = await call(tools, "orders_create", { title: "实现排序", nextActors: ["dev"] }, ctx);
	assert.match(out, /待认领/, "库照样落上");
	assert.match(out, /waiting：dev 在忙/, "忙时留下可恢复等待状态");
	assert.equal(sent[0].requireIdle, true, "派工必须声明只要空闲的");
});

test("交接默认不发：写库后一条不投，打开才投", async () => {
	const cwd = tmpProject();
	const { tools, handlers, channels } = mount("owner", { roleName: "owner" });
	const ctx = ctxFor(cwd);
	const sent = fakePeer(channels);
	await call(tools, "orders_init", {}, ctx);

	const quiet = await call(tools, "orders_create", { title: "默认安静", nextActors: ["dev"] }, ctx);
	assert.equal(sent.length, 0, "不配就一条都不投");
	assert.match(quiet, /待认领/, "建单本身照样成功");
	assert.match(quiet, /workOrders\.handoff/, "返回里要能看出是没开，不是没人可派");

	enableHandoff(cwd);
	const loud = await call(tools, "orders_create", { title: "开了就投", nextActors: ["dev"] }, ctx);
	// 打开时把还在等的单一起补上：T01 仍是待认领，所以补 T01 + 新建的 T02
	assert.deepEqual(sent.map((m) => /T\d+/.exec(m.text)?.[0]).sort(), ["T01", "T02"]);
	assert.match(loud, /sending：/, "返回里报出投递状态");
	handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
});

// ── 定时提醒：跟着角色会话走 ────────────────────────

/** 建库 + 一条等 owner 的单 + 项目配置（这个项目跟随 owner，0.01 分钟看一次） */
async function staleProject({ role = "owner", sessionName = "owner", extra = {} } = {}) {
	const cwd = tmpProject();
	const sent = [];
	const mounted = mount(sessionName, { roleName: extra.roleName ?? sessionName, sent, ...extra });
	await call(mounted.tools, "orders_init", { idPrefix: "W" }, ctxFor(cwd));
	await call(mounted.tools, "orders_create", { title: "改登录页", nextActors: [role] }, ctxFor(cwd));
	ageOrder(cwd, "W01", 90);
	writeProjectConfig(cwd, { workOrders: { followRole: role, intervalMinutes: 0.01, staleMinutes: 30 } });
	return { cwd, sent, ...mounted };
}

test("定时提醒：身份对上的角色会话到点收到一条汇总，会话结束就停", async () => {
	const { cwd, sent, handlers } = await staleProject();
	const ctx = ctxFor(cwd);

	await handlers.get("session_start")({ type: "session_start" }, ctx);
	await waitFor(() => sent.length > 0);
	assert.match(sent[0], /【工单台账 · 定时提醒】/);
	assert.match(sent[0], /等你动的 1 条/);
	assert.match(sent[0], /W01 待认领 等了 1\.5h｜改登录页/);

	handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);

	// 停表之后再冒出来一条新的停滞单，也不该有人提
	const { openLedger } = await import("../core/schema.ts");
	const { createOrder } = await import("../core/store.ts");
	const opened = openLedger(path.join(cwd, ".work-orders", "work-orders.sqlite"));
	const fresh = createOrder(opened, { title: "新单", nextActors: ["owner"] }, { actor: "owner", reason: "测试" });
	opened.close();
	ageOrder(cwd, fresh.id, 120);

	const after = sent.length;
	await sleep(900);
	assert.equal(sent.length, after, "会话结束了，定时器就不该再响");
});

test("定时提醒：不是配置里那个角色的会话不跑", async () => {
	const { cwd, sent, handlers } = await staleProject({ role: "owner", sessionName: "dev" });

	await handlers.get("session_start")({ type: "session_start" }, ctxFor(cwd));
	await sleep(900);
	assert.deepEqual(sent, [], "身份对不上就不该自言自语");
	handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctxFor(cwd));
});

test("定时提醒：正在跑一轮时不插队，等这一轮结束再提", async () => {
	const { cwd, sent, handlers } = await staleProject();
	const ctx = ctxFor(cwd);

	await handlers.get("session_start")({ type: "session_start" }, ctx);
	handlers.get("agent_start")({ type: "agent_start" }, ctx);
	await sleep(1000);
	assert.deepEqual(sent, [], "在忙就别打断");

	handlers.get("agent_end")({ type: "agent_end", messages: [] }, ctx);
	await waitFor(() => sent.length > 0);
	assert.match(sent[0], /W01/);
	handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
});

test("定时提醒：库是会话起来之后才建的，建完下一轮就提", async () => {
	const cwd = tmpProject();
	const sent = [];
	const { tools, handlers } = mount("owner", { roleName: "owner", sent });
	const ctx = ctxFor(cwd);
	// 配置先写好，库还没建：项目刚开张的样子
	writeProjectConfig(cwd, { workOrders: { followRole: "owner", intervalMinutes: 0.01, staleMinutes: 30 } });

	await handlers.get("session_start")({ type: "session_start" }, ctx);
	await sleep(700);
	assert.deepEqual(sent, [], "还没库，没什么可提的");

	await call(tools, "orders_init", { idPrefix: "W" }, ctx);
	await call(tools, "orders_create", { title: "改登录页", nextActors: ["owner"] }, ctx);
	ageOrder(cwd, "W01", 90);

	await waitFor(() => sent.length > 0);
	assert.match(sent[0], /W01/);
	handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
});

test("工单类型：建库写枚举，建单与列表按枚举校验，空串清空", async () => {
	const cwd = tmpProject();
	const { tools } = mount();
	const ctx = ctxFor(cwd);
	assert.ok(tools.get("orders_create").parameters.properties.type);
	assert.ok(tools.get("orders_update").parameters.properties.type);
	assert.ok(tools.get("orders_list").parameters.properties.type);

	const init = await call(tools, "orders_init", { types: ["需求", "缺陷"] }, ctx);
	assert.match(init, /类型：需求 · 缺陷/);

	const created = await call(tools, "orders_create", { title: "修登录", nextActors: ["dev"], type: "缺陷" }, ctx);
	assert.match(created, /类型：缺陷｜状态：/);

	// 默认枚举在项目里被覆盖后失效
	const rejected = await call(tools, "orders_create", { title: "写错类型", nextActors: ["dev"], type: "需求单" }, ctx);
	assert.match(rejected, /未知工单类型：需求单/);

	await call(tools, "orders_create", { title: "加导出", nextActors: ["dev"], type: "需求" }, ctx);
	const filtered = await call(tools, "orders_list", { type: "缺陷" }, ctx);
	assert.match(filtered, /修登录/);
	assert.doesNotMatch(filtered, /加导出/);

	const cleared = await call(tools, "orders_update", { id: "T01", type: "", reason: "分错了" }, ctx);
	assert.doesNotMatch(cleared.split("─")[0], /类型：/);
	const stillOther = await call(tools, "orders_show", { id: "T02" }, ctx);
	assert.match(stillOther, /类型：需求/);
});

test("工具层能评论：写进 orders_show，状态与 rev 都不动", async () => {
	const cwd = tmpProject();
	const { tools } = mount("qa");
	const ctx = ctxFor(cwd);
	await call(tools, "orders_init", {}, ctx);
	await call(tools, "orders_create", { title: "复核某项", nextActors: ["qa"] }, ctx);

	const wrote = await call(tools, "orders_comment", { id: "T01", body: "判据 2 的读数取自 main", revision: 1 }, ctx);
	assert.match(wrote, /评论 #1 已记录/);
	assert.match(wrote, /当前 rev1/);

	const show = await call(tools, "orders_show", { id: "T01" }, ctx);
	assert.match(show, /评论：/);
	assert.match(show, /qa rev1｜判据 2 的读数取自 main/);
	assert.match(show, /状态：待认领/, "评论不推状态");
	assert.match(show, /rev 1/, "评论不涨版本");

	// 带错版本不拒绝：指出差异就够，评论本来就是回头看那条单的工具
	const stale = await call(tools, "orders_comment", { id: "T01", body: "晚到的看法", revision: 0 }, ctx);
	assert.match(stale, /你指的是 rev0，当前已是 rev1/);

	// 空内容被拒，不落脏行
	const empty = await call(tools, "orders_comment", { id: "T01", body: "  " }, ctx);
	assert.match(empty, /失败：评论内容不能为空/);
});
