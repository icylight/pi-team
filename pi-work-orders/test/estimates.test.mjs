import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { buildDispatchBrief, formatDispatchBrief } from "../core/digest.ts";
import { initLedger, openLedger, SCHEMA_VERSION } from "../core/schema.ts";
import {
	createOrder,
	deliveryDeviation,
	dependencyWaitMinutes,
	elapsedMinutes,
	estimateStatus,
	getOrder,
	updateOrder,
	upstreamArtifacts,
} from "../core/store.ts";
import { buildWatchText, collectDue, WATCH_DEFAULTS } from "../core/watch.ts";

const owner = { actor: "owner", reason: "测试" };

/** 把一条单的动作记录整体往前推 N 分钟：造「已经做了很久」的场景 */
function agingEvent(db, orderId, minutes) {
	db.prepare("UPDATE events SET at = strftime('%Y-%m-%dT%H:%M:%fZ','now',?) WHERE order_id=?").run(
		`-${minutes} minutes`,
		orderId,
	);
}

/** 退回 v4 结构：v5 之后加的列要整批退掉，否则升级时 ADD COLUMN 会撞已存在的列 */
const V5_PLUS_COLUMNS = [
	"type",
	"estimate_active_min",
	"estimate_wall_min",
	"estimate_basis",
	"actual_active_min",
	"actual_wall_min",
	"actual_wait_min",
	"delivery_variance",
	"placeholder_basis",
];

function downgradeToV4(db) {
	for (const column of V5_PLUS_COLUMNS) db.exec(`ALTER TABLE orders DROP COLUMN ${column};`);
	db.exec("PRAGMA user_version=4;");
}

function freshLedger() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-orders-effort-"));
	const dbPath = path.join(dir, "work-orders.sqlite");
	return { db: initLedger(dbPath), dir, dbPath };
}

// ── 估算：建单带上、改估只覆盖给的字段 ──────────────

test("建单写估算与依据，读回来不丢", () => {
	const { db } = freshLedger();
	const o = createOrder(
		db,
		{
			title: "搬迁工具",
			nextActors: ["dev"],
			estimate: { activeMin: 90, wallMin: 240, basis: "照上一版改，数据量没底" },
			placeholderBasis: "可以先按空表跑通流程",
		},
		owner,
	);
	assert.deepEqual(o.estimate, { activeMin: 90, wallMin: 240, basis: "照上一版改，数据量没底" });
	assert.equal(o.placeholderBasis, "可以先按空表跑通流程");
	assert.deepEqual(o.actual, { activeMin: null, wallMin: null }, "没交付就没有实际值");
	db.close();
});

test("工时不接受 0 与负数：写错了要报，不静默收下", () => {
	const { db } = freshLedger();
	const o = createOrder(db, { title: "甲", nextActors: ["dev"] }, owner);
	assert.throws(() => updateOrder(db, o.id, { estimate: { wallMin: 0 } }, owner), /要写正数分钟/);
	assert.throws(() => updateOrder(db, o.id, { actual: { activeMin: -30 } }, owner), /要写正数分钟/);
	assert.equal(getOrder(db, o.id).estimate.wallMin, null, "报错后不留半截数据");
	db.close();
});

test("改估只覆盖给出的字段，其余保留", () => {
	const { db } = freshLedger();
	const o = createOrder(
		db,
		{ title: "甲", nextActors: ["dev"], estimate: { activeMin: 60, wallMin: 180, basis: "初估" } },
		owner,
	);
	const after = updateOrder(db, o.id, { estimate: { wallMin: 300 } }, { actor: "dev", reason: "数据量比想的大" });
	assert.deepEqual(after.estimate, { activeMin: 60, wallMin: 300, basis: "初估" });
	db.close();
});

test("收口回填实际值：偏差是算出来的，不是填的", () => {
	const { db } = freshLedger();
	const o = createOrder(db, { title: "甲", nextActors: ["dev"], estimate: { activeMin: 60, wallMin: 120 } }, owner);
	updateOrder(db, o.id, { state: "在做" }, { actor: "dev", reason: "开工" });
	updateOrder(db, o.id, { state: "待复核" }, { actor: "dev", reason: "做完了" });
	const done = updateOrder(
		db,
		o.id,
		{
			state: "已收口",
			closingBasis: "提交 629dab2",
			actual: { activeMin: 90, wallMin: 240 },
			actualWaitMin: 120,
			deliveryVariance: "等依赖多花了 2h，改估一次",
		},
		owner,
	);
	assert.deepEqual(done.actual, { activeMin: 90, wallMin: 240 });
	assert.equal(done.actualWaitMin, 120);
	// 墙钟 240 - 预估 120 = +120；主动 90 - 预估 60 = +30；等待取交付时填的 120，不是 240-90=150
	assert.deepEqual(deliveryDeviation(done), { wallMin: 120, activeMin: 30, waitMin: 120 });
	assert.equal(done.deliveryVariance, "等依赖多花了 2h，改估一次");
	db.close();
});

test("没估算就不算偏差，不编 0", () => {
	const { db } = freshLedger();
	const o = createOrder(db, { title: "甲", nextActors: ["dev"] }, owner);
	assert.deepEqual(deliveryDeviation(o), { wallMin: null, activeMin: null, waitMin: null });
	db.close();
});

// ── 估算进度 ────────────────────────────────────

test("估算进度自开工算起，未开工的单不算落后", () => {
	const { db } = freshLedger();
	const pending = createOrder(db, { title: "没开工", nextActors: ["dev"], estimate: { wallMin: 60 } }, owner);
	agingEvent(db, pending.id, 600);
	assert.equal(estimateStatus(db, getOrder(db, pending.id)).level, "none", "待认领的单不该被算成超期");

	const active = createOrder(
		db,
		{ title: "在做", nextActors: ["dev"], state: "在做", estimate: { wallMin: 100 } },
		owner,
	);
	// agingEvent 的语义是「把事件改到距今 N 分钟」，不是累加
	agingEvent(db, active.id, 30);
	const early = estimateStatus(db, getOrder(db, active.id));
	assert.equal(early.level, "ok");
	assert.ok(Math.abs((early.ratio ?? 0) - 0.3) < 0.02, `ratio 应约 0.3，实际 ${early.ratio}`);

	agingEvent(db, active.id, 85);
	assert.equal(estimateStatus(db, getOrder(db, active.id)).level, "warn", "用了 85% 该预警");

	agingEvent(db, active.id, 115);
	const over = estimateStatus(db, getOrder(db, active.id));
	assert.equal(over.level, "over");
	assert.ok((over.remainMin ?? 0) < 0, "超期后剩余时间是负的");
	db.close();
});

test("没估墙钟就没有进度，不拿主动工时冒充", () => {
	const { db } = freshLedger();
	const o = createOrder(db, { title: "甲", nextActors: ["dev"], state: "在做", estimate: { activeMin: 60 } }, owner);
	agingEvent(db, o.id, 600);
	assert.deepEqual(estimateStatus(db, getOrder(db, o.id)), { level: "none", ratio: null, remainMin: null });
	db.close();
});

test("已过去分钟数按开工时刻算，正文改动不重置", () => {
	const { db } = freshLedger();
	const o = createOrder(db, { title: "甲", nextActors: ["dev"], state: "在做", estimate: { wallMin: 60 } }, owner);
	agingEvent(db, o.id, 40);
	assert.ok(Math.abs(elapsedMinutes(db, getOrder(db, o.id)) - 40) <= 1);
	updateOrder(db, o.id, { appendBody: "补一句" }, owner);
	assert.ok(Math.abs(elapsedMinutes(db, getOrder(db, o.id)) - 40) <= 1, "改正文不算重新开工");
	db.close();
});

// ── 依赖现场：等多久、上游留下什么 ──────────────────

test("等依赖的分钟数只对等依赖的单算", () => {
	const { db } = freshLedger();
	const up = createOrder(db, { title: "上游", nextActors: ["qa"], state: "在做" }, owner);
	const down = createOrder(db, { title: "下游", nextActors: ["dev"], dependsOn: [up.id] }, owner);
	agingEvent(db, down.id, 90);
	assert.ok(Math.abs(dependencyWaitMinutes(db, getOrder(db, down.id)) - 90) <= 1);
	assert.equal(dependencyWaitMinutes(db, getOrder(db, up.id)), 0, "不依赖别人就不算等依赖");
	db.close();
});

test("上游收口后，它的终止依据成为下游的已知产物", () => {
	const { db } = freshLedger();
	const up = createOrder(db, { title: "上游", nextActors: ["dev"], state: "在做" }, owner);
	const down = createOrder(db, { title: "下游", nextActors: ["qa"], dependsOn: [up.id] }, owner);
	assert.deepEqual(upstreamArtifacts(db, down.id), [], "上游没收口时没有产物");

	updateOrder(db, up.id, { state: "待复核" }, { actor: "dev", reason: "做完" });
	updateOrder(db, up.id, { state: "已收口", closingBasis: "提交 629dab2 + 迁移脚本" }, owner);

	const artifacts = upstreamArtifacts(db, down.id);
	assert.equal(artifacts.length, 1);
	assert.equal(artifacts[0].id, up.id);
	assert.match(artifacts[0].closingBasis ?? "", /629dab2/);
	db.close();
});

// ── 派工简报 ────────────────────────────────────

test("派工简报带依赖、产物、占位许可与重读信号", () => {
	const { db } = freshLedger();
	const up = createOrder(db, { title: "上游", nextActors: ["dev"], state: "在做" }, owner);
	const down = createOrder(
		db,
		{
			title: "下游",
			nextActors: ["qa"],
			dependsOn: [up.id],
			placeholderBasis: "先用固定假数据把界面跑通",
			estimate: { wallMin: 120 },
		},
		owner,
	);

	const before = buildDispatchBrief(db, getOrder(db, down.id));
	assert.equal(before.dependencies.length, 1);
	assert.equal(before.dependencies[0].id, up.id);
	assert.deepEqual(before.artifacts, []);
	assert.equal(before.placeholder, "先用固定假数据把界面跑通");
	assert.ok(!before.reread.some((s) => /上游已收口/.test(s)), "上游没收口就不该报已收口");

	const after = buildDispatchBrief(db, getOrder(db, down.id), { heldRevision: 0 });
	assert.ok(
		after.reread.some((s) => /rev/.test(s)),
		`手上版本与库里不一致要提示重读：${JSON.stringify(after.reread)}`,
	);

	const text = formatDispatchBrief(after);
	assert.match(text, /当前依赖：/);
	assert.match(text, /下游|可按占位继续/);
	assert.match(text, /必须重读：/);
	db.close();
});

test("上游收口与估算超期都算必须重读的信号", () => {
	const { db } = freshLedger();
	const up = createOrder(db, { title: "上游", nextActors: ["dev"], state: "在做" }, owner);
	const down = createOrder(
		db,
		{ title: "下游", nextActors: ["qa"], state: "在做", dependsOn: [up.id], estimate: { wallMin: 60 } },
		owner,
	);
	updateOrder(db, up.id, { state: "待复核" }, { actor: "dev", reason: "做完" });
	updateOrder(db, up.id, { state: "已收口", closingBasis: "产物在 tmp/out" }, owner);
	agingEvent(db, down.id, 90);

	const brief = buildDispatchBrief(db, getOrder(db, down.id));
	assert.ok(
		brief.reread.some((s) => /上游已收口/.test(s)),
		JSON.stringify(brief.reread),
	);
	assert.ok(
		brief.reread.some((s) => /100%/.test(s)),
		JSON.stringify(brief.reread),
	);
	assert.equal(brief.artifacts.length, 1);
	assert.match(formatDispatchBrief(brief), /tmp\/out/);
	db.close();
});

test("没有依赖、没有估算：简报为空，不刷空行", () => {
	const { db } = freshLedger();
	const o = createOrder(db, { title: "独立小活", nextActors: ["dev"] }, owner);
	assert.equal(formatDispatchBrief(buildDispatchBrief(db, getOrder(db, o.id))), "");
	db.close();
});

// ── 定时提醒：除停滞外还报估算与等待 ──────────────

const watchCfg = { ...WATCH_DEFAULTS, followRole: "owner", staleMinutes: 30, repeatMinutes: 60, waitMinutes: 60 };

test("估算超期与等依赖超阈都进提醒，不只催停滞", () => {
	const { db } = freshLedger();
	const active = createOrder(
		db,
		{ title: "做到一半", nextActors: ["dev"], state: "在做", estimate: { wallMin: 60 } },
		owner,
	);
	agingEvent(db, active.id, 70); // 超过 100%

	const up = createOrder(db, { title: "前置", nextActors: ["qa"], state: "在做" }, owner);
	const waiting = createOrder(db, { title: "等前置", nextActors: ["dev"], dependsOn: [up.id] }, owner);
	agingEvent(db, waiting.id, 90); // 等依赖 90m > 60m

	const due = collectDue(db, watchCfg);
	const reasons = due.map((d) => d.reason);
	assert.ok(reasons.includes("estimate-over"), `应有估算超期：${reasons}`);
	assert.ok(reasons.includes("wait"), `应有等依赖超时：${reasons}`);

	const note = buildWatchText(db, { me: "owner", config: watchCfg });
	assert.match(note.text, /估算超期/);
	assert.match(note.text, /等依赖超时/);
	assert.match(note.text, /不是催进度/, "提醒要说清自己在报读数");
	db.close();
});

test("同一条单命中多条理由时只留最紧迫的那条", () => {
	const { db } = freshLedger();
	// 待复核且停滞，同时又超估算：留估算超期（最紧）
	const o = createOrder(db, { title: "甲", nextActors: ["qa"], state: "在做", estimate: { wallMin: 60 } }, owner);
	agingEvent(db, o.id, 90);
	const due = collectDue(db, watchCfg).filter((d) => d.waiting.order.id === o.id);
	assert.equal(due.length, 1, "一条单只出现一次");
	assert.equal(due[0].reason, "estimate-over");
	db.close();
});

test("估算从 80% 走到 100% 是两条信息，不被 repeat 压掉", () => {
	const { db } = freshLedger();
	const o = createOrder(db, { title: "甲", nextActors: ["dev"], state: "在做", estimate: { wallMin: 100 } }, owner);
	agingEvent(db, o.id, 85);
	const first = buildWatchText(db, { me: "owner", config: watchCfg });
	assert.match(first.text, /估算将到/);

	agingEvent(db, o.id, 105); // 105%，理由变了
	const second = buildWatchText(db, { me: "owner", config: watchCfg, state: first.state });
	assert.match(second.text, /估算超期/);

	// 同一个理由、同一阶段、还没到 repeat：不提
	const third = buildWatchText(db, { me: "owner", config: watchCfg, state: second.state });
	assert.equal(third.text, "");
	db.close();
});

test("waitMinutes 可配：调大之后等依赖不再提", () => {
	const { db } = freshLedger();
	const up = createOrder(db, { title: "前置", nextActors: ["qa"], state: "在做" }, owner);
	const down = createOrder(db, { title: "等前置", nextActors: ["dev"], dependsOn: [up.id] }, owner);
	agingEvent(db, down.id, 90);

	assert.ok(collectDue(db, watchCfg).some((d) => d.reason === "wait"));
	assert.ok(!collectDue(db, { ...watchCfg, waitMinutes: 600 }).some((d) => d.reason === "wait"), "阈值调大后不该再提");
	db.close();
});

// ── 正文：口径覆盖，历史留在动作记录 ──────────────

test("范围修订覆盖正文而不是越堆越长，理由留在动作记录里", () => {
	const { db } = freshLedger();
	const o = createOrder(db, { title: "甲", nextActors: ["dev"], body: "第一版口径：只做列表" }, owner);
	const v2 = updateOrder(
		db,
		o.id,
		{ body: "第二版口径：列表 + 详情，范围缩小到只读" },
		{ actor: "owner", reason: "范围收窄：详情只做只读" },
	);
	assert.equal(v2.body, "第二版口径：列表 + 详情，范围缩小到只读", "正文是当前口径，不是两版叠加");
	const history = db
		.prepare("SELECT kind,note FROM events WHERE order_id=? ORDER BY id")
		.all(o.id)
		.map((e) => ({ kind: String(e.kind), note: String(e.note) }));
	assert.deepEqual(
		history.map((e) => e.kind),
		["create", "field"],
		"覆写要留一条 field 记录",
	);
	assert.match(history[1].note, /范围收窄/, "旧口径的去向写在理由里");
	db.close();
});

test("appendBody 仍可补小段，且与覆写互不干扰", () => {
	const { db } = freshLedger();
	const o = createOrder(db, { title: "甲", nextActors: ["dev"], body: "正文" }, owner);
	const appended = updateOrder(db, o.id, { appendBody: "补一句" }, owner);
	assert.match(appended.body, /^正文\n\n补一句/);
	const replaced = updateOrder(db, o.id, { body: "新口径" }, owner);
	assert.equal(replaced.body, "新口径");
	db.close();
});

// ── 旧库升级后新列可用 ──────────────────────────

test("v4 的库升级后能读能写估算字段", () => {
	const { db, dbPath } = freshLedger();
	const o = createOrder(db, { title: "老数据", nextActors: ["dev"], estimate: { wallMin: 60 } }, owner);
	downgradeToV4(db);
	db.close();

	const reopened = openLedger(dbPath);
	const upgraded = getOrder(reopened, o.id);
	assert.equal(upgraded.estimate.wallMin, null, "旧数据没有估算，不编一个");
	const patched = updateOrder(reopened, o.id, { estimate: { wallMin: 90 } }, owner);
	assert.equal(patched.estimate.wallMin, 90, "升级后能写新字段");
	reopened.close();
});

// ── 升级开关：多会话共享库时不被自动升级拖走 ──────────

test("PI_WORK_ORDERS_NO_MIGRATE=1：版本不匹配只报错，不写库", () => {
	const { db, dbPath } = freshLedger();
	createOrder(db, { title: "老数据", nextActors: ["dev"] }, owner);
	downgradeToV4(db);
	db.close();

	process.env.PI_WORK_ORDERS_NO_MIGRATE = "1";
	try {
		assert.throws(() => openLedger(dbPath), /已设 PI_WORK_ORDERS_NO_MIGRATE，不自动升级/);
		// 库必须还是 4：拒绝不等于静默升完再报错
		const probe = new DatabaseSync(dbPath);
		assert.equal(probe.prepare("PRAGMA user_version").get().user_version, 4);
		probe.close();
	} finally {
		delete process.env.PI_WORK_ORDERS_NO_MIGRATE;
	}

	// 放开之后能正常升级
	const reopened = openLedger(dbPath);
	assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
	reopened.close();
});

test("默认仍自动升级：不设变量时行为不变", () => {
	const { db, dbPath } = freshLedger();
	createOrder(db, { title: "老数据", nextActors: ["dev"] }, owner);
	downgradeToV4(db);
	db.close();

	const reopened = openLedger(dbPath);
	assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
	reopened.close();
});

// ── 看板产物过期判定 ──────────────────────────────

test("产物比源码旧就算过期；源码不动则不过期", async () => {
	const { buildFreshness } = await import("../core/web-build.ts");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-stale-"));
	const web = path.join(root, "web");
	fs.mkdirSync(path.join(web, ".next"), { recursive: true });
	fs.mkdirSync(path.join(web, "lib"), { recursive: true });
	fs.writeFileSync(path.join(web, "lib", "a.ts"), "x");

	// 没有产物：算过期
	assert.equal(buildFreshness(web).stale, true);

	// 产物比源码新：不过期
	const buildId = path.join(web, ".next", "BUILD_ID");
	fs.writeFileSync(buildId, "id");
	const future = Date.now() + 60_000;
	fs.utimesSync(buildId, future / 1000, future / 1000);
	assert.equal(buildFreshness(web).stale, false);

	// 源码改到产物之后：过期，且能指出是哪个文件
	const later = future + 60_000;
	fs.utimesSync(path.join(web, "lib", "a.ts"), later / 1000, later / 1000);
	const result = buildFreshness(web);
	assert.equal(result.stale, true);
	assert.match(result.newestSource, /lib\/a\.ts$/);

	// node_modules 与 .next 不参与比较
	fs.mkdirSync(path.join(web, "node_modules"), { recursive: true });
	fs.writeFileSync(path.join(web, "node_modules", "x.ts"), "y");
	const evenLater = later + 60_000;
	fs.utimesSync(path.join(web, "node_modules", "x.ts"), evenLater / 1000, evenLater / 1000);
	assert.doesNotMatch(buildFreshness(web).newestSource, /node_modules/);
});
