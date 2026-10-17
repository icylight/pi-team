// AI(TAG): [耐久交接] 台账是业务真相，通知记录只描述交接阶段与注入结果，不改业务状态。
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { waitingOrders } from "./store.ts";
import { isHumanActor } from "./types.ts";

export const NOTIFICATION_PROTOCOL = 1;
const LEASE_MS = 15_000;
/**
 * 注入尝试上限：只记「提交了注入但没确认成功」的次数。
 *
 * 目标在忙时退回等待不算尝试——那是最常见的正常状态，算进去会让活跃会话收不到交接。
 * 重投本身不再无限：peer 侧对同一 handoff.id 在收件箱里只留一条，忙的时候消息不堆。
 */
const MAX_ATTEMPTS = 3;

export interface Handoff {
	id: string;
	orderId: string;
	targets: string[];
	text: string;
}
export interface Notification extends Handoff {
	status: "waiting" | "sending" | "delivered" | "obsolete" | "failed";
	attempts: number;
	reason: string;
	lease: string | null;
	leaseUntil: number;
}

export function notificationPath(ledgerPath: string): string {
	return path.join(path.dirname(ledgerPath), "notifications.sqlite");
}

export function openNotifications(file: string, readOnly = false): DatabaseSync {
	const db = new DatabaseSync(file, { readOnly });
	if (readOnly) return db;
	db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
	db.exec(`CREATE TABLE IF NOT EXISTS notifications (
		id TEXT PRIMARY KEY, order_id TEXT NOT NULL, targets TEXT NOT NULL,
		text TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
		reason TEXT NOT NULL DEFAULT '', lease TEXT, submitted_lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
	);`);
	return db;
}

/** 用交接事件而非行 revision 标识阶段；正文修改不重发，转派和依赖变化产生新身份。 */
export function handoffSnapshot(ledger: DatabaseSync): Handoff[] {
	const file = ledger
		.prepare("PRAGMA database_list")
		.all()
		.find((db) => db.name === "main")?.file;
	const project = file ? realpathSync(String(file)) : "memory";
	return waitingOrders(ledger)
		.filter((w) => w.kind !== "dependency")
		.flatMap((w) => {
			const order = w.order;
			const stage = ledger
				.prepare(
					"SELECT id,actor FROM events WHERE order_id=? AND kind IN ('create','state','handoff') ORDER BY id DESC LIMIT 1",
				)
				.get(order.id) as { id: number; actor: string } | undefined;
			const targets = order.nextActors.filter((name) => !isHumanActor(name) && name !== stage?.actor);
			if (!targets.length) return [];
			const edges = ledger
				.prepare(`SELECT id FROM events WHERE
			(order_id=? AND kind IN ('dep-add','dep-remove')) OR
			(order_id IN (SELECT depends_on FROM deps WHERE order_id=?) AND kind IN ('create','state')) ORDER BY id`)
				.all(order.id, order.id);
			const signature = JSON.stringify([
				project,
				order.id,
				order.state,
				order.nextActors,
				w.kind,
				stage?.id ?? order.createdAt,
				edges,
			]);
			const id = createHash("sha256").update(signature).digest("hex");
			return [
				{
					id,
					orderId: order.id,
					targets,
					// 只带定位与「去读哪」：正文与现场（依赖、上游产物、能否占位）都在 orders_show，
					// 塞进通知会让同一份内容两处存在，且随现场变化反复重发。
					text: `【工单交接 ${order.id}】${order.title}\n状态：${order.state}；下一步：${order.nextActors.join("、")}\n请先用 orders_show 核实现状（含当前依赖、上游产物、能否占位、是否需重读），再认领或处理；收到通知不等于已认领。`,
				},
			];
		});
}

function fromRow(row: Record<string, unknown>): Notification {
	return {
		id: String(row.id),
		orderId: String(row.order_id),
		targets: JSON.parse(String(row.targets)),
		text: String(row.text),
		status: row.status as Notification["status"],
		attempts: Number(row.attempts),
		reason: String(row.reason),
		lease: row.lease == null ? null : String(row.lease),
		leaseUntil: Number(row.lease_until),
	};
}

export function listNotifications(db: DatabaseSync, orderId?: string): Notification[] {
	const rows = orderId
		? db.prepare("SELECT * FROM notifications WHERE order_id=? ORDER BY updated_at,created_at,id").all(orderId)
		: db.prepare("SELECT * FROM notifications ORDER BY updated_at,created_at,id").all();
	return rows.map((row) => fromRow(row));
}

/** 重建通知缺口，不重放业务操作。多个会话同时扫描也只产生同一阶段的一条记录。 */
export function reconcileNotifications(ledger: DatabaseSync, queue: DatabaseSync, at = Date.now()): void {
	const current = handoffSnapshot(ledger);
	const ids = new Set(current.map((h) => h.id));
	queue.exec("BEGIN IMMEDIATE");
	try {
		for (const old of listNotifications(queue)) {
			if (!ids.has(old.id) && old.status !== "delivered" && old.status !== "obsolete") {
				queue
					.prepare(
						"UPDATE notifications SET status='obsolete',reason='交接已转派、取消或被新阶段取代',lease=NULL,updated_at=? WHERE id=?",
					)
					.run(at, old.id);
			}
		}
		for (const h of current) {
			queue
				.prepare(`INSERT INTO notifications(id,order_id,targets,text,status,created_at,updated_at)
				VALUES(?,?,?,?,'waiting',?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text`)
				.run(h.id, h.orderId, JSON.stringify(h.targets), h.text, at, at);
		}
		queue
			.prepare(
				"UPDATE notifications SET status='failed',reason='注入确认丢失或失败已达重试上限，结果未知；须人工核实',lease=NULL,updated_at=? WHERE status IN ('sending','waiting') AND attempts>=? AND lease_until<=?",
			)
			.run(at, MAX_ATTEMPTS, at);
		queue.exec("COMMIT");
	} catch (error) {
		queue.exec("ROLLBACK");
		throw error;
	}
}

export function claimNotification(queue: DatabaseSync, id: string, at = Date.now()): Notification | undefined {
	const lease = randomUUID();
	const result = queue
		.prepare(`UPDATE notifications SET status='sending',reason='租约已发放，等待目标会话持久化确认',lease=?,lease_until=?,updated_at=?
		WHERE id=? AND attempts<? AND (status='waiting' OR (status='sending' AND lease_until<=?))`)
		.run(lease, at + LEASE_MS, at, id, MAX_ATTEMPTS, at);
	if (!Number(result.changes)) return undefined;
	return listNotifications(queue).find((n) => n.id === id);
}

export function deferNotification(
	queue: DatabaseSync,
	id: string,
	lease: string,
	reason: string,
	at = Date.now(),
): void {
	queue
		.prepare(
			"UPDATE notifications SET status='waiting',reason=?,lease=NULL,lease_until=0,updated_at=? WHERE id=? AND lease=? AND status='sending'",
		)
		.run(reason, at, id, lease);
}

/** 持久消息已确认后调用；首次确认当前租约才返回 true, 用于避免重复唤醒。 */
export function acknowledgeNotification(queue: DatabaseSync, id: string, lease: string, at = Date.now()): boolean {
	const result = queue
		.prepare(
			"UPDATE notifications SET status='delivered',reason='已持久化到目标会话，不代表已认领',lease=NULL,updated_at=? WHERE id=? AND lease=? AND status='sending'",
		)
		.run(at, id, lease);
	return Number(result.changes) === 1;
}

/** 校验到同步注入之间持有业务库写锁；复用已有持久消息只补确认，不计作新注入。 */
export function consumeNotification(
	ledger: DatabaseSync,
	queue: DatabaseSync,
	id: string,
	lease: string,
	identities: string[],
	deliver: () => void,
	at = Date.now(),
	alreadyPersisted = false,
): { ok: boolean; detail: string } {
	ledger.exec("BEGIN IMMEDIATE");
	try {
		const current = handoffSnapshot(ledger).find((h) => h.id === id);
		if (!current || !current.targets.some((target) => identities.includes(target)))
			return { ok: false, detail: "交接已失效或不属于当前实例" };
		const attempt = queue
			.prepare(`UPDATE notifications SET attempts=attempts+?,submitted_lease=?,reason='已提交会话写入，等待持久化确认',updated_at=?
			WHERE id=? AND status='sending' AND lease=? AND lease_until>? AND attempts<? AND submitted_lease IS NOT ?`)
			.run(alreadyPersisted ? 0 : 1, lease, at, id, lease, at, MAX_ATTEMPTS, lease);
		if (!Number(attempt.changes)) return { ok: false, detail: "通知已处理、租约过期或重试已达上限" };
		try {
			deliver();
			return { ok: true, detail: "已提交注入，等待会话消息持久化确认" };
		} catch (error) {
			queue
				.prepare(`UPDATE notifications SET status=CASE WHEN attempts>=? THEN 'failed' ELSE 'waiting' END,
				reason=?,lease=NULL,lease_until=0,updated_at=? WHERE id=? AND lease=?`)
				.run(MAX_ATTEMPTS, `注入失败或结果未知：${String(error)}`, at, id, lease);
			return { ok: false, detail: "注入失败，未记为送达" };
		}
	} finally {
		ledger.exec("ROLLBACK");
	}
}
