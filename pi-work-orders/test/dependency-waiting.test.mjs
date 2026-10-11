import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { initLedger, stateOf } from "../core/schema.ts";
import {
	addDep, createOrder, getOrder, idleReady, listOrders, readyOrders, removeDep,
	staleWaiting, updateOrder, waitingOrders,
} from "../core/store.ts";
import { buildDigest, renderStale } from "../core/digest.ts";
import { formatList, formatWaiting } from "../core/format.ts";
import { buildWatchText, WATCH_DEFAULTS } from "../core/watch.ts";

const MINUTE = 60_000;
const START = Date.parse("2026-01-01T00:00:00.000Z");
const owner = { actor: "owner", reason: "回归测试" };

function fixture(t) {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-waiting-"));
	const db = initLedger(path.join(dir, "test.sqlite"));
	t.after(() => db.close());
	const up = createOrder(db, { title: "上游", nextActors: ["dev"], role: "active" }, owner);
	const down = createOrder(db, { title: "下游", nextActors: ["dev"], dependsOn: [up.id] }, owner);
	return { db, up, down };
}

function complete(db, id) {
	updateOrder(db, id, { state: stateOf(db, "review") }, owner);
	updateOrder(db, id, { state: stateOf(db, "done"), closingBasis: "测试证据" }, owner);
}

function waiting(db, id) {
	return waitingOrders(db).find(item => item.order.id === id);
}

test("依赖未解仍在等待视图，但不计停滞或触发提醒", t => {
	const { db, up, down } = fixture(t);
	t.mock.timers.tick(65 * MINUTE);
	assert.ok(waiting(db, down.id), "依赖等待不能从在办视图消失");
	assert.ok(!readyOrders(db).some(item => item.id === down.id));
	assert.ok(!staleWaiting(db).some(item => item.order.id === down.id));
	assert.equal(buildWatchText(db, { me: "owner", config: WATCH_DEFAULTS }).text, "");
	const digest = buildDigest(db, { me: "dev" });
	assert.equal(digest.mine.length, 0, "依赖等待不是等 dev 接手");
	assert.match(digest.text, /等依赖/);
	assert.match(digest.text, new RegExp(`${up.id}.*在做`));
	assert.match(formatWaiting(waitingOrders(db)), /等依赖/);
	assert.match(formatList(listOrders(db), undefined, waitingOrders(db)), /等依赖/);
});

test("列表视图依赖单独成列：有前置显示单号，没有显示占位符", t => {
	const { db, up, down } = fixture(t);
	const text = formatList(listOrders(db));
	assert.match(text, /依赖/);
	const lineOf = id => text.split("\n").find(line => line.startsWith(id)) ?? "";
	assert.match(lineOf(down.id), new RegExp(`${up.id}\\s`), "下游的依赖列应显示上游单号");
	const upLine = lineOf(up.id);
	assert.equal(upLine.indexOf(up.id), 0, "上游行以自身单号开头");
	assert.ok(!upLine.slice(1).includes(up.id), "上游没有依赖，依赖列不应出现单号");
});

test("最后一个前置刚收口时重新开始接手等待，超过阈值才催", t => {
	const { db, up, down } = fixture(t);
	t.mock.timers.tick(65 * MINUTE);
	complete(db, up.id);
	assert.equal(waiting(db, down.id).since, "2026-01-01T01:05:00.000Z");
	assert.ok(idleReady(db).some(item => item.id === down.id));
	assert.equal(staleWaiting(db).length, 0);
	assert.equal(buildWatchText(db, { me: "owner", config: WATCH_DEFAULTS }).text, "");
	t.mock.timers.tick(31 * MINUTE);
	assert.match(buildWatchText(db, { me: "owner", config: WATCH_DEFAULTS }).text, new RegExp(down.id));
	assert.match(renderStale(db), new RegExp(down.id));
});

test("多个前置取最后一个解锁时刻，不取第一个收口时刻", t => {
	const { db, up, down } = fixture(t);
	const second = createOrder(db, { title: "另一前置", nextActors: ["qa"], role: "active" }, owner);
	addDep(db, down.id, second.id, owner);
	t.mock.timers.tick(40 * MINUTE);
	complete(db, up.id);
	assert.ok(!staleWaiting(db).some(item => item.order.id === down.id));
	t.mock.timers.tick(40 * MINUTE);
	complete(db, second.id);
	assert.equal(waiting(db, down.id).since, "2026-01-01T01:20:00.000Z");
	assert.equal(staleWaiting(db).length, 0);
});

test("删掉未完成的最后一个依赖，以删除事件作为解锁时刻", t => {
	const { db, up, down } = fixture(t);
	t.mock.timers.tick(65 * MINUTE);
	removeDep(db, down.id, up.id, owner);
	assert.equal(waiting(db, down.id).since, "2026-01-01T01:05:00.000Z");
	assert.ok(!staleWaiting(db).some(item => item.order.id === down.id));
});

test("删除已完成依赖和改正文，都不重置已经开始的接手等待", t => {
	const { db, up, down } = fixture(t);
	t.mock.timers.tick(20 * MINUTE);
	complete(db, up.id);
	t.mock.timers.tick(40 * MINUTE);
	removeDep(db, down.id, up.id, owner);
	updateOrder(db, down.id, { appendBody: "补充说明" }, owner);
	assert.equal(waiting(db, down.id).since, "2026-01-01T00:20:00.000Z");
	assert.ok(staleWaiting(db).some(item => item.order.id === down.id));
});

test("给已等待的单添加未完成前置，暂停催办；解锁后重新计时", t => {
	const { db, up, down } = fixture(t);
	removeDep(db, down.id, up.id, owner);
	t.mock.timers.tick(40 * MINUTE);
	assert.ok(staleWaiting(db).some(item => item.order.id === down.id));
	addDep(db, down.id, up.id, owner);
	assert.ok(!staleWaiting(db).some(item => item.order.id === down.id));
	t.mock.timers.tick(40 * MINUTE);
	complete(db, up.id);
	assert.equal(waiting(db, down.id).since, "2026-01-01T01:20:00.000Z");
	assert.ok(!staleWaiting(db).some(item => item.order.id === down.id));
});

test("添加已经完成的前置，不抹掉原有接手等待", t => {
	const { db, up, down } = fixture(t);
	removeDep(db, down.id, up.id, owner);
	t.mock.timers.tick(20 * MINUTE);
	complete(db, up.id);
	t.mock.timers.tick(40 * MINUTE);
	addDep(db, down.id, up.id, owner);
	assert.equal(waiting(db, down.id).since, "2026-01-01T00:00:00.000Z");
	assert.ok(staleWaiting(db).some(item => item.order.id === down.id));
});

test("等待阶段晚于前置解锁时，按进入当前阶段的时刻计时", t => {
	const { db, up, down } = fixture(t);
	t.mock.timers.tick(20 * MINUTE);
	complete(db, up.id);
	t.mock.timers.tick(40 * MINUTE);
	updateOrder(db, down.id, { state: stateOf(db, "active") }, { actor: "dev", reason: "认领" });
	updateOrder(db, down.id, { state: stateOf(db, "review") }, owner);
	updateOrder(db, down.id, { state: stateOf(db, "rework") }, owner);
	assert.equal(waiting(db, down.id).since, "2026-01-01T01:00:00.000Z");
	assert.equal(staleWaiting(db).length, 0);
});

test("上游取消不解锁下游，显示人工裁定并从取消时开始等待裁定", t => {
	const { db, up, down } = fixture(t);
	t.mock.timers.tick(65 * MINUTE);
	updateOrder(db, up.id, { state: stateOf(db, "cancelled"), closingBasis: "前提撤销" }, owner);
	assert.ok(!readyOrders(db).some(item => item.id === down.id));
	assert.deepEqual(getOrder(db, down.id).staleDeps, [up.id]);
	assert.equal(waiting(db, down.id).since, "2026-01-01T01:05:00.000Z");
	assert.match(buildDigest(db, { me: "owner" }).text, /上游已取消，需人工裁定/);
	assert.match(formatList(listOrders(db), undefined, waitingOrders(db)), /上游已取消，需人工裁定/);
	assert.equal(staleWaiting(db).length, 0);
	t.mock.timers.tick(31 * MINUTE);
	assert.match(buildWatchText(db, { me: "owner", config: WATCH_DEFAULTS }).text, /上游已取消，需人工裁定/);
	removeDep(db, down.id, up.id, owner);
	assert.equal(waiting(db, down.id).since, "2026-01-01T01:36:00.000Z");
	assert.equal(staleWaiting(db).length, 0);
});

test("待复核与阻塞的人工处置，不因未完成依赖被隐藏", t => {
	const { db, up } = fixture(t);
	const review = createOrder(db, { title: "需要复核", nextActors: ["qa"], role: "review", dependsOn: [up.id] }, owner);
	const paused = createOrder(db, { title: "需要解除阻塞", nextActors: ["owner"], role: "paused", dependsOn: [up.id] }, owner);
	t.mock.timers.tick(65 * MINUTE);
	const stale = staleWaiting(db).map(item => item.order.id);
	assert.ok(stale.includes(review.id));
	assert.ok(stale.includes(paused.id));
});

test("自定义状态名仍按角色判断依赖等待", t => {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-states-"));
	const db = initLedger(path.join(dir, "test.sqlite"), { states: { claimable: "待接领", done: "验收结束", cancelled: "需求撤销" } });
	t.after(() => db.close());
	const up = createOrder(db, { title: "上游", nextActors: ["dev"] }, owner);
	const down = createOrder(db, { title: "下游", nextActors: ["dev"], dependsOn: [up.id] }, owner);
	t.mock.timers.tick(65 * MINUTE);
	assert.ok(!staleWaiting(db).some(item => item.order.id === down.id));
	updateOrder(db, up.id, { state: stateOf(db, "active") }, owner);
	complete(db, up.id);
	assert.equal(waiting(db, down.id).since, "2026-01-01T01:05:00.000Z");
});

test("后来加上已取消的前置，从加入这条依赖时开始等待裁定", t => {
	const { db, up, down } = fixture(t);
	removeDep(db, down.id, up.id, owner);
	t.mock.timers.tick(20 * MINUTE);
	updateOrder(db, up.id, { state: stateOf(db, "cancelled"), closingBasis: "前提撤销" }, owner);
	t.mock.timers.tick(45 * MINUTE);
	addDep(db, down.id, up.id, owner);
	assert.equal(waiting(db, down.id).since, "2026-01-01T01:05:00.000Z");
	assert.equal(staleWaiting(db).length, 0);
});

test("旧库缺少事件时保持依赖分类，已完成前置用行时间保守回退", t => {
	const { db, up, down } = fixture(t);
	t.mock.timers.tick(65 * MINUTE);
	assert.ok(!staleWaiting(db).some(item => item.order.id === down.id));
	complete(db, up.id);
	db.exec("DELETE FROM events;");
	assert.equal(waiting(db, down.id).since, "2026-01-01T01:05:00.000Z");
	assert.ok(!staleWaiting(db).some(item => item.order.id === down.id));
});

test("提醒按传入的 now 判阈值，边界未超过时不催", t => {
	const { db, up, down } = fixture(t);
	removeDep(db, down.id, up.id, owner);
	assert.equal(buildWatchText(db, { me: "owner", config: WATCH_DEFAULTS, now: START + 30 * MINUTE }).text, "");
	assert.match(buildWatchText(db, { me: "owner", config: WATCH_DEFAULTS, now: START + 31 * MINUTE }).text, new RegExp(down.id));
});
