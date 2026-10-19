import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { formatOrder } from "../core/format.ts";
import { eventsOf, initLedger, openLedger, SCHEMA_VERSION } from "../core/schema.ts";
import { createOrder, getOrder, listOrders, updateOrder } from "../core/store.ts";

const actor = { actor: "owner", reason: "内容入口测试" };
function ledger() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orders-contents-"));
	const file = path.join(dir, "work-orders.sqlite");
	return { file, db: initLedger(file) };
}

test("内容入口拒绝项目外路径，失败不产生工单", () => {
	const { db } = ledger();
	try {
		assert.throws(
			() =>
				createOrder(
					db,
					{
						title: "非法路径",
						nextActors: ["dev"],
						contents: [{ name: "需求", path: "../other/需求.md" }],
					},
					actor,
				),
			/项目内.*相对.*md/,
		);
		assert.equal(listOrders(db).length, 0);
	} finally {
		db.close();
	}
});

test("建单保留多个具名内容入口与原正文，查询和详情可见", () => {
	const { db } = ledger();
	try {
		const contents = [
			{ name: "需求", path: "docs/T01/需求.md" },
			{ name: "方案", path: "docs/T01/方案.md" },
		];
		const order = createOrder(db, { title: "横向展开", body: "摘要", nextActors: ["dev"], contents }, actor);
		assert.deepEqual(order.contents, contents);
		assert.equal(order.body, "摘要");
		assert.deepEqual(listOrders(db)[0].contents, contents);
		assert.match(
			formatOrder(getOrder(db, order.id)),
			/内容入口：\n- 需求：docs\/T01\/需求.md\n- 方案：docs\/T01\/方案.md/,
		);
	} finally {
		db.close();
	}
});

for (const contents of [
	null,
	{},
	"docs/a.md",
	[null],
	[[]],
	[{}],
	[{ name: "", path: "docs/a.md" }],
	[{ name: "x\ny", path: "docs/a.md" }],
	[{ name: "需求", path: 123 }],
	[
		{ name: "需求", path: "docs/a.md" },
		{ name: " 需求 ", path: "docs/b.md" },
	],
]) {
	test(`非法内容入口拒绝写入：${JSON.stringify(contents)}`, () => {
		const { db } = ledger();
		try {
			assert.throws(() => createOrder(db, { title: "非法入口", nextActors: ["dev"], contents }, actor));
			assert.equal(listOrders(db).length, 0);
		} finally {
			db.close();
		}
	});
}

for (const file of [
	"",
	"/outside/a.md",
	"C:\\outside\\a.md",
	"C:a.md",
	"\\\\host\\share\\a.md",
	"../a.md",
	"docs/../a.md",
	"~/a.md",
	"https://host/a.md",
	"docs/a.txt",
	"docs/a.md\nmore",
]) {
	test(`非法 md 路径拒绝写入：${JSON.stringify(file)}`, () => {
		const { db } = ledger();
		try {
			assert.throws(
				() =>
					createOrder(
						db,
						{
							title: "非法路径",
							nextActors: ["dev"],
							contents: [{ name: "需求", path: file }],
						},
						actor,
					),
				/项目内.*相对.*md/,
			);
		} finally {
			db.close();
		}
	});
}

test("入口名称和相对路径规范化，不要求文件已存在", () => {
	const { db } = ledger();
	try {
		const order = createOrder(
			db,
			{
				title: "计划产物",
				nextActors: ["dev"],
				contents: [{ name: " 需求 ", path: " .\\docs\\未创建.MD " }],
			},
			actor,
		);
		assert.deepEqual(order.contents, [{ name: "需求", path: "docs/未创建.MD" }]);
	} finally {
		db.close();
	}
});

test("旧调用默认为空入口，不显示空标题；省略 contents 保留，[] 清空", () => {
	const { db } = ledger();
	try {
		const empty = createOrder(db, { title: "旧调用", nextActors: ["dev"] }, actor);
		assert.deepEqual(empty.contents, []);
		assert.doesNotMatch(formatOrder(empty), /内容入口/);
		const linked = updateOrder(
			db,
			empty.id,
			{ contents: [{ name: "方案", path: "docs/方案.md" }] },
			actor,
			empty.revision,
		);
		assert.equal(linked.revision, empty.revision + 1);
		assert.equal(eventsOf(db, empty.id)[0].kind, "field");
		const preserved = updateOrder(db, empty.id, { title: "新标题" }, actor, linked.revision);
		assert.deepEqual(preserved.contents, linked.contents);
		const cleared = updateOrder(db, empty.id, { contents: [] }, actor, preserved.revision);
		assert.deepEqual(cleared.contents, []);
		assert.equal(eventsOf(db, empty.id)[0].kind, "field");
	} finally {
		db.close();
	}
});

test("内容入口与正文及状态同事务；失败和版本冲突不改变数据或事件", () => {
	const { db } = ledger();
	try {
		const order = createOrder(db, { title: "原单", body: "原正文", nextActors: ["dev"] }, actor);
		const history = eventsOf(db, order.id);
		for (const patch of [
			{ contents: null, title: "不能落库", appendBody: "不能追加" },
			{ contents: [{ name: "需求", path: "docs/a.md" }], state: "已收口", appendBody: "不能追加" },
		]) {
			assert.throws(() => updateOrder(db, order.id, patch, actor, order.revision));
			assert.deepEqual(getOrder(db, order.id), order);
			assert.deepEqual(eventsOf(db, order.id), history);
		}
		const changed = updateOrder(
			db,
			order.id,
			{
				contents: [{ name: "需求", path: "docs/a.md" }],
				appendBody: "补充",
				state: "在做",
			},
			{ actor: "dev", reason: "接单并补内容" },
			order.revision,
		);
		assert.match(changed.body, /原正文\n\n补充/);
		assert.equal(changed.contents.length, 1);
		assert.equal(changed.state, "在做");
		assert.equal(changed.revision, order.revision + 1);
		assert.throws(() => updateOrder(db, order.id, { contents: [] }, actor, order.revision), /版本冲突/);
		assert.deepEqual(getOrder(db, order.id), changed);
	} finally {
		db.close();
	}
});

test("读取后发生并发修改，SQL 版本校验阻止覆盖内容列表", () => {
	const { db, file } = ledger();
	const other = openLedger(file);
	const originalExec = db.exec.bind(db);
	let interleaved = false;
	try {
		const order = createOrder(db, { title: "并发", nextActors: ["dev"] }, actor);
		db.exec = (sql) => {
			if (sql === "BEGIN IMMEDIATE;" && !interleaved) {
				interleaved = true;
				updateOrder(
					other,
					order.id,
					{ contents: [{ name: "先写入", path: "docs/先写入.md" }] },
					actor,
					order.revision,
				);
			}
			return originalExec(sql);
		};
		assert.throws(
			() =>
				updateOrder(
					db,
					order.id,
					{
						contents: [{ name: "后写入", path: "docs/后写入.md" }],
						appendBody: "不能追加",
					},
					actor,
					order.revision,
				),
			/版本冲突/,
		);
		assert.deepEqual(getOrder(db, order.id).contents, [{ name: "先写入", path: "docs/先写入.md" }]);
		assert.equal(getOrder(db, order.id).body, "");
		assert.equal(getOrder(db, order.id).revision, order.revision + 1);
		assert.equal(eventsOf(db, order.id).length, 2);
	} finally {
		db.exec = originalExec;
		other.close();
		db.close();
	}
});

test("v3 升级仅加空入口，正文、状态、依赖、事件及版本号保持", () => {
	const { db, file } = ledger();
	const up = createOrder(db, { title: "上游", nextActors: ["dev"] }, actor);
	const down = createOrder(db, { title: "旧数据", body: "原正文", nextActors: ["qa"], dependsOn: [up.id] }, actor);
	const history = eventsOf(db, down.id);
	// 退回 v3 结构：只保留 v3 之前的列。新增列要一并退掉，
	// 否则之后的 ADD COLUMN 会撞上已存在的列。
	db.exec("ALTER TABLE orders DROP COLUMN contents;");
	for (const column of [
		"type",
		"estimate_active_min",
		"estimate_wall_min",
		"estimate_basis",
		"actual_active_min",
		"actual_wall_min",
		"actual_wait_min",
		"delivery_variance",
		"placeholder_basis",
		"content_lock",
	]) {
		db.exec(`ALTER TABLE orders DROP COLUMN ${column};`);
	}
	db.exec("PRAGMA user_version=3;");
	db.close();
	assert.throws(() => openLedger(file, true), /只读/);
	const reopened = openLedger(file);
	try {
		assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
		assert.deepEqual(getOrder(reopened, down.id), down);
		assert.deepEqual(eventsOf(reopened, down.id), history);
	} finally {
		reopened.close();
	}
	const readOnly = openLedger(file, true);
	assert.deepEqual(getOrder(readOnly, down.id).contents, []);
	readOnly.close();
});

test("数据库约束拒绝非法 JSON 与非数组 contents", () => {
	const { db } = ledger();
	try {
		const order = createOrder(db, { title: "约束", nextActors: ["dev"] }, actor);
		for (const value of ["not-json", "{}", "null", '"string"']) {
			assert.throws(() => db.prepare("UPDATE orders SET contents=? WHERE id=?").run(value, order.id));
		}
		assert.deepEqual(getOrder(db, order.id).contents, []);
	} finally {
		db.close();
	}
});
