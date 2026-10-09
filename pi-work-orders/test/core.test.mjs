import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { eventsOf, initLedger, openLedger, stateOf, statesOf } from "../core/schema.ts";
import {
	addDep,
	appendBody,
	countBlockedDownstream,
	createOrder,
	downstreamOf,
	getOrder,
	groupByActor,
	idleReady,
	listHint,
	listOrders,
	readyOrders,
	removeDep,
	staleWaiting,
	updateOrder,
	waitedMinutes,
	waitingOrders,
} from "../core/store.ts";
import { buildDigest } from "../core/digest.ts";

/**
 * 把一条单的动作记录整体往前推 N 分钟，用来造「已经等了很久」的场景。
 * 等待时长按事件时刻算，所以改事件比改 orders.updated_at 更贴真实语义。
 */
function agingEvent(db, orderId, minutes) {
	db.prepare("UPDATE events SET at = strftime('%Y-%m-%dT%H:%M:%fZ','now',?) WHERE order_id=?").run(
		`-${minutes} minutes`,
		orderId,
	);
}

function freshLedger() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-orders-"));
	const dbPath = path.join(dir, "work-orders.sqlite");
	const db = initLedger(dbPath);
	return { db, dir, dbPath };
}

const owner = { actor: "owner", reason: "测试" };

test("建库后状态集是默认七态", () => {
	const { db } = freshLedger();
	const states = statesOf(db);
	assert.deepEqual(Object.values(states), [
		"待认领",
		"在做",
		"待复核",
		"被打回",
		"阻塞",
		"已收口",
		"已取消",
	]);
	db.close();
});

test("工单自动编号，按前缀递增", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "第一条", nextActors: ["dev"] }, owner);
	const b = createOrder(db, { title: "第二条", nextActors: ["dev"] }, owner);
	assert.equal(a.id, "T01");
	assert.equal(b.id, "T02");
	assert.equal(a.state, stateOf(db, "claimable"));
	db.close();
});

test("转换按角色校验：待认领不能直接收口", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "x", nextActors: ["dev"] }, owner);
	assert.throws(
		() => updateOrder(db, a.id, { state: stateOf(db, "done") }, owner),
		/不合法转换/,
	);
	db.close();
});

test("认领走 待认领→在做，且一个角色同时只能有一条在做", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "a", nextActors: ["dev"] }, owner);
	const b = createOrder(db, { title: "b", nextActors: ["dev"] }, owner);
	updateOrder(db, a.id, { state: stateOf(db, "active") }, { actor: "dev", reason: "接了" });
	assert.throws(
		() => updateOrder(db, b.id, { state: stateOf(db, "active") }, { actor: "dev", reason: "再接一条" }),
		/已有在做的一条/,
	);
	// 换个人接就不冲突
	updateOrder(
		db,
		b.id,
		{ state: stateOf(db, "active"), nextActors: ["qa"] },
		{ actor: "qa", reason: "qa 接" },
	);
	db.close();
});

test("阻塞只从在做进、解除回在做", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "a", nextActors: ["dev"] }, owner);
	updateOrder(db, a.id, { state: stateOf(db, "active") }, { actor: "dev", reason: "接" });
	updateOrder(db, a.id, { state: stateOf(db, "paused") }, { actor: "dev", reason: "等批准" });
	assert.equal(getOrder(db, a.id).state, stateOf(db, "paused"));
	updateOrder(db, a.id, { state: stateOf(db, "active") }, { actor: "dev", reason: "批准了" });
	assert.equal(getOrder(db, a.id).state, stateOf(db, "active"));
	db.close();
});

test("结单必须带终止依据，取消必须给理由", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "a", nextActors: ["dev"] }, owner);
	updateOrder(db, a.id, { state: stateOf(db, "active") }, { actor: "dev", reason: "接" });
	updateOrder(db, a.id, { state: stateOf(db, "review") }, { actor: "dev", reason: "交" });
	assert.throws(
		() => updateOrder(db, a.id, { state: stateOf(db, "done") }, { actor: "qa", reason: "过了" }),
		/结单必须给终止依据/,
	);
	const closed = updateOrder(
		db,
		a.id,
		{ state: stateOf(db, "done"), closingBasis: "cargo test: 412 passed" },
		{ actor: "qa", reason: "过了" },
	);
	assert.equal(closed.state, stateOf(db, "done"));
	assert.equal(closed.closingBasis, "cargo test: 412 passed");

	const b = createOrder(db, { title: "b", nextActors: ["dev"] }, owner);
	assert.throws(
		() => updateOrder(db, b.id, { state: stateOf(db, "cancelled") }, owner),
		/取消必须给理由/,
	);
	db.close();
});

test("依赖成环会被拒绝", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "a", nextActors: ["dev"] }, owner);
	const b = createOrder(db, { title: "b", nextActors: ["dev"] }, owner);
	addDep(db, b.id, a.id, owner);
	assert.throws(() => addDep(db, a.id, b.id, owner), /会成环/);
	assert.throws(() => addDep(db, a.id, a.id, owner), /不能指向自己/);
	db.close();
});

test("ready 只列依赖已收口的", () => {
	const { db } = freshLedger();
	const up = createOrder(db, { title: "上游", nextActors: ["dev"] }, owner);
	const down = createOrder(db, { title: "下游", nextActors: ["dev"], dependsOn: [up.id] }, owner);

	assert.deepEqual(
		readyOrders(db).map((o) => o.id),
		[up.id],
	);

	updateOrder(db, up.id, { state: stateOf(db, "active") }, { actor: "dev", reason: "接" });
	updateOrder(db, up.id, { state: stateOf(db, "review") }, { actor: "dev", reason: "交" });
	updateOrder(
		db,
		up.id,
		{ state: stateOf(db, "done"), closingBasis: "有证据" },
		{ actor: "qa", reason: "过" },
	);
	assert.deepEqual(
		readyOrders(db).map((o) => o.id),
		[down.id],
	);

	// 终态不可退出：已收口的不能重开
	assert.throws(
		() => updateOrder(db, up.id, { state: stateOf(db, "active") }, { actor: "dev", reason: "重开" }),
		/不合法转换/,
	);
	db.close();
});

test("上游取消时下游的依赖标成 stale，且不算可开工", () => {
	const { db } = freshLedger();
	const up = createOrder(db, { title: "上游", nextActors: ["dev"] }, owner);
	const down = createOrder(db, { title: "下游", nextActors: ["dev"], dependsOn: [up.id] }, owner);

	updateOrder(
		db,
		up.id,
		{ state: stateOf(db, "cancelled"), closingBasis: "需求撤了" },
		{ actor: "owner", reason: "不做了" },
	);

	const view = getOrder(db, down.id);
	assert.deepEqual(view.staleDeps, [up.id], "上游取消后下游应看到失效依赖");
	assert.ok(!readyOrders(db).some((o) => o.id === down.id), "上游取消时下游不该算可开工");
	db.close();
});

test("取消上游时能数出受影响的下游", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "a", nextActors: ["dev"] }, owner);
	const b = createOrder(db, { title: "b", nextActors: ["dev"], dependsOn: [a.id] }, owner);
	const c = createOrder(db, { title: "c", nextActors: ["dev"], dependsOn: [b.id] }, owner);
	assert.equal(countBlockedDownstream(db, a.id), 2);
	assert.deepEqual(
		downstreamOf(db, a.id).map((o) => o.id),
		[b.id, c.id],
	);
	db.close();
});

test("revision 冲突会被拒绝", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "a", nextActors: ["dev"] }, owner);
	updateOrder(db, a.id, { state: stateOf(db, "active") }, { actor: "dev", reason: "接" }, 1);
	assert.throws(
		() => updateOrder(db, a.id, { state: stateOf(db, "review") }, { actor: "dev", reason: "交" }, 1),
		/版本冲突.*请重读工单/s,
	);
	db.close();
});

test("正文修订用追加，不覆盖旧句", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "a", body: "## 目标\n做 A", nextActors: ["dev"] }, owner);
	const view = appendBody(db, a.id, "## 范围修订（2026-10-05）\n原「只做 A」作废，改为 A+B。", owner);
	assert.match(view.body, /做 A/);
	assert.match(view.body, /范围修订/);
	db.close();
});

test("追加与字段写入同事务：字段那步失败，正文与 revision 都不动", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "a", body: "## 目标\n做 A", nextActors: ["dev"] }, owner);
	updateOrder(db, a.id, { state: stateOf(db, "active") }, { actor: "dev", reason: "接" });
	updateOrder(db, a.id, { state: stateOf(db, "review") }, { actor: "dev", reason: "交" });
	const before = getOrder(db, a.id);
	// 收口缺终止依据 → 走到写库前抛错；这次调用里还带着正文追加
	assert.throws(
		() =>
			updateOrder(
				db,
				a.id,
				{ appendBody: "## 范围修订\n追加这段", state: stateOf(db, "done") },
				owner,
			),
		/结单必须给终止依据/,
	);
	const after = getOrder(db, a.id);
	assert.equal(after.body, before.body);
	assert.equal(after.revision, before.revision);
	assert.equal(after.state, before.state);
	db.close();
});

test("body 传空串：不改正文，也不吞掉同一次调用的追加", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "a", body: "## 目标\n做 A", nextActors: ["dev"] }, owner);

	// 单给空串：正文原样，只推进版本
	assert.equal(updateOrder(db, a.id, { body: "" }, owner).body, "## 目标\n做 A");
	assert.equal(updateOrder(db, a.id, { body: "   " }, owner).body, "## 目标\n做 A");

	// 空串 + 追加：追加落地，旧句不丢
	const view = updateOrder(db, a.id, { body: "", appendBody: "## 范围修订\n改为 A+B" }, owner);
	assert.match(view.body, /做 A/);
	assert.match(view.body, /范围修订/);
	assert.equal(view.revision, 4);
	db.close();
});

test("删依赖后下游可以重新开工", () => {
	const { db } = freshLedger();
	const up = createOrder(db, { title: "上游", nextActors: ["dev"] }, owner);
	const down = createOrder(db, { title: "下游", nextActors: ["dev"], dependsOn: [up.id] }, owner);
	removeDep(db, down.id, up.id, { actor: "owner", reason: "改口径" });
	assert.deepEqual(
		readyOrders(db).map((o) => o.id).sort(),
		[up.id, down.id].sort(),
	);
	assert.equal(listOrders(db).length, 2);
	db.close();
});

test("下一步找谁是有序候选：任一名字都能查到", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "a", nextActors: ["dev", "qa"] }, owner);
	assert.deepEqual(getOrder(db, a.id).nextActors, ["dev", "qa"]);
	assert.equal(listOrders(db, { nextActor: "dev" }).length, 1);
	assert.equal(listOrders(db, { nextActor: "qa" }).length, 1);
	assert.equal(listOrders(db, { nextActor: "ux" }).length, 0);
	db.close();
});

test("候选去重、去空，且不能为空数组", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "a", nextActors: ["dev", "dev", " qa "] }, owner);
	assert.deepEqual(getOrder(db, a.id).nextActors, ["dev", "qa"]);
	assert.throws(() => createOrder(db, { title: "b", nextActors: [] }, owner), /不能为空/);
	db.close();
});

test("认领时收敛成执行者本人，备选不再挂着", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "a", nextActors: ["dev", "qa"] }, owner);
	const claimed = updateOrder(
		db,
		a.id,
		{ state: stateOf(db, "active") },
		{ actor: "qa", reason: "dev 不在，qa 接" },
	);
	assert.deepEqual(claimed.nextActors, ["qa"]);
	db.close();
});

test("在做状态不允许挂多个执行者", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "a", nextActors: ["dev"] }, owner);
	assert.throws(
		() =>
			updateOrder(
				db,
				a.id,
				{ state: stateOf(db, "active"), nextActors: ["dev", "qa"] },
				{ actor: "dev", reason: "接" },
			),
		/只能有一个执行者/,
	);
	db.close();
});

// ── 查历史：state 与「跳过终态」不再互相打架 ──────────────

test("state 写终态时不叠加「跳过终态」，不用再带 history", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "甲", nextActors: ["dev"] }, owner);
	const b = createOrder(db, { title: "乙", nextActors: ["dev"] }, owner);
	updateOrder(db, a.id, { state: stateOf(db, "active") }, owner);
	updateOrder(db, a.id, { state: stateOf(db, "review"), nextActors: ["qa"] }, owner);
	updateOrder(db, a.id, { state: stateOf(db, "done"), closingBasis: "证据" }, owner);

	// 曾经的病灶：默认排除终态 + state 限定终态 = 恒空
	const closed = listOrders(db, { state: stateOf(db, "done") });
	assert.equal(closed.length, 1);
	assert.equal(closed[0].id, a.id);
	assert.equal(listOrders(db, { state: stateOf(db, "cancelled") }).length, 0);

	// 默认视图仍然不含终态
	assert.deepEqual(
		listOrders(db).map((o) => o.id),
		[b.id],
	);
	// history 单独用就把两边都带上
	assert.equal(listOrders(db, { history: true }).length, 2);
});

test("空结果给出可自救的提示，而不是静默空", () => {
	const { db } = freshLedger();
	assert.match(String(listHint(db, {})), /还没有任何工单/);

	const a = createOrder(db, { title: "甲", nextActors: ["dev"] }, owner);
	updateOrder(db, a.id, { state: stateOf(db, "active") }, owner);
	updateOrder(db, a.id, { state: stateOf(db, "review"), nextActors: ["qa"] }, owner);
	updateOrder(db, a.id, { state: stateOf(db, "done"), closingBasis: "证据" }, owner);

	const hint = listHint(db, { nextActor: "nobody" });
	assert.match(String(hint), /库里共 1 条/);
	assert.match(String(hint), /未收口 0 条/);
	assert.match(String(hint), /history=true/);
	assert.equal(listHint(db, { history: true }), undefined, "有命中就不提示");
});

// ── 在等谁：等待时长按进当前状态的时刻算 ────────────────

test("等谁、等多久：正文改动不重置等待时钟", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "甲", nextActors: ["dev"] }, owner);

	// 拖一下时间：模拟「建了单没人接」
	agingEvent(db, a.id, 120);

	const waiting = waitingOrders(db);
	assert.equal(waiting.length, 1);
	assert.equal(waiting[0].order.id, a.id);
	assert.ok(waitedMinutes(waiting[0]) >= 119, "等了两小时左右");

	// 改正文不该让人以为「刚动过」：等待仍按进当前状态的时刻算
	updateOrder(db, a.id, { appendBody: "## 补充" }, { actor: "owner", reason: "补一句" });
	assert.ok(waitedMinutes(waitingOrders(db)[0]) >= 119);

	// 进在做就不再是「等人动」
	updateOrder(db, a.id, { state: stateOf(db, "active") }, { actor: "dev", reason: "接了" });
	assert.equal(waitingOrders(db).length, 0);

	// 交付到待复核又要等人裁定
	updateOrder(db, a.id, { state: stateOf(db, "review"), nextActors: ["qa"] }, { actor: "dev", reason: "交付" });
	assert.deepEqual(
		waitingOrders(db).map((w) => w.order.nextActors[0]),
		["qa"],
	);
	assert.equal(waitingOrders(db, "dev").length, 0, "换人了就不再等 dev");
});

test("停滞判定按阈值切，可开工没人接单独成列", () => {
	const { db } = freshLedger();
	const fresh = createOrder(db, { title: "刚建的", nextActors: ["dev"] }, owner);
	const old = createOrder(db, { title: "挂了很久的", nextActors: ["qa"] }, owner);
	agingEvent(db, old.id, 90);

	assert.deepEqual(
		staleWaiting(db, 30).map((w) => w.order.id),
		[old.id],
	);
	assert.deepEqual(
		idleReady(db).map((o) => o.id),
		[fresh.id, old.id],
	);
	assert.deepEqual(
		groupByActor(staleWaiting(db, 30)).map((g) => g.actor),
		["qa"],
	);
});

// ── next_actors 写会话 key 直接拦 ────────────────────

test("下一步找谁拒绝会话 key：重启即失效的指向不许落库", () => {
	const { db } = freshLedger();
	assert.throws(
		() => createOrder(db, { title: "甲", nextActors: ["1423-311c"] }, owner),
		/要写角色名/,
	);
	assert.throws(
		() => createOrder(db, { title: "甲", nextActors: ["example-project-1423"] }, owner),
		/要写角色名/,
	);
	assert.throws(
		() =>
			updateOrder(
				db,
				createOrder(db, { title: "甲", nextActors: ["dev"] }, owner).id,
				{ nextActors: ["1426-82db"] },
				owner,
			),
		/要写角色名/,
	);
	// 正常名字与「用户」照常
	assert.equal(createOrder(db, { title: "乙", nextActors: ["用户"] }, owner).nextActors[0], "用户");
});

// ── 事件：谁、何时、从哪到哪 ───────────────────────

test("每次推进都留一条动作记录", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "甲", nextActors: ["dev"] }, { actor: "owner", reason: "派给 dev" });
	updateOrder(db, a.id, { state: stateOf(db, "active") }, { actor: "dev", reason: "接了" });
	updateOrder(db, a.id, { state: stateOf(db, "review"), nextActors: ["qa"] }, { actor: "dev", reason: "做完了" });
	updateOrder(db, a.id, { state: stateOf(db, "done"), closingBasis: "a.md" }, { actor: "qa", reason: "复核通过" });

	const history = eventsOf(db, a.id);
	assert.deepEqual(
		history.map((e) => [e.actor, e.kind, e.fromState, e.toState]),
		[
			["qa", "state", "待复核", "已收口"],
			["dev", "state", "在做", "待复核"],
			["dev", "state", "待认领", "在做"],
			["owner", "create", null, "待认领"],
		],
	);
	assert.equal(history[0].note, "复核通过");
});

test("只改正文记 field，不动状态就不算重新开始等", () => {
	const { db } = freshLedger();
	const a = createOrder(db, { title: "甲", nextActors: ["dev"] }, owner);
	updateOrder(db, a.id, { appendBody: "## 补充" }, owner);
	const kinds = eventsOf(db, a.id).map((e) => e.kind);
	assert.deepEqual(kinds, ["field", "create"]);
});

// ── 旧库升级 ────────────────────────────────────

test("v2 的库打开时自动升到 v3，数据不动", () => {
	const { db, dbPath } = freshLedger();
	createOrder(db, { title: "老数据", nextActors: ["dev"] }, owner);
	// 退回 v2 结构：删掉 events 表，把版本号改回去
	db.exec("DROP TABLE events;");
	db.exec("PRAGMA user_version=2;");
	db.close();

	const reopened = openLedger(dbPath);
	const version = reopened.prepare("PRAGMA user_version").get();
	assert.equal(version.user_version, 3);
	assert.equal(listOrders(reopened).length, 1, "老工单还在");
	assert.equal(eventsOf(reopened, "T01").length, 0, "升级后的动作记录从这一刻开始记");
	reopened.close();
});

test("版本比工具新时拒绝打开，不按旧结构硬读", () => {
	const { db, dbPath } = freshLedger();
	db.exec("PRAGMA user_version=99;");
	db.close();
	assert.throws(() => openLedger(dbPath), /库版本比工具新/);
});
