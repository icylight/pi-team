/**
 * 工单台账的核心操作：增、改、依赖、校验、视图。
 *
 * AI(TAG): [工单等待] 区分可处理等待、依赖等待与取消依赖的人工裁定。
 *
 * 不 import 任何 pi 的东西。所有写操作都要 ActorContext（谁改的 + 理由），
 * 理由是必填——状态变更不写原因，事后没人知道为什么动。
 *
 * 「下一步找谁」是有序候选数组：第一个是首选，后面是首选不在时的备选。
 * 进入「在做」时收敛成单人，因为执行者只能有一个。
 */

import type { DatabaseSync } from "node:sqlite";
import { normalizeContents } from "./contents.ts";
import {
	enteredStateAt,
	getMeta,
	idPrefixOf,
	isTerminal,
	isWaitingState,
	logEvent,
	now,
	roleOf,
	setMeta,
	stateOf,
	statesOf,
	transitionsOf,
} from "./schema.ts";
import {
	type ActorContext,
	BASIS_REQUIRED,
	type CreateInput,
	type DeliveryDeviation,
	ESTIMATE_WARN_RATIO,
	type EstimateStatus,
	LedgerError,
	type ListedOrder,
	type ListFilter,
	type Order,
	type OrderView,
	type Requirement,
	ROLES,
	STALE_MINUTES,
	type StateRole,
	type UpdateInput,
	type Waiting,
} from "./types.ts";
import { describeWaiting } from "./waiting.ts";

type Row = Record<string, unknown>;

/** 有序候选：去空、去重、保序，至少要有一个 */
function normalizeActors(actors: string[] | undefined): string[] {
	const out: string[] = [];
	for (const raw of actors ?? []) {
		const name = raw?.trim();
		if (name && !out.includes(name)) out.push(name);
	}
	if (!out.length) throw new LedgerError("下一步找谁不能为空（至少写一个名字）");
	return out;
}

/**
 * 会话 key 形式的临时标识：`1423-311c`（pid-随机）或 `example-project-1423`。
 * 拿它当下一步找谁，会话一重启就指向不存在的对象，所以写入口直接拦。
 */
function looksLikeSessionKey(name: string): boolean {
	return /^\d+-[0-9a-f]{4}$/.test(name) || /[A-Za-z0-9_.-]+-\d{2,}$/.test(name);
}

function assertActorNames(names: string[]): void {
	for (const name of names) {
		if (looksLikeSessionKey(name)) {
			throw new LedgerError(
				`下一步找谁要写角色名（如 dev / qa / owner），不写会话 key：${name}。会话 key 重启即失效，库里的归属会变成死链`,
			);
		}
	}
}

function toOrder(row: Row): Order {
	return {
		id: String(row.id),
		title: String(row.title),
		body: String(row.body ?? ""),
		contents: JSON.parse(String(row.contents ?? "[]")),
		state: String(row.state),
		nextActors: JSON.parse(String(row.next_actors)) as string[],
		closingBasis: row.closing_basis == null ? null : String(row.closing_basis),
		estimate: {
			activeMin: numOrNull(row.estimate_active_min),
			wallMin: numOrNull(row.estimate_wall_min),
			basis: row.estimate_basis == null ? null : String(row.estimate_basis),
		},
		actual: {
			activeMin: numOrNull(row.actual_active_min),
			wallMin: numOrNull(row.actual_wall_min),
		},
		actualWaitMin: numOrNull(row.actual_wait_min),
		deliveryVariance: row.delivery_variance == null ? null : String(row.delivery_variance),
		placeholderBasis: row.placeholder_basis == null ? null : String(row.placeholder_basis),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		revision: Number(row.revision),
	};
}

function numOrNull(value: unknown): number | null {
	return value == null ? null : Number(value);
}

/**
 * 工时的写入口子：正数整数分钟，其余一律报错。
 * 负数和 0 都不是「快完工」而是写错了，静默收下会让估算进度提醒失灵。
 */
function assertMinutes(value: number | null | undefined, label: string): number | null {
	if (value == null) return null;
	if (!Number.isFinite(value) || value <= 0) throw new LedgerError(`${label}要写正数分钟：${value}`);
	return Math.round(value);
}

function mustFind(db: DatabaseSync, id: string): Order {
	const row = db.prepare("SELECT * FROM orders WHERE id=?").get(id) as Row | undefined;
	if (!row) throw new LedgerError(`未知工单：${id}`);
	return toOrder(row);
}

// ── 读 ──────────────────────────────────────────────

export function getOrder(db: DatabaseSync, id: string): OrderView {
	const order = mustFind(db, id);
	const dependsOn = (
		db.prepare("SELECT depends_on FROM deps WHERE order_id=? ORDER BY depends_on").all(id) as Row[]
	).map((r) => String(r.depends_on));
	const blocks = (db.prepare("SELECT order_id FROM deps WHERE depends_on=? ORDER BY order_id").all(id) as Row[]).map(
		(r) => String(r.order_id),
	);
	const cancelled = stateOf(db, "cancelled");
	const staleDeps = dependsOn.filter((up) => {
		const row = db.prepare("SELECT state FROM orders WHERE id=?").get(up) as Row | undefined;
		return row ? String(row.state) === cancelled : false;
	});
	return { ...order, dependsOn, blocks, staleDeps };
}

export function listOrders(db: DatabaseSync, filter: ListFilter = {}): ListedOrder[] {
	const states = statesOf(db);
	const clauses: string[] = [];
	const params: string[] = [];

	// 「跳过终态」只在调用方没有明确指定状态时兜底：
	// state 写已收口却因为默认排除终态而返回空，是查不动历史的根源。
	if (filter.state) {
		roleOf(db, filter.state); // 未声明的状态名直接报错，不静默返回空
		clauses.push("state = ?");
		params.push(filter.state);
	} else if (!filter.history) {
		clauses.push("state <> ? AND state <> ?");
		params.push(states.done, states.cancelled);
	}
	if (filter.nextActor) {
		clauses.push("EXISTS (SELECT 1 FROM json_each(orders.next_actors) WHERE value = ?)");
		params.push(filter.nextActor);
	}
	if (filter.ready) {
		clauses.push(
			"NOT EXISTS (SELECT 1 FROM deps d JOIN orders up ON up.id = d.depends_on WHERE d.order_id = orders.id AND up.state <> ?)",
		);
		params.push(states.done);
	}
	const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
	const rows = db.prepare(`SELECT * FROM orders ${where} ORDER BY id`).all(...params) as Row[];
	// 依赖清单随列表带出：前置在列表上有一列，不必再写进标题
	const byOrder = new Map<string, string[]>();
	if (rows.length) {
		const ph = rows.map(() => "?").join(",");
		for (const d of db
			.prepare(`SELECT order_id, depends_on FROM deps WHERE order_id IN (${ph}) ORDER BY depends_on`)
			.all(...rows.map((r) => String(r.id))) as Row[]) {
			const list = byOrder.get(String(d.order_id)) ?? [];
			list.push(String(d.depends_on));
			byOrder.set(String(d.order_id), list);
		}
	}
	return rows.map((r) => ({ ...toOrder(r), dependsOn: byOrder.get(String(r.id)) ?? [] }));
}

/** 依赖已全部收口、可以开工的 */
export function readyOrders(db: DatabaseSync): ListedOrder[] {
	return listOrders(db, { ready: true });
}

/**
 * 空结果也要能自证：告诉调用方库里到底有多少、该怎么查。
 * 返回 undefined 表示确实空了（没有可提示的）。
 */
export function listHint(db: DatabaseSync, filter: ListFilter = {}): string | undefined {
	const hit = listOrders(db, filter).length;
	if (hit > 0) return undefined;
	const total = listOrders(db, { history: true }).length;
	if (total === 0) return "库里还没有任何工单（用 orders_create 建第一条）";
	const states = statesOf(db);
	const closed = db
		.prepare("SELECT count(*) AS c FROM orders WHERE state IN (?,?)")
		.get(states.done, states.cancelled) as { c: number };
	const open = total - closed.c;
	const parts = [`没有匹配的工单。库里共 ${total} 条：未收口 ${open} 条`];
	if (closed.c > 0) parts.push(`已收口/已取消 ${closed.c} 条（看它们加 history=true 或写 state=已收口）`);
	return parts.join("，");
}

/**
 * 在等谁动：未收口、且当前状态属于「等人接手或裁定」的单。
 * 依赖等待保持可见；可执行起点另按依赖解锁事件推导，正文改动不重置计时。
 */
export function waitingOrders(db: DatabaseSync, actor?: string): Waiting[] {
	const rows = listOrders(db, actor ? { nextActor: actor } : {}).filter((o) => isWaitingState(db, o.state));
	return rows.map((order) => describeWaiting(db, order));
}

/** 仅催可处理或待裁定的单，不把依赖等待算作停滞。 */
export function staleWaiting(db: DatabaseSync, minutes = STALE_MINUTES, actor?: string, at = Date.now()): Waiting[] {
	const cutoff = at - minutes * 60_000;
	return waitingOrders(db, actor).filter((w) => w.kind !== "dependency" && Date.parse(w.since) < cutoff);
}

/** 可开工却没人接的：依赖已解、状态还是待认领 */
export function idleReady(db: DatabaseSync): Order[] {
	const claimable = statesOf(db).claimable;
	return readyOrders(db).filter((o) => o.state === claimable);
}

/** 按下一步找谁分组（没有下一步名字的归到「（未指定）」） */
export function groupByActor(waiting: Waiting[]): { actor: string; items: Waiting[] }[] {
	const groups = new Map<string, Waiting[]>();
	for (const w of waiting) {
		const actor = w.order.nextActors[0] ?? "（未指定）";
		const list = groups.get(actor) ?? [];
		list.push(w);
		groups.set(actor, list);
	}
	return [...groups.entries()]
		.map(([actor, items]) => ({ actor, items }))
		.sort((a, b) => a.actor.localeCompare(b.actor));
}

/** 挂了多久（分钟），按进当前状态的时刻算 */
export function waitedMinutes(w: Waiting, at = Date.now()): number {
	return Math.max(0, Math.round((at - Date.parse(w.since)) / 60_000));
}

/** 等某条的下游（递归），用于回答「这条延期会拖累谁」 */
export function downstreamOf(db: DatabaseSync, id: string): Order[] {
	mustFind(db, id);
	const rows = db
		.prepare(
			`WITH RECURSIVE down(id) AS (
			   SELECT order_id FROM deps WHERE depends_on = ?
			   UNION
			   SELECT d.order_id FROM deps d JOIN down ON d.depends_on = down.id
			 )
			 SELECT o.* FROM orders o JOIN down ON o.id = down.id ORDER BY o.id`,
		)
		.all(id) as Row[];
	return rows.map(toOrder);
}

export function requirementOf(db: DatabaseSync): Requirement | undefined {
	return getMeta<Requirement>(db, "requirement");
}

export function setRequirement(db: DatabaseSync, req: Omit<Requirement, "updatedAt">): Requirement {
	const value: Requirement = { ...req, updatedAt: now() };
	setMeta(db, "requirement", value);
	return value;
}

// ── 写 ──────────────────────────────────────────────

function nextId(db: DatabaseSync): string {
	const prefix = idPrefixOf(db);
	const rows = db.prepare("SELECT id FROM orders").all() as Row[];
	let max = 0;
	for (const row of rows) {
		const m = new RegExp(`^${prefix}(\\d+)$`).exec(String(row.id));
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `${prefix}${String(max + 1).padStart(2, "0")}`;
}

function assertTransition(db: DatabaseSync, fromState: string, toState: string): void {
	const from = roleOf(db, fromState);
	const to = roleOf(db, toState);
	const allowed = transitionsOf(db)[from];
	if (!allowed.includes(to)) {
		const allowedNames = allowed.map((r) => stateOf(db, r)).join(" / ") || "（终态）";
		throw new LedgerError(`不合法转换：${fromState} → ${toState}（${from} 只能到 ${allowedNames}）`);
	}
}

/** 一个角色同一时刻只能有一条在做：进入在做前检查名下有没有别的 */
function assertSingleActive(db: DatabaseSync, id: string | null, owner: string): void {
	const active = stateOf(db, "active");
	const row = db
		.prepare(
			`SELECT id FROM orders WHERE state=? AND id IS NOT ?
			 AND EXISTS (SELECT 1 FROM json_each(orders.next_actors) WHERE value = ?)`,
		)
		.get(active, id ?? null, owner) as Row | undefined;
	if (row) throw new LedgerError(`${owner} 已有在做的一条（${String(row.id)}），先阻塞或收口再认领`);
}

function assertDepsExist(db: DatabaseSync, id: string, deps: string[]): void {
	for (const dep of deps) {
		if (dep === id) throw new LedgerError(`依赖不能指向自己：${dep}`);
		mustFind(db, dep);
	}
}

/** 加依赖前查环：从上游出发能否走回自己 */
function assertNoCycle(db: DatabaseSync, id: string, dep: string): void {
	const rows = db
		.prepare(
			`WITH RECURSIVE up(id) AS (
			   SELECT depends_on FROM deps WHERE order_id = ?
			   UNION
			   SELECT d.depends_on FROM deps d JOIN up ON d.order_id = up.id
			 )
			 SELECT id FROM up`,
		)
		.all(dep) as Row[];
	if (rows.some((r) => String(r.id) === id)) {
		throw new LedgerError(`加这条依赖会成环：${dep} 已经（间接）依赖 ${id}`);
	}
}

export function createOrder(db: DatabaseSync, input: CreateInput, ctx: ActorContext): OrderView {
	if (!input.title?.trim()) throw new LedgerError("标题不能为空");
	if (!ctx.reason?.trim()) throw new LedgerError("建单也要写理由：这条为什么要建");
	const actors = normalizeActors(input.nextActors);
	const contents = normalizeContents(input.contents);
	assertActorNames(actors);

	const states = statesOf(db);
	const role: StateRole = input.role ?? "claimable";
	if (!ROLES.includes(role)) throw new LedgerError(`未知角色：${role}`);
	const id = input.id?.trim() || nextId(db);
	if (db.prepare("SELECT id FROM orders WHERE id=?").get(id)) {
		throw new LedgerError(`工单号已存在：${id}`);
	}
	if (role === "active" && actors.length !== 1) {
		throw new LedgerError("在做状态的工单只能有一个执行者");
	}
	if (role === "active") assertSingleActive(db, id, actors[0]);

	const deps = input.dependsOn ?? [];
	assertDepsExist(db, id, deps);
	for (const dep of deps) assertNoCycle(db, id, dep);

	const stamp = now();
	const estimate = {
		activeMin: assertMinutes(input.estimate?.activeMin, "预估主动工时"),
		wallMin: assertMinutes(input.estimate?.wallMin, "预估墙钟"),
		basis: input.estimate?.basis?.trim() || null,
	};
	db.exec("BEGIN IMMEDIATE;");
	try {
		db.prepare(
			`INSERT INTO orders(id,title,body,contents,state,next_actors,closing_basis,
			 estimate_active_min,estimate_wall_min,estimate_basis,placeholder_basis,created_at,updated_at,revision)
			 VALUES(?,?,?,?,?,?,NULL,?,?,?,?,?,?,1)`,
		).run(
			id,
			input.title.trim(),
			input.body ?? "",
			JSON.stringify(contents),
			states[role],
			JSON.stringify(actors),
			estimate.activeMin,
			estimate.wallMin,
			estimate.basis,
			input.placeholderBasis?.trim() || null,
			stamp,
			stamp,
		);
		for (const dep of deps) {
			db.prepare("INSERT INTO deps(order_id,depends_on) VALUES(?,?)").run(id, dep);
		}
		logEvent(db, {
			orderId: id,
			actor: ctx.actor,
			kind: "create",
			toState: states[role],
			note: ctx.reason,
		});
		for (const dep of deps) {
			logEvent(db, { orderId: id, actor: ctx.actor, kind: "dep-add", note: dep });
		}
		db.exec("COMMIT;");
	} catch (error) {
		db.exec("ROLLBACK;");
		throw error;
	}
	return getOrder(db, id);
}

/**
 * 改一条工单：字段替换、正文追加、状态转换在同一次事务里，一起成功或一起回滚。
 *
 * 带 expectedRevision 时，写入也校验版本，拦住读取后到事务开始前的并发更新。
 */
export function updateOrder(
	db: DatabaseSync,
	id: string,
	patch: UpdateInput,
	ctx: ActorContext,
	expectedRevision?: number,
): OrderView {
	if (!ctx.reason?.trim()) throw new LedgerError("改状态或范围必须写理由");
	const old = mustFind(db, id);
	if (expectedRevision != null && old.revision !== expectedRevision) {
		throw new LedgerError(`版本冲突：库里是 revision=${old.revision}，你手上是 ${expectedRevision}；请重读工单再改`);
	}

	// 空串或全空白一律当作「没传」：调用方习惯用 "" 表示这次不改这个字段，
	// 不能让它变成「把正文清空」。
	const replacement = patch.body?.trim() ? patch.body : undefined;
	const section = patch.appendBody?.trim();
	if (patch.appendBody != null && !section) throw new LedgerError("追加内容不能为空");

	const targetState = patch.state ?? old.state;
	const nextRole = roleOf(db, targetState);
	// 认领＝把状态推到「在做」；这时执行者就是操作者本人，不用再手传
	const claiming = nextRole === "active" && old.state !== targetState;
	const nextActors = patch.nextActors ? normalizeActors(patch.nextActors) : claiming ? [ctx.actor] : old.nextActors;
	if (patch.nextActors) assertActorNames(nextActors);

	// 先替换（如果给了），再拼接追加段：追加永远不覆盖旧句
	const replaced = replacement ?? old.body;
	const nextBody = section ? (replaced.trim() ? `${replaced.trimEnd()}\n\n${section}\n` : `${section}\n`) : replaced;

	const next = {
		title: patch.title?.trim() || old.title,
		body: nextBody,
		contents: patch.contents === undefined ? old.contents : normalizeContents(patch.contents),
		state: targetState,
		nextActors,
		closingBasis: patch.closingBasis ?? old.closingBasis,
		// 估算与实际的语义是「改哪个字段就只动哪个」，不给就保留：
		// 交回去只补实际工时，不应该把开工前写的估算抹掉。
		estimate: {
			activeMin:
				patch.estimate?.activeMin === undefined
					? old.estimate.activeMin
					: assertMinutes(patch.estimate.activeMin, "预估主动工时"),
			wallMin:
				patch.estimate?.wallMin === undefined
					? old.estimate.wallMin
					: assertMinutes(patch.estimate.wallMin, "预估墙钟"),
			basis: patch.estimate?.basis === undefined ? old.estimate.basis : patch.estimate.basis?.trim() || null,
		},
		actual: {
			activeMin:
				patch.actual?.activeMin === undefined
					? old.actual.activeMin
					: assertMinutes(patch.actual.activeMin, "实际主动工时"),
			wallMin:
				patch.actual?.wallMin === undefined ? old.actual.wallMin : assertMinutes(patch.actual.wallMin, "实际墙钟"),
		},
		actualWaitMin:
			patch.actualWaitMin === undefined ? old.actualWaitMin : assertMinutes(patch.actualWaitMin, "等待依赖时间"),
		deliveryVariance:
			patch.deliveryVariance === undefined ? old.deliveryVariance : patch.deliveryVariance?.trim() || null,
		placeholderBasis:
			patch.placeholderBasis === undefined ? old.placeholderBasis : patch.placeholderBasis?.trim() || null,
	};

	if (next.state !== old.state) assertTransition(db, old.state, next.state);
	if (nextRole === "active") {
		if (nextActors.length !== 1) {
			throw new LedgerError("在做状态的工单只能有一个执行者（换人就给一个名字）");
		}
		if (next.state !== old.state || nextActors[0] !== old.nextActors[0]) {
			assertSingleActive(db, id, nextActors[0]);
		}
	}
	if (BASIS_REQUIRED.includes(nextRole) && !next.closingBasis?.trim()) {
		throw new LedgerError(nextRole === "done" ? "结单必须给终止依据（证据指针）" : "取消必须给理由或取代它的单号");
	}

	db.exec("BEGIN IMMEDIATE;");
	try {
		const result = db
			.prepare(
				`UPDATE orders SET title=?, body=?, contents=?, state=?, next_actors=?, closing_basis=?,
			 estimate_active_min=?, estimate_wall_min=?, estimate_basis=?,
			 actual_active_min=?, actual_wall_min=?, actual_wait_min=?, delivery_variance=?, placeholder_basis=?,
			 updated_at=?, revision=revision+1 WHERE id=? AND (? IS NULL OR revision=?)`,
			)
			.run(
				next.title,
				next.body,
				JSON.stringify(next.contents),
				next.state,
				JSON.stringify(nextActors),
				next.closingBasis,
				next.estimate.activeMin,
				next.estimate.wallMin,
				next.estimate.basis,
				next.actual.activeMin,
				next.actual.wallMin,
				next.actualWaitMin,
				next.deliveryVariance,
				next.placeholderBasis,
				now(),
				id,
				expectedRevision ?? null,
				expectedRevision ?? null,
			);
		if (Number(result.changes) !== 1) {
			throw new LedgerError("版本冲突：工单已被其他会话修改；请重读工单再改");
		}
		const stateChanged = next.state !== old.state;
		if (stateChanged) {
			logEvent(db, {
				orderId: id,
				actor: ctx.actor,
				kind: "state",
				fromState: old.state,
				toState: next.state,
				note: ctx.reason,
			});
		} else if (
			next.body !== old.body ||
			next.title !== old.title ||
			JSON.stringify(next.contents) !== JSON.stringify(old.contents) ||
			JSON.stringify(next.estimate) !== JSON.stringify(old.estimate) ||
			JSON.stringify(next.actual) !== JSON.stringify(old.actual) ||
			next.actualWaitMin !== old.actualWaitMin ||
			next.deliveryVariance !== old.deliveryVariance ||
			next.placeholderBasis !== old.placeholderBasis
		) {
			logEvent(db, { orderId: id, actor: ctx.actor, kind: "field", note: ctx.reason });
		}
		if (!stateChanged && JSON.stringify(nextActors) !== JSON.stringify(old.nextActors)) {
			logEvent(db, { orderId: id, actor: ctx.actor, kind: "handoff", note: ctx.reason });
		}
		db.exec("COMMIT;");
	} catch (error) {
		db.exec("ROLLBACK;");
		throw error;
	}
	return getOrder(db, id);
}

/** 范围修订：追加一段，不覆盖旧句（旧句留在正文里，可追溯） */
export function appendBody(db: DatabaseSync, id: string, section: string, ctx: ActorContext): OrderView {
	return updateOrder(db, id, { appendBody: section }, { ...ctx, reason: ctx.reason || "正文追加修订" });
}

export function addDep(db: DatabaseSync, id: string, dep: string, ctx: ActorContext): OrderView {
	if (!ctx.reason?.trim()) throw new LedgerError("加依赖要写理由");
	mustFind(db, id);
	assertDepsExist(db, id, [dep]);
	if (db.prepare("SELECT 1 FROM deps WHERE order_id=? AND depends_on=?").get(id, dep)) {
		throw new LedgerError(`依赖已存在：${id} 依赖 ${dep}`);
	}
	assertNoCycle(db, id, dep);
	db.prepare("INSERT INTO deps(order_id,depends_on) VALUES(?,?)").run(id, dep);
	logEvent(db, { orderId: id, actor: ctx.actor, kind: "dep-add", note: dep });
	return getOrder(db, id);
}

export function removeDep(db: DatabaseSync, id: string, dep: string, ctx: ActorContext): OrderView {
	if (!ctx.reason?.trim()) throw new LedgerError("删依赖要写理由");
	if (!db.prepare("SELECT 1 FROM deps WHERE order_id=? AND depends_on=?").get(id, dep)) {
		throw new LedgerError(`没有这条依赖：${id} → ${dep}`);
	}
	db.prepare("DELETE FROM deps WHERE order_id=? AND depends_on=?").run(id, dep);
	logEvent(db, { orderId: id, actor: ctx.actor, kind: "dep-remove", note: dep });
	return getOrder(db, id);
}

/** 取消一条时，下游会失去前置。这里是提示用的计数，不做自动处置 */
export function countBlockedDownstream(db: DatabaseSync, id: string): number {
	return downstreamOf(db, id).filter((o) => !isTerminal(db, o.state)).length;
}

// ── 估算与实际：进度、偏差、依赖产物 ────────────────

/** 开工时刻：最近一次进入「在做」，没有就按建单时刻。估算进度从这里起算 */
export function startedAt(db: DatabaseSync, order: Order): string {
	return enteredStateAt(db, order.id, stateOf(db, "active")) ?? order.createdAt;
}

/** 已过去的墙钟分钟（自开工起）。未开工的单按建单时刻，与「等多久」口径一致 */
export function elapsedMinutes(db: DatabaseSync, order: Order, at = Date.now()): number {
	return Math.max(0, Math.round((at - Date.parse(startedAt(db, order))) / 60_000));
}

/**
 * 估算进度。只有「在做」与「阻塞」算进度：待认领还没开工，待复核已经在等人，
 * 把它们的等待时间算成执行落后，会催错人。
 */
export function estimateStatus(db: DatabaseSync, order: Order, at = Date.now()): EstimateStatus {
	const wall = order.estimate.wallMin;
	const role = roleOf(db, order.state);
	if (wall == null || (role !== "active" && role !== "paused")) return { level: "none", ratio: null, remainMin: null };
	const used = elapsedMinutes(db, order, at);
	const ratio = used / wall;
	const remainMin = wall - used;
	if (ratio >= 1) return { level: "over", ratio, remainMin };
	if (ratio >= ESTIMATE_WARN_RATIO) return { level: "warn", ratio, remainMin };
	return { level: "ok", ratio, remainMin };
}

/** 等依赖的分钟数：只对「等依赖」这一类算，其余为 0 */
export function dependencyWaitMinutes(db: DatabaseSync, order: Order, at = Date.now()): number {
	const w = describeWaiting(db, order);
	if (w.kind !== "dependency") return 0;
	return Math.max(0, Math.round((at - Date.parse(w.since)) / 60_000));
}

/** 交付偏差：只做减法，不判断好坏。为什么差，看 deliveryVariance */
export function deliveryDeviation(order: Order): DeliveryDeviation {
	const wall =
		order.actual.wallMin != null && order.estimate.wallMin != null
			? order.actual.wallMin - order.estimate.wallMin
			: null;
	const active =
		order.actual.activeMin != null && order.estimate.activeMin != null
			? order.actual.activeMin - order.estimate.activeMin
			: null;
	// 等待时间优先用交付时填的那个数；没填才用「墙钟 - 主动工时」推。
	// 手填的数是人核过的，两者不一致时以它为准。
	const wait =
		order.actualWaitMin ??
		(order.actual.wallMin != null && order.actual.activeMin != null
			? order.actual.wallMin - order.actual.activeMin
			: null);
	return { wallMin: wall, activeMin: active, waitMin: wait };
}

export interface UpstreamArtifact {
	id: string;
	title: string;
	/** 上游收口时写的终止依据，通常就是产物指针 */
	closingBasis: string | null;
	/** 什么时候收的 */
	at: string;
}

/**
 * 近期已知产物：已收口的上游写下的终止依据。
 * 派给下游时说清「能直接用的东西在哪」，省得它重跑一遍前置。
 */
export function upstreamArtifacts(db: DatabaseSync, orderId: string, limit = 5): UpstreamArtifact[] {
	const done = stateOf(db, "done");
	const rows = db
		.prepare(
			`SELECT up.id, up.title, up.closing_basis, up.updated_at
			 FROM deps d JOIN orders up ON up.id = d.depends_on
			 WHERE d.order_id = ? AND up.state = ?
			 ORDER BY up.updated_at DESC LIMIT ?`,
		)
		.all(orderId, done, limit) as Row[];
	return rows.map((r) => ({
		id: String(r.id),
		title: String(r.title),
		closingBasis: r.closing_basis == null ? null : String(r.closing_basis),
		at: String(r.updated_at),
	}));
}
