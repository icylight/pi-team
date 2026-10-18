/**
 * 库的建立、打开与约定读取。
 *
 * schema 变更走 PRAGMA user_version：加字段就加一版，打开时比对。
 * 状态集与转换表允许项目在库里覆盖（meta.states / meta.transitions），
 * 工具按「角色」工作，不认状态名。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	DEFAULT_STATES,
	DEFAULT_TRANSITIONS,
	DEFAULT_TYPES,
	type EventKind,
	LedgerError,
	type Meta,
	type OrderEvent,
	type Requirement,
	ROLES,
	type StateRole,
	WAITING_ROLES,
} from "./types.ts";

export const SCHEMA_VERSION = 6;
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
  at         TEXT NOT NULL
);

CREATE INDEX orders_state  ON orders(state);
CREATE INDEX deps_reverse  ON deps(depends_on);
CREATE INDEX events_order  ON events(order_id, id);
`;

/**
 * 逐版升级。键是「文件当前版本」，值是从该版升到下一版要跑的 SQL。
 * 只加表、加列，不重建：旧库里已有的数据不动。
 */
const MIGRATIONS: Record<number, string> = {
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
	/** 覆盖默认状态集（角色 → 状态名） */
	states?: Partial<Record<StateRole, string>>;
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
	if (options.states) setMeta(db, "states", options.states);
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

// ── 约定：状态集与转换表 ─────────────────────────────

/** 角色 → 状态名：默认状态集 + 库内覆盖 */
export function statesOf(db: DatabaseSync): Record<StateRole, string> {
	const override = getMeta<Partial<Record<StateRole, string>>>(db, "states") ?? {};
	return { ...DEFAULT_STATES, ...override };
}

/** 状态名 → 角色；认不出来的状态名报错，避免约定漂移后静默通过 */
export function roleOf(db: DatabaseSync, state: string): StateRole {
	const states = statesOf(db);
	for (const role of ROLES) {
		if (states[role] === state) return role;
	}
	throw new LedgerError(`未知状态：${state}（当前状态集：${Object.values(states).join(" / ")}）`);
}

export function stateOf(db: DatabaseSync, role: StateRole): string {
	return statesOf(db)[role];
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

/** 转换表：默认 + 库内覆盖 */
export function transitionsOf(db: DatabaseSync): Record<StateRole, readonly StateRole[]> {
	const override = getMeta<Partial<Record<StateRole, StateRole[]>>>(db, "transitions") ?? {};
	return { ...DEFAULT_TRANSITIONS, ...override };
}

export function isTerminal(db: DatabaseSync, state: string): boolean {
	const role = roleOf(db, state);
	return role === "done" || role === "cancelled";
}
export function idPrefixOf(db: DatabaseSync): string {
	return getMeta<string>(db, "idPrefix") ?? "T";
}

/** 状态的角色是不是「在等人接手或裁定」 */
export function isWaitingState(db: DatabaseSync, state: string): boolean {
	return (WAITING_ROLES as readonly StateRole[]).includes(roleOf(db, state));
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
	db.prepare("INSERT INTO events(order_id,actor,kind,from_state,to_state,note,at) VALUES(?,?,?,?,?,?,?)").run(
		event.orderId,
		event.actor,
		event.kind,
		event.fromState ?? null,
		event.toState ?? null,
		event.note ?? "",
		now(),
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
