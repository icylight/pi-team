/** 依赖等待是派生视图；解锁起点从现有事件推导，不写库或新增状态。 */
import type { DatabaseSync } from "node:sqlite";
import { enteredStateAt, roleOf, stateOf } from "./schema.ts";
import type { DependencyBlocker, Order, Waiting } from "./types.ts";

type EdgeEvent = { id: number; kind: string; note: string; at: string };
type Interval = { dep: string; start?: EdgeEvent; end?: EdgeEvent };
type Upstream = { id: string; state: string; updated_at: string };

function later(a: string, b: string): string {
	return Date.parse(b) > Date.parse(a) ? b : a;
}

/** 同一条依赖可被删除后再加回；保留每段区间，避免删除已完成前置时丢掉旧解锁点。 */
function dependencyIntervals(db: DatabaseSync, order: Order, current: Upstream[]): Interval[] {
	const events = db
		.prepare("SELECT id,kind,note,at FROM events WHERE order_id=? AND kind IN ('dep-add','dep-remove') ORDER BY id")
		.all(order.id) as EdgeEvent[];
	const open = new Map<string, EdgeEvent>();
	const intervals: Interval[] = [];
	for (const event of events) {
		if (event.kind === "dep-add") open.set(event.note, event);
		else {
			intervals.push({ dep: event.note, start: open.get(event.note), end: event });
			open.delete(event.note);
		}
	}
	for (const upstream of current) intervals.push({ dep: upstream.id, start: open.get(upstream.id) });
	return intervals;
}

function releasedAt(db: DatabaseSync, order: Order, interval: Interval): string | undefined {
	const completed = db
		.prepare("SELECT id,at FROM events WHERE order_id=? AND to_state=? ORDER BY id DESC LIMIT 1")
		.get(interval.dep, stateOf(db, "done")) as { id: number; at: string } | undefined;
	if (completed) {
		// 事件序号判先后，避免同一毫秒的完成、加依赖被误认为一次新的阻塞。
		if (interval.start ? completed.id < interval.start.id : Date.parse(completed.at) <= Date.parse(order.createdAt)) {
			return undefined;
		}
		return interval.end && completed.id > interval.end.id ? interval.end.at : completed.at;
	}
	const upstream = db.prepare("SELECT state,updated_at FROM orders WHERE id=?").get(interval.dep) as
		| Upstream
		| undefined;
	if (upstream?.state === stateOf(db, "done")) {
		// 旧库没有完成事件时保守用行时间；不补造过去的解锁事件。
		if (Date.parse(upstream.updated_at) <= Date.parse(interval.start?.at ?? order.createdAt)) return undefined;
		return interval.end && Date.parse(interval.end.at) < Date.parse(upstream.updated_at)
			? interval.end.at
			: upstream.updated_at;
	}
	return interval.end?.at;
}

/**
 * 当前这组未完成前置从何时开始挡着。
 *
 * 换依赖边（删旧加新）不该让「等了两小时」这样的读数继续指向旧前置：T406 的实测是
 * 删 T414、加 T418 之后仍从建单算，报「等依赖 3.6h」，而实际等 T418 只有 12m。
 *
 * 取三者的较晚者：进入当前状态的时刻、当前每个未完成前置的加边时刻、最近一次删边时刻。
 */
function blockingSetSince(db: DatabaseSync, order: Order, entered: string, current: Upstream[]): string {
	const unfinished = current.filter((up) => up.state !== stateOf(db, "done"));
	let since = entered;
	const addAt = db.prepare(
		"SELECT at FROM events WHERE order_id=? AND kind='dep-add' AND note=? ORDER BY id DESC LIMIT 1",
	);
	for (const up of unfinished) {
		const row = addAt.get(order.id, up.id) as { at: string } | undefined;
		if (row) since = later(since, row.at);
	}
	// 删边本身也改变了这组前置：同一次交接里删旧加新时，以更晚的那步为准
	const removedAt = db
		.prepare("SELECT at FROM events WHERE order_id=? AND kind='dep-remove' ORDER BY id DESC LIMIT 1")
		.get(order.id) as { at: string } | undefined;
	if (removedAt) since = later(since, removedAt.at);
	return since;
}

export function describeWaiting(db: DatabaseSync, order: Order): Waiting {
	const entered = enteredStateAt(db, order.id, order.state) ?? order.updatedAt;
	const current = db
		.prepare(
			"SELECT up.id,up.state,up.updated_at FROM deps d JOIN orders up ON up.id=d.depends_on WHERE d.order_id=? ORDER BY up.id",
		)
		.all(order.id) as Upstream[];
	const done = stateOf(db, "done");
	const cancelled = stateOf(db, "cancelled");
	const dependencies: DependencyBlocker[] = current
		.filter((up) => up.state !== done)
		.map((up) => ({
			id: up.id,
			state: up.state,
			cancelled: up.state === cancelled,
		}));
	const cancelledDeps = current.filter((up) => up.state === cancelled);
	if (cancelledDeps.length) {
		const firstCancellation = cancelledDeps
			.map((up) => {
				const added = db
					.prepare("SELECT at FROM events WHERE order_id=? AND kind='dep-add' AND note=? ORDER BY id DESC LIMIT 1")
					.get(order.id, up.id) as { at: string } | undefined;
				const cancelledAt = enteredStateAt(db, up.id, cancelled) ?? up.updated_at;
				return added ? later(cancelledAt, added.at) : cancelledAt;
			})
			.reduce((a, b) => (Date.parse(a) < Date.parse(b) ? a : b));
		return { order, kind: "decision", dependencies, since: later(entered, firstCancellation) };
	}
	const role = roleOf(db, order.state);
	const execution = role === "claimable" || role === "rework";
	if (execution && dependencies.length) {
		// 起点跟当前这组前置走，不是无条件用「进入状态的时刻」：换过依赖边之后，
		// 旧前置的时长不该继续算在新前置头上。
		const since = blockingSetSince(db, order, entered, current);
		return since === entered
			? { order, kind: "dependency", dependencies, since }
			: { order, kind: "dependency", dependencies, since, blockedSince: entered };
	}
	let since = entered;
	if (execution) {
		for (const interval of dependencyIntervals(db, order, current)) {
			const released = releasedAt(db, order, interval);
			if (released) since = later(since, released);
		}
	}
	return { order, kind: "action", dependencies, since };
}
