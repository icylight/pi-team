import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { eventsOf, initLedger, openLedger } from "../core/schema.ts";
import { createOrder, getOrder } from "../core/store.ts";
import { HUMAN_ACTOR } from "../core/types.ts";
import { advanceState } from "../web/lib/ledger.ts";

const owner = { actor: "owner", reason: "测试" };

function freshLedger() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-orders-web-"));
	const dbPath = path.join(dir, "work-orders.sqlite");
	const db = initLedger(dbPath);
	const order = createOrder(db, { title: "改看板", nextActors: ["dev"] }, owner);
	db.close();
	return { id: order.id, ref: { slug: "proj", name: "proj", dir, dbPath } };
}

/** 读一次就走：advanceState 自己开关连接，测试不与它抢同一个库 */
function read(ref, id) {
	const db = openLedger(ref.dbPath);
	try {
		return { view: getOrder(db, id), events: eventsOf(db, id, 100) };
	} finally {
		db.close();
	}
}

test("页面上推状态：署名落在用户，动作为 state 并留下理由", () => {
	const { id, ref } = freshLedger();
	const view = advanceState(ref, id, { state: "在做" }, "网页上认领");

	assert.equal(view.state, "在做");
	const after = read(ref, id);
	const last = after.events[0];
	assert.equal(last.actor, HUMAN_ACTOR);
	assert.equal(last.kind, "state");
	assert.equal(last.fromState, "待认领");
	assert.equal(last.toState, "在做");
	assert.equal(last.note, "网页上认领");
});

test("推到单执行者状态：下一步找谁落成本次操作者", () => {
	const { id, ref } = freshLedger();
	const view = advanceState(ref, id, { state: "在做" }, "网页上认领");

	assert.deepEqual(view.nextActors, [HUMAN_ACTOR]);
});

test("给的下一步找谁优先于认领的默认落点", () => {
	const { id, ref } = freshLedger();
	const view = advanceState(ref, id, { state: "在做", nextActors: ["qa"] }, "指派给 qa");

	assert.deepEqual(view.nextActors, ["qa"]);
});

test("结单缺终止依据被拒：库不变，错因指向依据", () => {
	const { id, ref } = freshLedger();
	assert.throws(() => advanceState(ref, id, { state: "已收口" }, "网页上结单"), /终止依据/);

	const after = read(ref, id);
	assert.equal(after.view.state, "待认领");
	assert.equal(after.view.closingBasis, null);
});

test("结单给依据就过：依据与理由都落库", () => {
	const { id, ref } = freshLedger();
	const view = advanceState(ref, id, { state: "已收口", closingBasis: "提交 abc123，npm test 通过" }, "网页上结单");

	assert.equal(view.state, "已收口");
	assert.equal(view.closingBasis, "提交 abc123，npm test 通过");
	assert.equal(read(ref, id).events[0].note, "网页上结单");
});

test("页面手上的版本旧了：拒绝覆盖，提示重读", () => {
	const { id, ref } = freshLedger();
	advanceState(ref, id, { state: "在做" }, "第一次推进");

	assert.throws(() => advanceState(ref, id, { state: "待复核" }, "拿旧版本再推", 1), /版本冲突/);
	assert.equal(read(ref, id).view.state, "在做");
});

test("理由为空被拒：库不改", () => {
	const { id, ref } = freshLedger();
	assert.throws(() => advanceState(ref, id, { state: "在做" }, "   "), /理由/);
	assert.equal(read(ref, id).view.state, "待认领");
});
