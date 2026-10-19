import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { initLedger, stateByTerminal, statesOf } from "../core/schema.ts";
import { createOrder, getOrder, listOrders, readyOrders, updateOrder } from "../core/store.ts";

const owner = { actor: "owner", reason: "测试" };

function ledgerWith(states) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-defs-"));
	return initLedger(path.join(dir, "test.sqlite"), { states });
}

const deployFlow = [
	{ name: "待安排", waiting: true, execution: true, initial: true },
	{ name: "在改", timing: true, singleOwner: true, execution: true },
	{ name: "待部署", waiting: true, needsBasis: true },
	{ name: "上线了", terminal: "done", needsBasis: true },
	{ name: "搁置", terminal: "cancelled", needsBasis: true },
];

test("项目能加自己的状态，不必与默认集同名同数量", () => {
	const db = ledgerWith(deployFlow);
	const order = createOrder(db, { title: "上线", nextActors: ["dev"] }, owner);
	assert.equal(order.state, "待安排");
	updateOrder(db, order.id, { state: "在改" }, { actor: "dev", reason: "接了" });
	updateOrder(db, order.id, { state: "待部署", closingBasis: "构建产物" }, { actor: "dev", reason: "改完" });
	assert.equal(getOrder(db, order.id).state, "待部署");
	assert.equal(statesOf(db).length, 5);
	assert.equal(stateByTerminal(db, "done"), "上线了");
	db.close();
});

test("转换不校验：任意状态直接跳到任意状态", () => {
	const db = ledgerWith(deployFlow);
	const order = createOrder(db, { title: "x", nextActors: ["dev"] }, owner);
	const closed = updateOrder(db, order.id, { state: "上线了", closingBasis: "直接上线" }, owner);
	assert.equal(closed.state, "上线了");
	const reopened = updateOrder(db, order.id, { state: "在改", nextActors: ["dev"] }, owner);
	assert.equal(reopened.state, "在改");
	db.close();
});

test("needsBasis 可以用在非终态：推进到它就必须要依据", () => {
	const db = ledgerWith(deployFlow);
	const order = createOrder(db, { title: "x", nextActors: ["dev"] }, owner);
	assert.throws(() => updateOrder(db, order.id, { state: "待部署" }, owner), /推进到「待部署」必须给终止依据/);
	updateOrder(db, order.id, { state: "待部署", closingBasis: "镜像已推送" }, owner);
	db.close();
});

test("没标 initial 时建单落到第一个非终态", () => {
	const db = ledgerWith([{ name: "起" }, { name: "完", terminal: "done" }]);
	const order = createOrder(db, { title: "x", nextActors: ["dev"] }, owner);
	assert.equal(order.state, "起");
	db.close();
});

test("多个 singleOwner 状态共享单人约束", () => {
	const db = ledgerWith([
		{ name: "甲", singleOwner: true, initial: true },
		{ name: "乙", singleOwner: true },
		{ name: "完", terminal: "done" },
	]);
	const a = createOrder(db, { title: "a", nextActors: ["dev"] }, owner);
	const b = createOrder(db, { title: "b", nextActors: ["qa"] }, owner);
	updateOrder(db, a.id, { state: "甲" }, { actor: "dev", reason: "接" });
	assert.throws(
		() => updateOrder(db, b.id, { state: "乙", nextActors: ["dev"] }, { actor: "dev", reason: "再接" }),
		/已有在做的一条/,
	);
	db.close();
});

test("状态集形状写错时建库就报错", () => {
	const fresh = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "state-defs-bad-")), "test.sqlite");
	assert.throws(() => initLedger(fresh(), { states: { 待认领: "x" } }), /meta\.states 要写成非空数组/);
	assert.throws(() => initLedger(fresh(), { states: [{ name: "甲" }, { name: "甲" }] }), /状态名重复/);
	assert.throws(
		() => initLedger(fresh(), { states: [{ name: "甲", terminal: "完成" }] }),
		/terminal 只能写 "done" 或 "cancelled"/,
	);
});

test("没声明 done 终态时依赖不解锁，只有无依赖的单算可开工", () => {
	const db = ledgerWith([
		{ name: "做", waiting: true, execution: true, initial: true },
		{ name: "移除", terminal: "cancelled", needsBasis: true },
	]);
	const up = createOrder(db, { title: "上游", nextActors: ["dev"] }, owner);
	const down = createOrder(db, { title: "下游", nextActors: ["dev"], dependsOn: [up.id] }, owner);
	assert.deepEqual(
		readyOrders(db).map((o) => o.id),
		[up.id],
	);
	assert.ok(!listOrders(db, { ready: true }).some((o) => o.id === down.id));
	db.close();
});
