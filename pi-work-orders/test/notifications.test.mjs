import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	acknowledgeNotification,
	claimNotification,
	consumeNotification,
	deferNotification,
	listNotifications,
	notificationPath,
	openNotifications,
	reconcileNotifications,
} from "../core/notifications.ts";
import { initLedger, openLedger } from "../core/schema.ts";
import { addDep, createOrder, getOrder, updateOrder } from "../core/store.ts";

function fixture() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "notifications-"));
	const file = path.join(cwd, "work-orders.sqlite");
	const ledger = initLedger(file);
	const queueFile = notificationPath(file);
	const queue = openNotifications(queueFile);
	const order = createOrder(
		ledger,
		{ title: "合成任务", nextActors: ["dev"] },
		{ actor: "owner", reason: "合成测试" },
	);
	const sync = (at) => reconcileNotifications(ledger, queue, at);
	const rows = () => listNotifications(queue);
	const claim = (at) =>
		claimNotification(queue, rows().find((r) => r.status === "waiting" || r.status === "sending")?.id, at);
	const close = () => {
		queue.close();
		ledger.close();
	};
	return { file, queueFile, ledger, queue, order, sync, rows, claim, close };
}

test("写库后通知落盘前崩溃：恢复扫描补齐，重复扫描不重复业务或通知", () => {
	const h = fixture();
	h.close();
	const ledger = openLedger(h.file);
	const queue = openNotifications(h.queueFile);
	try {
		reconcileNotifications(ledger, queue);
		reconcileNotifications(ledger, queue);
		assert.equal(listNotifications(queue).length, 1);
		assert.equal(getOrder(ledger, h.order.id).revision, 1);
	} finally {
		queue.close();
		ledger.close();
	}
});

test("忙碌或离线保留等待，重启后重新出租；发送/接收失联不会虚报送达", () => {
	const h = fixture();
	try {
		h.sync(100);
		const first = h.claim(100);
		deferNotification(h.queue, first.id, first.lease, "目标在忙", 101);
		assert.equal(h.rows()[0].status, "waiting");
		assert.equal(h.rows()[0].attempts, 0);
		const second = h.claim(200);
		assert.equal(h.rows()[0].status, "sending");
		assert.equal(h.claim(300), undefined);
		const recovered = h.claim(20000);
		assert.notEqual(recovered.lease, second.lease);
		let count = 0;
		assert.equal(
			consumeNotification(h.ledger, h.queue, second.id, second.lease, ["dev"], () => count++, 20001).ok,
			false,
		);
		assert.equal(
			consumeNotification(h.ledger, h.queue, recovered.id, recovered.lease, ["dev"], () => count++, 20001).ok,
			true,
		);
		assert.equal(count, 1);
		assert.equal(h.rows()[0].status, "sending");
		acknowledgeNotification(h.queue, recovered.id, recovered.lease);
		assert.equal(h.rows()[0].status, "delivered");
		assert.equal(getOrder(h.ledger, h.order.id).state, "待认领");
	} finally {
		h.close();
	}
});

test("不同项目相同工单与阶段不共享通知身份，外项目租约不能消费", () => {
	const a = fixture();
	const b = fixture();
	let injected = false;
	try {
		a.sync();
		b.sync();
		const row = a.claim();
		assert.notEqual(row.id, b.rows()[0].id);
		assert.equal(
			consumeNotification(b.ledger, b.queue, row.id, row.lease, ["dev"], () => {
				injected = true;
			}).ok,
			false,
		);
		assert.equal(injected, false);
	} finally {
		a.close();
		b.close();
	}
});

test("依赖重新阻挡使旧阶段失效，真正解锁时生成有效新交接", () => {
	const h = fixture();
	try {
		h.sync();
		const old = h.claim();
		const up = createOrder(
			h.ledger,
			{ title: "合成前置", nextActors: ["qa"] },
			{ actor: "owner", reason: "合成前置" },
		);
		addDep(h.ledger, h.order.id, up.id, { actor: "owner", reason: "合成依赖" });
		h.sync();
		assert.equal(h.rows().find((n) => n.id === old.id).status, "obsolete");
		assert.equal(h.rows().filter((n) => n.orderId === h.order.id && n.status === "waiting").length, 0);
		updateOrder(h.ledger, up.id, { state: "在做" }, { actor: "qa", reason: "合成认领" });
		updateOrder(h.ledger, up.id, { state: "待复核", nextActors: ["owner"] }, { actor: "qa", reason: "合成交付" });
		updateOrder(
			h.ledger,
			up.id,
			{ state: "已收口", closingBasis: "合成证据" },
			{ actor: "owner", reason: "合成完成" },
		);
		h.sync();
		const next = h.rows().find((n) => n.orderId === h.order.id && n.status === "waiting");
		assert.ok(next);
		assert.notEqual(next.id, old.id);
	} finally {
		h.close();
	}
});

test("目标注入后重复消息或恢复扫描不再唤醒", () => {
	const h = fixture();
	try {
		h.sync();
		const row = h.claim();
		let count = 0;
		assert.equal(consumeNotification(h.ledger, h.queue, row.id, row.lease, ["dev"], () => count++).ok, true);
		assert.equal(consumeNotification(h.ledger, h.queue, row.id, row.lease, ["dev"], () => count++).ok, false);
		acknowledgeNotification(h.queue, row.id, row.lease);
		h.sync();
		assert.equal(h.claim(), undefined);
		assert.equal(count, 1);
	} finally {
		h.close();
	}
});

for (const change of ["transfer", "cancel", "claim"]) {
	test(`接收时重新核实 ${change}，旧收件箱消息不能触发动作`, () => {
		const h = fixture();
		try {
			h.sync();
			const row = h.claim();
			const patch =
				change === "transfer"
					? { nextActors: ["qa"] }
					: change === "cancel"
						? { state: "已取消", closingBasis: "合成取消" }
						: { state: "在做" };
			updateOrder(h.ledger, h.order.id, patch, { actor: "dev", reason: "合成变更" });
			let injected = false;
			assert.equal(
				consumeNotification(h.ledger, h.queue, row.id, row.lease, ["dev"], () => {
					injected = true;
				}).ok,
				false,
			);
			assert.equal(injected, false);
			h.sync();
			assert.equal(h.rows().find((n) => n.id === row.id).status, "obsolete");
			if (change === "transfer") assert.deepEqual(h.rows().find((n) => n.status === "waiting").targets, ["qa"]);
		} finally {
			h.close();
		}
	});
}

test("正文改动不重发；同状态转派后转回仍是新阶段", () => {
	const h = fixture();
	try {
		h.sync();
		const first = h.rows()[0].id;
		updateOrder(h.ledger, h.order.id, { appendBody: "合成补充" }, { actor: "owner", reason: "补文" });
		h.sync();
		assert.equal(h.rows().length, 1);
		assert.equal(h.rows()[0].id, first);
		updateOrder(h.ledger, h.order.id, { nextActors: ["qa"] }, { actor: "owner", reason: "转派" });
		updateOrder(h.ledger, h.order.id, { nextActors: ["dev"] }, { actor: "owner", reason: "转回" });
		h.sync();
		assert.notEqual(h.rows().find((n) => n.status === "waiting").id, first);
	} finally {
		h.close();
	}
});

test("注入异常或确认丢失的实际尝试有界，失败不冒充已送达", () => {
	const h = fixture();
	let count = 0;
	try {
		h.sync();
		for (let i = 0; i < 3; i++) {
			const row = h.claim();
			const result = consumeNotification(h.ledger, h.queue, row.id, row.lease, ["dev"], () => {
				count++;
				throw new Error("合成注入后确认失败");
			});
			assert.equal(result.ok, false);
		}
		assert.equal(count, 3);
		assert.equal(h.rows()[0].status, "failed");
		assert.equal(h.claim(), undefined);
		h.sync();
		assert.equal(h.rows()[0].status, "failed");
	} finally {
		h.close();
	}
});

test("API 返回但没有消息持久化确认：不记送达，恢复重试达到上限后停止", () => {
	const h = fixture();
	let count = 0;
	try {
		h.sync(0);
		for (let i = 0; i < 3; i++) {
			const at = i * 20000 + 1;
			const row = h.claim(at);
			assert.equal(consumeNotification(h.ledger, h.queue, row.id, row.lease, ["dev"], () => count++, at).ok, true);
			assert.equal(h.rows()[0].status, "sending");
			assert.equal(
				consumeNotification(h.ledger, h.queue, row.id, row.lease, ["dev"], () => count++, at + 1).ok,
				false,
			);
		}
		h.sync(60001);
		assert.equal(count, 3);
		assert.equal(h.rows()[0].status, "failed");
		assert.equal(h.claim(60001), undefined);
	} finally {
		h.close();
	}
});

test("目标提交后传输返回未知：退回 waiting 也必须在实际尝试上限后停下", () => {
	const h = fixture();
	let count = 0;
	try {
		h.sync(0);
		for (let i = 0; i < 3; i++) {
			const at = i * 20000 + 1;
			const row = h.claim(at);
			consumeNotification(h.ledger, h.queue, row.id, row.lease, ["dev"], () => count++, at);
			deferNotification(h.queue, row.id, row.lease, "传输返回未知", at + 1);
		}
		assert.equal(h.rows()[0].status, "waiting");
		h.sync(60001);
		assert.equal(count, 3);
		assert.equal(h.rows()[0].status, "failed");
		assert.equal(h.claim(60001), undefined);
	} finally {
		h.close();
	}
});

test("接收实例或租约不匹配不注入；有效性检查期间转派受写锁保护", () => {
	const h = fixture();
	const other = openLedger(h.file);
	other.exec("PRAGMA busy_timeout=1");
	try {
		h.sync();
		const row = h.claim();
		assert.equal(consumeNotification(h.ledger, h.queue, row.id, row.lease, ["qa"], () => assert.fail()).ok, false);
		assert.equal(consumeNotification(h.ledger, h.queue, row.id, "bad-lease", ["dev"], () => assert.fail()).ok, false);
		consumeNotification(h.ledger, h.queue, row.id, row.lease, ["dev"], () => {
			assert.throws(
				() => updateOrder(other, h.order.id, { nextActors: ["qa"] }, { actor: "owner", reason: "抢写" }),
				/locked|busy/,
			);
		});
		acknowledgeNotification(h.queue, row.id, row.lease);
		assert.equal(h.rows()[0].status, "delivered");
	} finally {
		other.close();
		h.close();
	}
});
