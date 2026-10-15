import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { observePeers } from "../../pi-peer/observe.ts";
import { BUSY_STALE_MS, cwdKey, STALE_MS } from "../../pi-peer/store.ts";
import { readDispatch } from "../core/dispatch.ts";
import {
	acknowledgeNotification,
	claimNotification,
	notificationPath,
	openNotifications,
	reconcileNotifications,
} from "../core/notifications.ts";
import { eventsOf, initLedger, openLedger } from "../core/schema.ts";
import { addDep, createOrder, getOrder, updateOrder } from "../core/store.ts";

const at = 10_000_000;
function fixture() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-test-"));
	const cwd = path.join(base, "project");
	const root = path.join(base, "peers");
	fs.mkdirSync(cwd);
	const members = path.join(root, cwdKey(cwd), "members");
	const put = (key, extra = {}) => {
		fs.mkdirSync(members, { recursive: true });
		fs.writeFileSync(
			path.join(members, `${key}.json`),
			JSON.stringify({
				key,
				name: key,
				role: "dev",
				roleSlot: key,
				pid: process.pid,
				cwd,
				lastSeen: at - 1,
				busy: false,
				...extra,
			}),
		);
	};
	return { base, cwd, root, members, put };
}
function ledgerFixture() {
	const h = fixture();
	const file = path.join(h.cwd, ".work-orders", "work-orders.sqlite");
	initLedger(file);
	const db = openLedger(file);
	const order = createOrder(
		db,
		{ title: "合成调度任务", nextActors: ["dev"] },
		{ actor: "owner", reason: "合成数据" },
	);
	return { ...h, file, db, order };
}

test("只读观察保留过期/损坏注册，不把缺失、过期或未知忙闲显示为空闲", () => {
	const h = fixture();
	h.put("dev");
	h.put("dev-2", { busy: true, busySince: at - 100 });
	h.put("stale", { lastSeen: at - STALE_MS });
	h.put("unknown", { busy: undefined });
	h.put("old-busy", { busy: true, busySince: at - BUSY_STALE_MS });
	h.put("future", { lastSeen: Number.MAX_VALUE });
	h.put("dead", { pid: 1234 });
	h.put("foreign", { cwd: path.join(h.base, "foreign") });
	fs.writeFileSync(path.join(h.members, "broken.json"), "synthetic-invalid-json");
	const before = fs.readdirSync(h.members).sort();
	const view = observePeers(h.root, h.cwd, at, (pid) => (pid === 1234 ? "dead" : "alive"));
	assert.equal(view.state, "partial");
	assert.deepEqual(Object.fromEntries(view.sessions.map((s) => [s.name, s.status])), {
		dead: "offline",
		dev: "idle",
		"dev-2": "busy",
		future: "unknown",
		"old-busy": "unknown",
		stale: "stale",
		unknown: "unknown",
	});
	assert.equal(view.sessions.find((s) => s.name === "future").lastSeen, undefined);
	assert.deepEqual(fs.readdirSync(h.members).sort(), before);
	assert.equal(
		view.sessions.some((s) => s.name === "foreign"),
		false,
	);
});

test("注册目录缺失不会创建目录，未知存活与不可信文件也不冒充可接", () => {
	const h = fixture();
	assert.equal(observePeers(h.root, h.cwd, at).state, "missing");
	assert.equal(fs.existsSync(h.root), false);
	h.put("dev");
	assert.equal(observePeers(h.root, h.cwd, at, () => "unknown").sessions[0].status, "unknown");
	const target = path.join(h.base, "synthetic.json");
	fs.writeFileSync(target, "{}");
	fs.symlinkSync(target, path.join(h.members, "linked.json"));
	assert.equal(observePeers(h.root, h.cwd, at, () => "alive").state, "partial");
	assert.equal(fs.lstatSync(path.join(h.members, "linked.json")).isSymbolicLink(), true);
});

test("联合投影区分基础角色候选与实例负载；ready 不因会话忙而改变", () => {
	const h = ledgerFixture();
	try {
		h.put("dev", { busy: true, busySince: at - 10 });
		h.put("dev-2");
		const active = createOrder(
			h.db,
			{ title: "合成在做", nextActors: ["dev-2"] },
			{ actor: "owner", reason: "合成数据" },
		);
		updateOrder(h.db, active.id, { state: "在做" }, { actor: "dev-2", reason: "合成认领" });
		const view = readDispatch(h.db, h.file, h.cwd, h.root, at);
		const order = view.orders.find((o) => o.id === h.order.id);
		assert.equal(order.ready, true);
		assert.equal(order.readiness, "依赖就绪，可接手");
		assert.deepEqual(order.actors[0].sessions.map((s) => s.name).sort(), ["dev-2", "dev"].sort());
		assert.deepEqual(view.sessions.find((s) => s.name === "dev").activeOrders, []);
		assert.deepEqual(view.sessions.find((s) => s.name === "dev-2").activeOrders, [active.id]);
		assert.equal(view.orders.find((o) => o.id === active.id).readiness, "依赖就绪，非待接手阶段");
	} finally {
		h.db.close();
	}
});

test("读看板不生成通知库、不迁移/更改业务事件，也不清理过期会话", () => {
	const h = ledgerFixture();
	h.put("stale", { lastSeen: at - STALE_MS });
	const history = eventsOf(h.db, h.order.id);
	const row = getOrder(h.db, h.order.id);
	const reader = openLedger(h.file, true);
	try {
		const view = readDispatch(reader, h.file, h.cwd, h.root, at);
		assert.equal(view.notificationSource, "missing");
		assert.equal(view.orders[0].notification.expected, true);
		assert.equal(fs.existsSync(notificationPath(h.file)), false);
		assert.equal(fs.existsSync(path.join(h.members, "stale.json")), true);
		assert.deepEqual(eventsOf(h.db, h.order.id), history);
		assert.deepEqual(getOrder(h.db, h.order.id), row);
	} finally {
		reader.close();
		h.db.close();
	}
});

test("转派后历史 delivered 不冒充新阶段已送达；损坏通知库单独显示未知", () => {
	const h = ledgerFixture();
	const queue = openNotifications(notificationPath(h.file));
	try {
		reconcileNotifications(h.db, queue);
		const row = claimNotification(queue, queue.prepare("SELECT id FROM notifications").get().id);
		acknowledgeNotification(queue, row.id, row.lease);
		updateOrder(h.db, h.order.id, { nextActors: ["qa"] }, { actor: "owner", reason: "合成转派" });
		const view = readDispatch(h.db, h.file, h.cwd, h.root, at);
		assert.equal(view.orders[0].notification.current, undefined);
		assert.equal(view.orders[0].notification.previous.status, "delivered");
		assert.equal(view.orders[0].notification.expected, true);
	} finally {
		queue.close();
		h.db.close();
	}
	const bad = ledgerFixture();
	fs.writeFileSync(notificationPath(bad.file), "synthetic-not-a-db");
	try {
		const view = readDispatch(bad.db, bad.file, bad.cwd, bad.root, at);
		assert.equal(view.notificationSource, "error");
		assert.equal(view.orders[0].ready, true);
	} finally {
		bad.db.close();
	}
});

test("依赖阻挡、人工作业和无匹配会话保持各自语义，不改 ready", () => {
	const h = ledgerFixture();
	try {
		const human = createOrder(h.db, { title: "人工", nextActors: ["用户"] }, { actor: "owner", reason: "合成数据" });
		const other = createOrder(
			h.db,
			{ title: "无角色实例", nextActors: ["qa"] },
			{ actor: "owner", reason: "合成数据" },
		);
		addDep(h.db, h.order.id, other.id, { actor: "owner", reason: "合成依赖" });
		const view = readDispatch(h.db, h.file, h.cwd, h.root, at);
		assert.equal(view.orders.find((o) => o.id === h.order.id).ready, false);
		assert.match(view.orders.find((o) => o.id === h.order.id).readiness, /等依赖/);
		updateOrder(
			h.db,
			other.id,
			{ state: "已取消", closingBasis: "合成取消" },
			{ actor: "owner", reason: "合成取消" },
		);
		assert.equal(
			readDispatch(h.db, h.file, h.cwd, h.root, at).orders.find((o) => o.id === h.order.id).readiness,
			"前置取消，需裁定",
		);
		assert.equal(view.peers.state, "missing");
		assert.equal(view.orders.find((o) => o.id === human.id).actors[0].human, true);
		assert.equal(view.orders.find((o) => o.id === other.id).ready, true);
		assert.deepEqual(view.orders.find((o) => o.id === other.id).actors[0].sessions, []);
	} finally {
		h.db.close();
	}
});
