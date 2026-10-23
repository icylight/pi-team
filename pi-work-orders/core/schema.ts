/**
 * 库的建立、打开与约定读取。
 *
 * schema 变更走 PRAGMA user_version：加字段就加一版，打开时比对。
 * 状态集由项目在库里声明（meta.states），工具只读状态自带的开关，不认状态名。
 * 状态之间没有转换表：任何状态都能改到任何状态，只记事件。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	DEFAULT_STATE_DEFS,
	DEFAULT_TYPES,
	type EventKind,
	LedgerError,
	type Meta,
	type OrderComment,
	type OrderEvent,
	type Requirement,
	type StateDef,
	type TerminalKind,
} from "./types.ts";

export const SCHEMA_VERSION = 8;
export const DEFAULT_DB_DIR = ".work-orders";
export const DEFAULT_DB_NAME = "work-orders.sqlite";

const DDL = `
CREATE TABLE meta (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL
);

CREATE TABLE orders (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  contents      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(contents) AND json_type(contents) = 'array'),
  type          TEXT,
  state         TEXT NOT NULL,
  next_actors   TEXT NOT NULL CHECK (json_valid(next_actors)),
  closing_basis TEXT,
  estimate_active_min INTEGER,
  estimate_wall_min   INTEGER,
  estimate_basis      TEXT,
  actual_active_min   INTEGER,
  actual_wall_min     INTEGER,
  actual_wait_min     INTEGER,
  delivery_variance   TEXT,
  placeholder_basis   TEXT,
  content_lock  TEXT CHECK (content_lock IS NULL OR (json_valid(content_lock) AND json_type(content_lock) = 'object')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  revision      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE deps (
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  PRIMARY KEY (order_id, depends_on),
  CHECK (order_id <> depends_on)
);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  from_state TEXT,
  to_state   TEXT,
  note       TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL,
  revision   INTEGER
);

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor      TEXT NOT NULL,
  body       TEXT NOT NULL,
  revision   INTEGER,
  at         TEXT NOT NULL
);

CREATE INDEX orders_state   ON orders(state);
CREATE INDEX deps_reverse   ON deps(depends_on);
CREATE INDEX events_order   ON events(order_id, id);
CREATE INDEX comments_order ON comments(order_id, id);
`;

/**
 * 逐版升级。键是「文件当前版本」，值是从该版升到下一版要跑的 SQL。
 * 只加表、加列，不重建：旧库里已有的数据不动。
 */
const MIGRATIONS: Record<number, string> = {
	7: `
ALTER TABLE events ADD COLUMN revision INTEGER;
CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor      TEXT NOT NULL,
  body       TEXT NOT NULL,
  revision   INTEGER,
  at         TEXT NOT NULL
);
CREATE INDEX comments_order ON comments(order_id, id);
`,
	6: `
ALTER TABLE orders ADD COLUMN content_lock TEXT
  CHECK (content_lock IS NULL OR (json_valid(content_lock) AND json_type(content_lock) = 'object'));
`,
	5: `
ALTER TABLE orders ADD COLUMN type TEXT;
`,
	4: `
ALTER TABLE orders ADD COLUMN estimate_active_min INTEGER;
ALTER TABLE orders ADD COLUMN estimate_wall_min   INTEGER;
ALTER TABLE orders ADD COLUMN estimate_basis      TEXT;
ALTER TABLE orders ADD COLUMN actual_active_min   INTEGER;
ALTER TABLE orders ADD COLUMN actual_wall_min     INTEGER;
ALTER TABLE orders ADD COLUMN actual_wait_min     INTEGER;
ALTER TABLE orders ADD COLUMN delivery_variance   TEXT;
ALTER TABLE orders ADD COLUMN placeholder_basis   TEXT;
`,
	3: `
ALTER TABLE orders ADD COLUMN contents TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(contents) AND json_type(contents) = 'array');
`,
	2: `
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  from_state TEXT,
  to_state   TEXT,
  note       TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL
);
CREATE INDEX events_order ON events(order_id, id);
`,
};

/** 库文件的默认位置：项目内的 .work-orders/，随项目走、不进 git */
export function defaultDbPath(cwd: string): string {
	return path.join(cwd, DEFAULT_DB_DIR, DEFAULT_DB_NAME);
}

/**
 * 是否禁止自动升级。默认允许——单会话用库时自动升级最省事。
 *
 * 多会话共享同一个库时，自动升级是个陷阱：谁先拿到新版代码打开库，升级就在那一刻发生，
 * 其他还跑旧代码的会话随即被锁在外面（它们会报「库版本比工具新」）。这时把
 * `PI_WORK_ORDERS_NO_MIGRATE=1` 设上：库版本不匹配就只报错，不写库，等所有会话都换到新版再放开。
 */
function migrationDisabled(): boolean {
	const raw = process.env.PI_WORK_ORDERS_NO_MIGRATE?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes";
}

export function openLedger(dbPath: string, readOnly = false): DatabaseSync {
	if (!fs.existsSync(dbPath)) {
		throw new LedgerError(`工单库不存在：${dbPath}（先跑 orders_init 建库）`);
	}
	const db = new DatabaseSync(dbPath, { readOnly });
	db.exec("PRAGMA foreign_keys=ON;");
	db.exec("PRAGMA busy_timeout=5000;");
	const version = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
	const found = version?.user_version ?? 0;
	if (found !== SCHEMA_VERSION) {
		if (migrationDisabled() && found < SCHEMA_VERSION) {
			db.close();
			throw new LedgerError(
				`库版本 ${found}、工具 ${SCHEMA_VERSION}，但已设 PI_WORK_ORDERS_NO_MIGRATE，不自动升级。` +
					`确认同库的其他会话都换了新版后，不设这个变量再打开一次即可完成升级。`,
			);
		}
		try {
			migrate(db, found, readOnly);
		} catch (error) {
			db.close();
			throw error;
		}
	}
	return db;
}

/**
 * 把旧版的库升到当前版：从文件版本逐版跑 MIGRATIONS，一版一个事务。
 * 版本比工具新、或没有迁移路径，就拒绝打开——静默按旧结构用比报错更危险。
 */
function migrate(db: DatabaseSync, found: number, readOnly: boolean): void {
	if (found > SCHEMA_VERSION) {
		throw new LedgerError(`库版本比工具新：文件是 ${found}，工具只到 ${SCHEMA_VERSION}（先升级 pi-work-orders）`);
	}
	if (readOnly) throw new LedgerError(`库需要从 ${found} 升到 ${SCHEMA_VERSION}，但这次是只读打开`);
	for (let v = found; v < SCHEMA_VERSION; v++) {
		const sql = MIGRATIONS[v];
		if (!sql) {
			throw new LedgerError(`库版本不匹配：文件是 ${found}，且没有升到 ${SCHEMA_VERSION} 的迁移路径`);
		}
		db.exec("BEGIN IMMEDIATE;");
		try {
			db.exec(sql);
			db.exec(`PRAGMA user_version=${v + 1};`);
			db.exec("COMMIT;");
		} catch (error) {
			db.exec("ROLLBACK;");
			throw error;
		}
	}
}

export interface InitOptions {
	/** 需求：接到什么活、什么算交付 */
	requirement?: Omit<Requirement, "updatedAt">;
	/** 覆盖默认状态集（自己声明状态与能力开关） */
	states?: StateDef[];
	/** 覆盖默认类型枚举 */
	types?: string[];
	/** ID 前缀，默认 T */
	idPrefix?: string;
}

export function initLedger(dbPath: string, options: InitOptions = {}): DatabaseSync {
	if (fs.existsSync(dbPath)) throw new LedgerError(`工单库已存在，拒绝重新初始化：${dbPath}`);
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA journal_mode=WAL;");
	db.exec("PRAGMA foreign_keys=ON;");
	db.exec(DDL);
	db.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);
	if (options.states) {
		normalizeStates(options.states);
		setMeta(db, "states", options.states);
	}
	if (options.types) setMeta(db, "types", options.types);
	if (options.idPrefix) setMeta(db, "idPrefix", options.idPrefix);
	if (options.requirement) setMeta(db, "requirement", { ...options.requirement, updatedAt: now() });
	db.close();
	return openLedger(dbPath);
}

export function now(): string {
	return new Date().toISOString();
}

// ── meta 读写 ────────────────────────────────────────

export function getMeta<T>(db: DatabaseSync, key: keyof Meta): T | undefined {
	const row = db.prepare("SELECT value_json FROM meta WHERE key=?").get(key) as { value_json: string } | undefined;
	return row ? (JSON.parse(row.value_json) as T) : undefined;
}

export function setMeta(db: DatabaseSync, key: keyof Meta, value: unknown): void {
	db.prepare(
		`INSERT INTO meta(key, value_json, updated_at) VALUES(?,?,?)
		 ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
	).run(key, JSON.stringify(value), now());
}

// ── 约定：状态集 ────────────────────────────────────

/** 状态集：库内声明优先，没配就用默认集 */
export function statesOf(db: DatabaseSync): StateDef[] {
	const raw = getMeta<unknown>(db, "states");
	if (raw === undefined) return DEFAULT_STATE_DEFS.map((state) => ({ ...state }));
	return normalizeStates(raw);
}

const STATE_FLAGS = ["waiting", "timing", "singleOwner", "execution", "needsBasis", "initial"] as const;

function normalizeStates(raw: unknown): StateDef[] {
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new LedgerError(
			`meta.states 要写成非空数组，例如 [{"name":"待认领","waiting":true},{"name":"已收口","terminal":"done","needsBasis":true}]；现在是：${JSON.stringify(raw)}`,
		);
	}
	const states: StateDef[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new LedgerError(`meta.states 的每一项都要写成对象，现在是：${JSON.stringify(item)}`);
		}
		const record = item as Record<string, unknown>;
		const name = typeof record.name === "string" ? record.name.trim() : "";
		if (!name) throw new LedgerError(`meta.states 里有一项没写 name：${JSON.stringify(item)}`);
		if (seen.has(name)) throw new LedgerError(`meta.states 里状态名重复：${name}`);
		seen.add(name);
		const state: StateDef = { name };
		for (const flag of STATE_FLAGS) {
			const value = record[flag];
			if (value === undefined) continue;
			if (typeof value !== "boolean") {
				throw new LedgerError(`状态「${name}」的 ${flag} 要写 true 或 false，现在是：${JSON.stringify(value)}`);
			}
			state[flag] = value;
		}
		const terminal = record.terminal;
		if (terminal !== undefined) {
			if (terminal !== "done" && terminal !== "cancelled") {
				throw new LedgerError(
					`状态「${name}」的 terminal 只能写 "done" 或 "cancelled"，现在是：${JSON.stringify(terminal)}`,
				);
			}
			state.terminal = terminal;
		}
		states.push(state);
	}
	for (const kind of ["done", "cancelled"] as const) {
		if (states.filter((state) => state.terminal === kind).length > 1) {
			throw new LedgerError(`meta.states 里 terminal=${kind} 只能有一个状态`);
		}
	}
	if (!states.some((state) => !state.terminal)) {
		throw new LedgerError("meta.states 至少要有一个非终态：建单要落在能继续推进的状态上");
	}
	return states;
}

/** 库里的状态名清单，按声明顺序 */
export function stateNames(db: DatabaseSync): string[] {
	return statesOf(db).map((state) => state.name);
}

/** 按名字取状态声明；未声明的名字直接报错，不让拼错静默变成第 N 个状态 */
export function stateDef(db: DatabaseSync, name: string): StateDef {
	const found = statesOf(db).find((state) => state.name === name);
	if (!found) {
		throw new LedgerError(`未知状态：${name}（当前状态集：${stateNames(db).join(" / ")}）`);
	}
	return found;
}

/** 终态状态名；项目没声明对应终态时返回 undefined */
export function stateByTerminal(db: DatabaseSync, kind: TerminalKind): string | undefined {
	return statesOf(db).find((state) => state.terminal === kind)?.name;
}

/** 所有终态的名字 */
export function terminalStateNames(db: DatabaseSync): string[] {
	return statesOf(db)
		.filter((state) => state.terminal)
		.map((state) => state.name);
}

/** 建单不指定状态时的落点：标了 initial 的优先，否则第一个非终态 */
export function initialStateDef(db: DatabaseSync): StateDef {
	const states = statesOf(db);
	return states.find((state) => state.initial) ?? states.find((state) => !state.terminal) ?? states[0];
}

export function isTerminal(db: DatabaseSync, state: string): boolean {
	return stateDef(db, state).terminal != null;
}

/** 状态是不是「在等人接手或裁定」 */
export function isWaitingState(db: DatabaseSync, state: string): boolean {
	return stateDef(db, state).waiting === true;
}

/**
 * 工单类型枚举：库内配置优先，没配就用默认三种。
 * 配成空数组表示这个项目不分类，此时任何 type 都不合法。
 */
export function typesOf(db: DatabaseSync): string[] {
	const raw = getMeta<unknown>(db, "types");
	if (raw === undefined) return [...DEFAULT_TYPES];
	// 配置面是直接写库的：写错形状就报错，不静默退回默认值（否则以为改了其实没生效）
	if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
		throw new LedgerError(`meta.types 要写成字符串数组，例如 ["需求单","实施单"]；现在是：${JSON.stringify(raw)}`);
	}
	return (raw as string[]).map((item) => item.trim()).filter(Boolean);
}

/** 类型必须落在枚举里：写错名字当场报错，不让它悄悄变成第 N 种分类 */
export function assertType(db: DatabaseSync, type: string): string {
	const allowed = typesOf(db);
	if (!allowed.includes(type)) {
		const list = allowed.length ? allowed.join(" / ") : "（本项目未配置类型）";
		throw new LedgerError(`未知工单类型：${type}（当前类型枚举：${list}）`);
	}
	return type;
}

export function idPrefixOf(db: DatabaseSync): string {
	return getMeta<string>(db, "idPrefix") ?? "T";
}

// ── 事件：只追加，不改 ───────────────────────────────

export interface NewEvent {
	orderId: string;
	actor: string;
	kind: EventKind;
	fromState?: string | null;
	toState?: string | null;
	note?: string;
}

/** 记一次动作。写路径上调用，与业务写同一次事务 */
export function logEvent(db: DatabaseSync, event: NewEvent): void {
	// 事件记的是这次写之后的版本：读的人拿工单的 rev 对照，能直接定位到是哪次动作把它推到这一版
	const row = db.prepare("SELECT revision FROM orders WHERE id=?").get(event.orderId) as
		| { revision?: number }
		| undefined;
	db.prepare(
		"INSERT INTO events(order_id,actor,kind,from_state,to_state,note,at,revision) VALUES(?,?,?,?,?,?,?,?)",
	).run(
		event.orderId,
		event.actor,
		event.kind,
		event.fromState ?? null,
		event.toState ?? null,
		event.note ?? "",
		now(),
		row?.revision == null ? null : Number(row.revision),
	);
}

function toEvent(row: Record<string, unknown>): OrderEvent {
	return {
		id: Number(row.id),
		orderId: String(row.order_id),
		actor: String(row.actor),
		kind: String(row.kind) as EventKind,
		fromState: row.from_state == null ? null : String(row.from_state),
		toState: row.to_state == null ? null : String(row.to_state),
		note: String(row.note ?? ""),
		at: String(row.at),
		revision: row.revision == null ? null : Number(row.revision),
	};
}

/** 一条单的动作记录，新→旧 */
export function eventsOf(db: DatabaseSync, orderId: string, limit = 10): OrderEvent[] {
	const rows = db
		.prepare("SELECT * FROM events WHERE order_id=? ORDER BY id DESC LIMIT ?")
		.all(orderId, limit) as Record<string, unknown>[];
	return rows.map(toEvent);
}

/** 最近一次进到某状态的时刻：等待时长按它算，正文改动不算重新开始等 */
export function enteredStateAt(db: DatabaseSync, orderId: string, state: string): string | undefined {
	const row = db
		.prepare("SELECT at FROM events WHERE order_id=? AND to_state=? ORDER BY id DESC LIMIT 1")
		.get(orderId, state) as Record<string, unknown> | undefined;
	return row ? String(row.at) : undefined;
}

// ── 评论：与动作分开，只追加 ─────────────────────────

/**
 * 评论是给人看的话，不是动作：不推状态、不涨 revision、不触发交接通知。
 * 动作回答「这单怎么变的」，评论回答「为什么、怎么看」。
 */
export interface NewComment {
	orderId: string;
	actor: string;
	body: string;
	/** 针对哪一版：调用方手上看到的 rev；不校验不拒绝，只用来事后对账 */
	revision?: number | null;
}

export function addComment(db: DatabaseSync, input: NewComment): OrderComment {
	const body = input.body.trim();
	if (!body) throw new LedgerError("评论内容不能为空");
	// 先查单号：外键报的是 SQLITE_CONSTRAINT，读的人看不出是“单号写错”还是“库坏了”
	if (!db.prepare("SELECT 1 FROM orders WHERE id=?").get(input.orderId)) {
		throw new LedgerError(`没有这条工单：${input.orderId}`);
	}
	const at = now();
	const result = db
		.prepare("INSERT INTO comments(order_id,actor,body,revision,at) VALUES(?,?,?,?,?)")
		.run(input.orderId, input.actor, body, input.revision ?? null, at);
	return {
		id: Number(result.lastInsertRowid),
		orderId: input.orderId,
		actor: input.actor,
		body,
		revision: input.revision ?? null,
		at,
	};
}

function toComment(row: Record<string, unknown>): OrderComment {
	return {
		id: Number(row.id),
		orderId: String(row.order_id),
		actor: String(row.actor),
		body: String(row.body),
		revision: row.revision == null ? null : Number(row.revision),
		at: String(row.at),
	};
}

/** 一条单的评论，新→旧 */
export function commentsOf(db: DatabaseSync, orderId: string, limit = 20): OrderComment[] {
	const rows = db
		.prepare("SELECT * FROM comments WHERE order_id=? ORDER BY id DESC LIMIT ?")
		.all(orderId, limit) as Record<string, unknown>[];
	return rows.map(toComment);
}
