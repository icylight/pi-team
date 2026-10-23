import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { formatComments, formatHistory, formatList } from "../core/format.ts";
import { addComment, commentsOf, eventsOf, initLedger } from "../core/schema.ts";
import { createOrder, getOrder, listOrders, updateOrder } from "../core/store.ts";

const owner = { actor: "owner", reason: "测试" };

function freshLedger() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-orders-comments-"));
	const dbPath = path.join(dir, "work-orders.sqlite");
	return { db: initLedger(dbPath), dir, dbPath };
}

test("评论落库：正文、作者、指向的版本都读得回来", () => {
	const { db } = freshLedger();
	const order = createOrder(db, { title: "改看板", nextActors: ["dev"] }, owner);
	const comment = addComment(db, { orderId: order.id, actor: "qa", body: "判据 2 的读数取自 main", revision: 1 });

	assert.equal(comment.orderId, order.id);
	assert.equal(comment.actor, "qa");
	assert.equal(comment.revision, 1);
	assert.deepEqual(commentsOf(db, order.id), [comment]);
	db.close();
});

test("评论不推状态、不涨 revision、不进动作记录", () => {
	const { db } = freshLedger();
	const order = createOrder(db, { title: "改看板", nextActors: ["dev"] }, owner);
	const before = getOrder(db, order.id);
	const eventsBefore = eventsOf(db, order.id, 100);

	addComment(db, { orderId: order.id, actor: "qa", body: "看法" });

	const after = getOrder(db, order.id);
	assert.equal(after.state, before.state);
	assert.equal(after.revision, before.revision);
	assert.equal(after.updatedAt, before.updatedAt);
	assert.equal(eventsOf(db, order.id, 100).length, eventsBefore.length);
	db.close();
});

test("空评论被拒，纯空白也算空", () => {
	const { db } = freshLedger();
	const order = createOrder(db, { title: "改看板", nextActors: ["dev"] }, owner);
	assert.throws(() => addComment(db, { orderId: order.id, actor: "qa", body: "   " }), /评论内容不能为空/);
	assert.equal(commentsOf(db, order.id).length, 0);
	db.close();
});

test("评论按新→旧排列，limit 只留最近几条", () => {
	const { db } = freshLedger();
	const order = createOrder(db, { title: "改看板", nextActors: ["dev"] }, owner);
	for (const body of ["第一条", "第二条", "第三条"]) {
		addComment(db, { orderId: order.id, actor: "qa", body });
	}

	assert.deepEqual(
		commentsOf(db, order.id).map((c) => c.body),
		["第三条", "第二条", "第一条"],
	);
	assert.deepEqual(
		commentsOf(db, order.id, 2).map((c) => c.body),
		["第三条", "第二条"],
	);
	db.close();
});

test("建单之外的单号写评论会报错，不留孤行", () => {
	const { db } = freshLedger();
	assert.throws(() => addComment(db, { orderId: "T99", actor: "qa", body: "写错了" }), /没有这条工单/);
	db.close();
});

test("评论视图带作者、版本与时刻；没版本号就不显示", () => {
	const { db } = freshLedger();
	const order = createOrder(db, { title: "改看板", nextActors: ["dev"] }, owner);
	addComment(db, { orderId: order.id, actor: "qa", body: "对着 rev1 判的", revision: 1 });
	addComment(db, { orderId: order.id, actor: "owner", body: "没写版本" });

	const text = formatComments(commentsOf(db, order.id));
	assert.match(text, /qa rev1｜对着 rev1 判的/);
	assert.match(text, /owner｜没写版本/);
	assert.doesNotMatch(text, /owner rev\d/);
	db.close();
});

test("列表带 rev 列，值随写入递增", () => {
	const { db } = freshLedger();
	const order = createOrder(db, { title: "改看板", nextActors: ["dev"] }, owner);
	updateOrder(db, order.id, { state: "在做", reason: "开工" }, owner);

	const text = formatList(listOrders(db));
	assert.match(text, /rev/);
	assert.match(text, /T01\s+2\s+/, "rev 跟着单号在同一行");
	db.close();
});

test("动作记录带当时的版本号：这次写完之后是第几版", () => {
	const { db } = freshLedger();
	const order = createOrder(db, { title: "改看板", nextActors: ["dev"] }, owner);
	updateOrder(db, order.id, { state: "在做", reason: "开工" }, owner);

	const events = eventsOf(db, order.id, 10);
	assert.equal(events[0].revision, 2, "最近一条是开工，写完后 rev 是 2");
	assert.equal(events[1].revision, 1, "建单那条写完后 rev 是 1");
	assert.match(formatHistory(events), /rev2 owner/);
	db.close();
});

test("评论保留工单删除时的级联：单没了评论也没了", () => {
	const { db } = freshLedger();
	const order = createOrder(db, { title: "改看板", nextActors: ["dev"] }, owner);
	addComment(db, { orderId: order.id, actor: "qa", body: "看法" });
	db.exec(`DELETE FROM orders WHERE id='${order.id}'`);
	assert.equal(commentsOf(db, order.id).length, 0);
	db.close();
});
