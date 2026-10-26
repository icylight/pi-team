/**
 * 看板的数据层：读本机所有工单库，拼成页面要的快照。
 *
 * 读一律只读打开，不迁移——schema 落后的库读不了，页面提示去项目里升。
 * 写入口有两个：评论（postComment）与状态推进（advanceState）；两者都先只读验一次版本，
 * 再开读写连接写那一行，结构仍不动。
 * 取数逻辑与状态规则直接复用工单包的 core/*，不重写等待推导，也不重写流转校验。
 */

import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { readDispatch, type DispatchSnapshot } from "../../core/dispatch.ts";
import { addComment, commentsOf, eventsOf, openLedger, statesOf } from "../../core/schema.ts";
import { getOrder, listOrders, requirementOf, staleWaiting, updateOrder, waitingOrders } from "../../core/store.ts";
import {
	HUMAN_ACTOR,
	type ListedOrder,
	type Order,
	type OrderComment,
	type OrderEvent,
	type OrderView,
	type Requirement,
	type StateDef,
	type UpdateInput,
	type Waiting,
} from "../../core/types.ts";
import { STALE_MINUTES } from "../../core/types.ts";
import { discoverLedgers, type LedgerRef } from "./scan.ts";

/** 一个库的只读快照；读不出来时只填 slug/name/dir/error */
export interface LedgerSnapshot {
	slug: string;
	name: string;
	dir: string;
	dbPath: string;
	ok: boolean;
	error?: string;
	states?: StateDef[];
	requirement?: Requirement;
	orders?: ListedOrder[];
	waiting?: Waiting[];
	stale?: Waiting[];
	dispatch?: DispatchSnapshot;
}

export interface OrderPageData {
	slug: string;
	project: string;
	states: StateDef[];
	view: OrderView;
	events: OrderEvent[];
	/** 新→旧，与 orders_show 的评论段同一取数口径 */
	comments: OrderComment[];
}

/** 扫描根：显式给的优先，否则当前目录加上代码根目录 */
export function scanRoots(explicit: readonly string[] = []): string[] {
	if (explicit.length) return [...explicit];
	const codeRoot = process.env.CODE_ROOT?.trim() || path.join(os.homedir(), "code");
	const roots = [process.cwd(), codeRoot];
	const fromEnv = process.env.PI_WORK_ORDERS_WEB_ROOTS;
	if (fromEnv) roots.push(...fromEnv.split(path.delimiter));
	return roots.map((r) => path.resolve(r.trim())).filter(Boolean);
}

function staleMinutes(): number {
	const value = Number(process.env.PI_WORK_ORDERS_STALE_MINUTES?.trim());
	return Number.isFinite(value) && value > 0 ? value : STALE_MINUTES;
}

export function ledgers(explicitRoots: readonly string[] = []): LedgerRef[] {
	return discoverLedgers(scanRoots(explicitRoots));
}

/** 只读打开一个库并取全部页面数据。失败时把错误留给调用方 */
export function snapshot(ref: LedgerRef): LedgerSnapshot {
	const base: LedgerSnapshot = { slug: ref.slug, name: ref.name, dir: ref.dir, dbPath: ref.dbPath, ok: false };
	let db: DatabaseSync | undefined;
	try {
		// 只读打开，不迁移：看板不动库文件；schema 落后的库因此读不了，提示里去项目里升
		db = openLedger(ref.dbPath, true);
		return {
			...base,
			ok: true,
			states: statesOf(db),
			requirement: requirementOf(db),
			orders: listOrders(db, { history: true }),
			waiting: waitingOrders(db),
			stale: staleWaiting(db, staleMinutes()),
			dispatch: readDispatch(
				db,
				ref.dbPath,
				ref.dir,
				process.env.PI_PEER_ROOT?.trim() || path.join(os.homedir(), ".pi", "peers"),
			),
		};
	} catch (error) {
		return { ...base, error: readableError(readError(error), ref.dir) };
	} finally {
		db?.close();
	}
}

function withLedger<T>(ref: LedgerRef, fn: (db: DatabaseSync) => T): T {
	const db = openLedger(ref.dbPath, true);
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

export function orderPage(ref: LedgerRef, id: string): OrderPageData {
	return withLedger(ref, (db) => ({
		slug: ref.slug,
		project: ref.name,
		states: statesOf(db),
		view: getOrder(db, id),
		events: eventsOf(db, id, 20),
		comments: commentsOf(db, id, 50),
	}));
}

/**
 * 在页面上写一条评论。署名固定「用户」：页面后面坐着的只有人。
 *
 * 先只读打开一次再写：库比代码旧时那一步就抛「库需要从 X 升到 Y」，
 * 于是写路径不会顺手迁移 schema（看板只加评论这一行，不改结构），也省得第二次打开时才发现。
 */
export function postComment(ref: LedgerRef, id: string, body: string): OrderComment {
	withLedger(ref, () => undefined);
	const db = openLedger(ref.dbPath);
	try {
		return addComment(db, { orderId: id, actor: HUMAN_ACTOR, body });
	} finally {
		db.close();
	}
}

/**
 * 在页面上推一条工单的状态。署名固定「用户」：页面后面坐着的只有人。
 *
 * 流转校验全交给 core 的 updateOrder：单执行者状态、终态要终止依据、内容锁，这里不复制一份；
 * 传 expectedRevision 是为了拦住「页面开着、别的会话先改了」这种覆盖。
 */
export function advanceState(
	ref: LedgerRef,
	id: string,
	patch: UpdateInput,
	reason: string,
	expectedRevision?: number,
): OrderView {
	withLedger(ref, () => undefined);
	const db = openLedger(ref.dbPath);
	try {
		return updateOrder(db, id, patch, { actor: HUMAN_ACTOR, reason }, expectedRevision);
	} finally {
		db.close();
	}
}

/** 库版本旧时补上怎么升：光看「只读打开」这句，不知道下一步该干什么 */
function readableError(text: string, dir: string): string {
	if (!/库版本|库需要从/.test(text)) return text;
	return `${text}。在 ${dir} 里跑一次 /orders（或让 pi 打开这个项目）就会自动升级`;
}

function readError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 未收口的单：状态不是终态的 */
export function openOrders(l: LedgerSnapshot): ListedOrder[] {
	const terminal = new Set((l.states ?? []).filter((state) => state.terminal).map((state) => state.name));
	return (l.orders ?? []).filter((o) => !terminal.has(o.state));
}

/** 跨项目「需关注」：等人动手的单（action/decision），按等待最久排前 */
export interface AttentionItem {
	slug: string;
	project: string;
	order: Order;
	waiting: Waiting;
	stale: boolean;
}

export function attention(snapshots: readonly LedgerSnapshot[], limit = 10): AttentionItem[] {
	const items: AttentionItem[] = [];
	for (const l of snapshots) {
		if (!l.ok) continue;
		const open = new Set(openOrders(l).map((o) => o.id));
		const staleIds = new Set((l.stale ?? []).map((w) => w.order.id));
		for (const w of l.waiting ?? []) {
			if (w.kind === "dependency" || !open.has(w.order.id)) continue;
			items.push({ slug: l.slug, project: l.name, order: w.order, waiting: w, stale: staleIds.has(w.order.id) });
		}
	}
	items.sort((a, b) => Date.parse(a.waiting.since) - Date.parse(b.waiting.since));
	return items.slice(0, limit);
}
