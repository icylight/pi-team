import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { formatList, formatOrder } from "../core/format.ts";
import { initLedger, openLedger, SCHEMA_VERSION, setMeta, typesOf } from "../core/schema.ts";
import { createOrder, getOrder, listHint, listOrders, updateOrder } from "../core/store.ts";
import { DEFAULT_TYPES } from "../core/types.ts";

const owner = { actor: "owner", reason: "测试" };

function freshLedger(options = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-orders-type-"));
	const dbPath = path.join(dir, "work-orders.sqlite");
	const db = initLedger(dbPath, options);
	return { db, dir, dbPath };
}

test("默认类型枚举是三种，建单不填类型就是未分类", () => {
	const { db } = freshLedger();
	assert.deepEqual(typesOf(db), [...DEFAULT_TYPES]);
	const order = createOrder(db, { title: "没分类", nextActors: ["dev"] }, owner);
	assert.equal(order.type, null);
	db.close();
});

test("建单写枚举内的类型能落库，读回来一致", () => {
	const { db } = freshLedger();
	const order = createOrder(db, { title: "改看板", nextActors: ["dev"], type: "实施单" }, owner);
	assert.equal(order.type, "实施单");
	assert.equal(getOrder(db, order.id).type, "实施单");
	db.close();
});

test("枚举外的类型在写入前被拦下，不产生第 N 种分类", () => {
	const { db } = freshLedger();
	assert.throws(
		() => createOrder(db, { title: "拼错类型", nextActors: ["dev"], type: "实施" }, owner),
		/未知工单类型：实施（当前类型枚举：需求单 \/ 实施单 \/ bug 单）/,
	);
	assert.equal(listOrders(db, { history: true }).length, 0);
	db.close();
});

test("建库时可覆盖类型枚举，之后按配置校验", () => {
	const { db } = freshLedger({ types: ["故事", "缺陷"] });
	assert.deepEqual(typesOf(db), ["故事", "缺陷"]);
	const order = createOrder(db, { title: "带故事", nextActors: ["dev"], type: "故事" }, owner);
	assert.equal(order.type, "故事");
	assert.throws(
		() => createOrder(db, { title: "默认枚举已失效", nextActors: ["dev"], type: "需求单" }, owner),
		/未知工单类型/,
	);
	db.close();
});

test("配成空数组表示不分类：任何类型都不合法", () => {
	const { db } = freshLedger({ types: [] });
	assert.deepEqual(typesOf(db), []);
	assert.throws(
		() => createOrder(db, { title: "还是写了", nextActors: ["dev"], type: "需求单" }, owner),
		/未配置类型/,
	);
	const order = createOrder(db, { title: "不分类", nextActors: ["dev"] }, owner);
	assert.equal(order.type, null);
	db.close();
});

test("改类型留在动作记录里，传 null 清空", () => {
	const { db } = freshLedger();
	const order = createOrder(db, { title: "先不分", nextActors: ["dev"] }, owner);
	const typed = updateOrder(db, order.id, { type: "bug 单" }, { actor: "owner", reason: "归到缺陷" });
	assert.equal(typed.type, "bug 单");
	const cleared = updateOrder(db, order.id, { type: null }, { actor: "owner", reason: "分错了" });
	assert.equal(cleared.type, null);
	const kinds = db
		.prepare("SELECT kind FROM events WHERE order_id=? ORDER BY id")
		.all(order.id)
		.map((r) => r.kind);
	assert.deepEqual(kinds, ["create", "field", "field"]);
	db.close();
});

test("不改类型时保留原值（只补别的字段）", () => {
	const { db } = freshLedger();
	const order = createOrder(db, { title: "带类型", nextActors: ["dev"], type: "需求单" }, owner);
	const updated = updateOrder(db, order.id, { title: "改个标题" }, { actor: "owner", reason: "标题写错了" });
	assert.equal(updated.type, "需求单");
	db.close();
});

test("按类型筛：命中、枚举外报错、空结果给提示", () => {
	const { db } = freshLedger();
	createOrder(db, { title: "需求", nextActors: ["dev"], type: "需求单" }, owner);
	createOrder(db, { title: "缺陷修复", nextActors: ["dev"], type: "bug 单" }, owner);
	createOrder(db, { title: "没分类", nextActors: ["dev"] }, owner);

	assert.deepEqual(
		listOrders(db, { type: "bug 单" }).map((o) => o.title),
		["缺陷修复"],
	);
	assert.throws(() => listOrders(db, { type: "文档" }), /未知工单类型/);
	assert.match(listHint(db, { type: "需求单", state: "已收口" }), /没有匹配的工单/);
	db.close();
});

test("meta.types 写坏形状就报错，不静默退回默认值", () => {
	const { db } = freshLedger();
	setMeta(db, "types", "需求单,实施单");
	assert.throws(() => typesOf(db), /meta.types 要写成字符串数组/);
	assert.throws(() => createOrder(db, { title: "带类型", nextActors: ["dev"], type: "需求单" }, owner), /字符串数组/);
	setMeta(db, "types", ["需求单", 42]);
	assert.throws(() => typesOf(db), /字符串数组/);
	db.close();
});

test("可开工筛选与类型筛选能叠用", () => {
	const { db } = freshLedger();
	createOrder(db, { title: "缺陷待修", nextActors: ["dev"], type: "bug 单" }, owner);
	createOrder(db, { title: "需求待做", nextActors: ["dev"], type: "需求单" }, owner);
	assert.deepEqual(
		listOrders(db, { ready: true, type: "bug 单" }).map((o) => o.title),
		["缺陷待修"],
	);
	db.close();
});

test("库内改配置后，新类型立刻生效（meta.types）", () => {
	const { db } = freshLedger();
	setMeta(db, "types", ["需求单", "实施单", "bug 单", "调研"]);
	const order = createOrder(db, { title: "先调研", nextActors: ["dev"], type: "调研" }, owner);
	assert.equal(order.type, "调研");
	db.close();
});

test("列表与详情都带出类型", () => {
	const { db } = freshLedger();
	const order = createOrder(db, { title: "带类型的单", nextActors: ["dev"], type: "实施单" }, owner);
	assert.match(formatList(listOrders(db)), /类型/);
	assert.match(formatList(listOrders(db)), /实施单/);
	assert.match(formatOrder(getOrder(db, order.id)), /类型：实施单｜状态：/);
	db.close();
});

test("v5 的库升级后类型列为空，旧单不受影响", () => {
	const { db, dbPath } = freshLedger();
	createOrder(db, { title: "老数据", nextActors: ["dev"] }, owner);
	// 退回 v5 结构：退掉 v5 之后加的列（v6 的类型、v7 的内容锁）
	db.exec("ALTER TABLE orders DROP COLUMN type;");
	db.exec("ALTER TABLE orders DROP COLUMN content_lock;");
	db.exec("PRAGMA user_version=5;");
	db.close();

	const reopened = openLedger(dbPath);
	try {
		assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
		assert.equal(getOrder(reopened, "T01").type, null);
		const typed = createOrder(reopened, { title: "新数据", nextActors: ["dev"], type: "bug 单" }, owner);
		assert.equal(typed.type, "bug 单");
	} finally {
		reopened.close();
	}
});
