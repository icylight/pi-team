import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { initLedger } from "../core/schema.ts";
import { createOrder, updateOrder } from "../core/store.ts";
import { buildWatchText, followsRole, loadWatchConfig, WATCH_DEFAULTS, watchConfigFile } from "../core/watch.ts";

/** 把一条单的动作记录整体往前推 N 分钟，用来造「已经等了很久」的场景 */
function agingEvent(db, orderId, minutes) {
	db.prepare("UPDATE events SET at = strftime('%Y-%m-%dT%H:%M:%fZ','now',?) WHERE order_id=?").run(
		`-${minutes} minutes`,
		orderId,
	);
}

/** 只把最后一条动作往前推：造「换了状态之后又等久了」 */
function agingLatestEvent(db, orderId, minutes) {
	db.prepare(
		`UPDATE events SET at = strftime('%Y-%m-%dT%H:%M:%fZ','now',?)
		 WHERE id = (SELECT id FROM events WHERE order_id=? ORDER BY id DESC LIMIT 1)`,
	).run(`-${minutes} minutes`, orderId);
}

function freshLedger() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-orders-watch-"));
	const dbPath = path.join(dir, "work-orders.sqlite");
	return { db: initLedger(dbPath), dir, dbPath };
}

function writeConfig(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

const base = { ...WATCH_DEFAULTS, followRole: "owner", staleMinutes: 30, repeatMinutes: 60 };

// ── 配置 ────────────────────────────────────────────

test("两份配置都不在：用默认值，且默认不跑", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-cfg-"));
	const file = path.join(dir, ".pi", "peer.json");
	const { config, problems } = loadWatchConfig(file);
	assert.deepEqual(config, WATCH_DEFAULTS);
	assert.deepEqual(problems, []);
});

test("peer.json 里没有 workOrders 一段：当没配，不报错", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-cfg-"));
	const file = path.join(dir, "peer.json");
	// peer 自己的配置照旧：只读 workOrders，不碰别人的字段
	writeConfig(file, { enabled: true, group: { name: "ipd", roles: { owner: { card: ".pi/characters/owner.md" } } } });

	const { config, problems } = loadWatchConfig(file);
	assert.deepEqual(config, WATCH_DEFAULTS);
	assert.deepEqual(problems, []);
});

test("workOrders 一段写在 peer.json 里，只认自己的字段", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-cfg-"));
	const file = path.join(dir, "peer.json");
	writeConfig(file, {
		enabled: true,
		group: { name: "ipd" },
		workOrders: { followRole: "owner", intervalMinutes: 30, staleMinutes: 45 },
	});

	const { config, problems } = loadWatchConfig(file);
	assert.equal(config.followRole, "owner");
	assert.equal(config.intervalMinutes, 30);
	assert.equal(config.staleMinutes, 45);
	assert.equal(config.repeatMinutes, 60, "没写的字段用默认");
	assert.deepEqual(problems, []);
});

test("写错的字段被忽略并报出来，不悄悄按默认值跑", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-cfg-"));
	const file = path.join(dir, "peer.json");
	writeConfig(file, { workOrders: { followRole: 42, intervalMinutes: -5, staleMinutes: "30" } });

	const { config, problems } = loadWatchConfig(file);
	assert.equal(config.followRole, "");
	assert.equal(config.intervalMinutes, WATCH_DEFAULTS.intervalMinutes);
	assert.equal(problems.length, 3, `三个字段都该报出来：${problems.join(" / ")}`);
});

test("JSON 坏掉的 peer.json 报出来，不静默当没配", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-cfg-"));
	const file = path.join(dir, "peer.json");
	writeConfig(file, "{ enabled: true }");

	const { config, problems } = loadWatchConfig(file);
	assert.deepEqual(config, WATCH_DEFAULTS);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /JSON 解析失败/);
});

test("workOrders 写成了别的类型：报出来", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-cfg-"));
	const file = path.join(dir, "peer.json");
	writeConfig(file, { workOrders: "owner" });

	const { config, problems } = loadWatchConfig(file);
	assert.deepEqual(config, WATCH_DEFAULTS);
	assert.match(problems[0], /workOrders 要写成一个对象/);
});

test("配置就写在项目的 .pi/peer.json 里", () => {
	assert.equal(watchConfigFile("/tmp/whatever"), "/tmp/whatever/.pi/peer.json");
});

test("角色匹配认实例名，不认得别的", () => {
	assert.equal(followsRole("owner", "owner"), true);
	assert.equal(followsRole("owner-2", "owner"), true, "同一个角色的第二个实例也算");
	assert.equal(followsRole("ownerx", "owner"), false, "前缀像但不是同一角色");
	assert.equal(followsRole("dev", "owner"), false);
	assert.equal(followsRole("", "owner"), false, "身份都拿不到就不跑");
	assert.equal(followsRole("owner", ""), false, "没配角色就不跑");
});

// ── 提醒文本 ────────────────────────────────────────

test("没有停滞的单：不提", () => {
	const { db } = freshLedger();
	createOrder(db, { title: "刚建的", nextActors: ["owner"] }, { actor: "owner", reason: "测试" });

	const note = buildWatchText(db, { me: "owner", config: base });
	assert.equal(note.text, "");
	db.close();
});

test("停滞的单按下一步找谁分组，等自己的排最前", () => {
	const { db } = freshLedger();
	const mine = createOrder(db, { title: "改登录页", nextActors: ["owner"] }, { actor: "owner", reason: "测试" });
	const other = createOrder(db, { title: "补单测", nextActors: ["qa"] }, { actor: "owner", reason: "测试" });
	const human = createOrder(db, { title: "定验收口径", nextActors: ["用户"] }, { actor: "owner", reason: "测试" });
	agingEvent(db, mine.id, 90);
	agingEvent(db, other.id, 50);
	agingEvent(db, human.id, 40);

	const note = buildWatchText(db, { me: "owner", config: base });
	const lines = note.text.split("\n");
	assert.match(lines[0], /这轮 3 条停滞单/);
	assert.equal(lines[1], "等你动的 1 条：");
	assert.match(lines[2], new RegExp(`${mine.id} .*改登录页`));
	assert.equal(lines[3], "等 qa 的 1 条：");
	assert.match(lines[4], new RegExp(`${other.id} .*补单测`));
	assert.equal(lines[5], "等 用户 的 1 条（人不在会话里，叫不动）：");
	assert.match(lines[6], new RegExp(`${human.id} .*定验收口径`));
	assert.match(lines.at(-1), /orders_show/);
	db.close();
});

test("同一条单在 repeat 分钟内不重复提，到点再提", () => {
	const { db } = freshLedger();
	const order = createOrder(db, { title: "改登录页", nextActors: ["owner"] }, { actor: "owner", reason: "测试" });
	agingEvent(db, order.id, 90);
	const now = Date.now();

	const first = buildWatchText(db, { me: "owner", config: base, now });
	assert.match(first.text, new RegExp(order.id));

	const soon = buildWatchText(db, { me: "owner", config: base, state: first.state, now: now + 59 * 60_000 });
	assert.equal(soon.text, "", "59 分钟后还不到再说一次的时候");

	const later = buildWatchText(db, { me: "owner", config: base, state: first.state, now: now + 61 * 60_000 });
	assert.match(later.text, new RegExp(order.id));
	db.close();
});

test("等待阶段变了就重开一轮提醒，不等 repeat", () => {
	const { db } = freshLedger();
	const order = createOrder(db, { title: "改登录页", nextActors: ["owner"] }, { actor: "owner", reason: "测试" });
	agingEvent(db, order.id, 90);
	const now = Date.now();
	const first = buildWatchText(db, { me: "owner", config: base, now });

	// 换到别的状态后又是一次新的等待：重新计时，也该重新提
	updateOrder(db, order.id, { state: "在做" }, { actor: "owner", reason: "认领" });
	updateOrder(db, order.id, { state: "待复核", nextActors: ["qa"] }, { actor: "owner", reason: "交付" });
	agingLatestEvent(db, order.id, 45);

	const again = buildWatchText(db, { me: "owner", config: base, state: first.state, now: now + 60_000 });
	assert.match(again.text, new RegExp(order.id));
	db.close();
});

test("收口的单从记录里清掉", () => {
	const { db } = freshLedger();
	const order = createOrder(db, { title: "改登录页", nextActors: ["owner"] }, { actor: "owner", reason: "测试" });
	agingEvent(db, order.id, 90);
	const first = buildWatchText(db, { me: "owner", config: base });
	assert.ok(first.state[order.id]);

	updateOrder(db, order.id, { state: "在做" }, { actor: "owner", reason: "认领" });
	updateOrder(db, order.id, { state: "待复核" }, { actor: "owner", reason: "交付" });
	updateOrder(db, order.id, { state: "已收口", closingBasis: "test/x" }, { actor: "qa", reason: "复核通过" });

	const after = buildWatchText(db, { me: "owner", config: base, state: first.state });
	assert.equal(after.text, "");
	assert.deepEqual(after.state, {}, "收口的单不留在提醒记录里");
	db.close();
});

test("一个角色名下最多列 5 条，其余折成一句", () => {
	const { db } = freshLedger();
	for (let i = 0; i < 7; i++) {
		const order = createOrder(db, { title: `第 ${i} 条`, nextActors: ["qa"] }, { actor: "owner", reason: "测试" });
		agingEvent(db, order.id, 90 + i);
	}

	const note = buildWatchText(db, { me: "owner", config: base });
	assert.match(note.text, /等 qa 的 7 条：/);
	assert.match(note.text, /另有 2 条/);
	assert.equal(note.text.split("\n").filter((line) => line.startsWith("  T")).length, 5);
	db.close();
});
