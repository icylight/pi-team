/**
 * 摘要与定时提醒共用的行：把「谁该动了」压成几行。
 *
 * 这里是纯逻辑——只读库、只拼文本，不发消息。投递（peer / 注入自己）由调用方决定，
 * 所以只用工单、不用 peer 的场景也走同一条路径。
 */

import type { DatabaseSync } from "node:sqlite";
import { formatAgo } from "./format.ts";
import { groupByActor, idleReady, listOrders, staleWaiting, waitedMinutes, waitingOrders } from "./store.ts";
import { HUMAN_ACTOR, isHumanActor, type Order, STALE_MINUTES, type Waiting } from "./types.ts";

export interface Digest {
	/** 未收口总数 */
	openCount: number;
	/** 等「我」动的（me 没给或不匹配时为空） */
	mine: Waiting[];
	/** 等太久还没动的（含等我的和等别人的） */
	stale: Waiting[];
	/** 依赖已解、还没人接的 */
	idle: Order[];
	/** 给会话上下文看的文本；没有要说的就为空串 */
	text: string;
}

/** 单条上限：摘要只用来点出「有东西在等」，不搬全文 */
const MAX_LINES = 5;

export function buildDigest(
	db: DatabaseSync,
	options: { me?: string; staleMinutes?: number; now?: number } = {},
): Digest {
	const now = options.now ?? Date.now();
	const staleMinutes = options.staleMinutes ?? STALE_MINUTES;
	const open = listOrders(db);
	const mine = options.me ? waitingOrders(db, options.me) : [];
	const stale = staleWaiting(db, staleMinutes);
	const idle = idleReady(db);

	return {
		openCount: open.length,
		mine,
		stale,
		idle,
		text: renderDigest({ openCount: open.length, mine, stale, idle }, now, staleMinutes),
	};
}

function renderDigest(d: Omit<Digest, "text">, now: number, staleMinutes: number): string {
	if (d.openCount === 0) return "";
	const lines: string[] = [`工单台账：${d.openCount} 条未收口`];

	if (d.mine.length) {
		lines.push(`等你的 ${d.mine.length} 条（从进当前状态算起）：`);
		for (const w of pickOldest(d.mine, MAX_LINES)) {
			lines.push(`  ${formatWaitingLine(w, now)}`);
		}
	}

	// 等别人的停滞单：等我的上面已经列过，这里只补别人手上的
	const others = d.stale.filter((s) => !d.mine.some((m) => m.order.id === s.order.id));
	if (others.length) {
		lines.push(`停滞超 ${staleMinutes}m 的 ${others.length} 条：`);
		for (const w of pickOldest(others, MAX_LINES)) {
			lines.push(`  ${formatWaitingLine(w, now, w.order.nextActors[0] ?? "（未指定）")}`);
		}
	}

	if (d.idle.length) {
		const ids = d.idle.slice(0, 8).map((o) => o.id);
		const more = d.idle.length > ids.length ? ` 等 ${d.idle.length} 条` : "";
		lines.push(`可开工还没人接：${ids.join("、")}${more}`);
	}

	// 等人工的单，peer 唤不到，只能靠人自己看
	const human = d.stale.filter((s) => isHumanActor(s.order.nextActors[0] ?? ""));
	if (human.length) {
		const ids = human.slice(0, 8).map((w) => w.order.id);
		const more = human.length > ids.length ? ` 等 ${human.length} 条` : "";
		lines.push(`等你拍板（${HUMAN_ACTOR}）：${ids.join("、")}${more}`);
	}

	if (lines.length === 1) lines.push("（没有在等人的单）");
	lines.push("处理用 orders_show / orders_update 回写；这条摘要在每次会话启动时重新算。");
	return lines.join("\n");
}

function pickOldest(items: Waiting[], limit: number): Waiting[] {
	return [...items].sort((a, b) => Date.parse(a.since) - Date.parse(b.since)).slice(0, limit);
}

/** 一条等待单的单行写法：摘要与定时提醒共用，省得两处对「等了多久」的描述跑偏 */
export function formatWaitingLine(w: Waiting, now: number, actor?: string): string {
	const who = actor ? `｜等 ${actor}` : "";
	return `${w.order.id} ${w.order.state} 等了 ${formatAgo(waitedMinutes(w, now))}${who}｜${w.order.title}`;
}

/** 按角色分组的停滞概览：给人看的（/orders stale 用） */
export function renderStale(db: DatabaseSync, options: { staleMinutes?: number; now?: number } = {}): string {
	const now = options.now ?? Date.now();
	const staleMinutes = options.staleMinutes ?? STALE_MINUTES;
	const stale = staleWaiting(db, staleMinutes);
	if (!stale.length) return `没有停滞超过 ${staleMinutes}m 的单`;
	const lines = [`停滞超 ${staleMinutes}m（${stale.length} 条）`];
	for (const { actor, items } of groupByActor(stale)) {
		lines.push(`${actor} 名下 ${items.length} 条：`);
		for (const w of pickOldest(items, MAX_LINES)) {
			lines.push(`  ${formatWaitingLine(w, now)}`);
		}
	}
	return lines.join("\n");
}

/**
 * 派工条：写库后投给对方的一句话。
 * 只带定位信息——对方会自己去 orders_show 读正文，避免正文在消息与库之间两份。
 */
export function buildWakeText(order: Order, kind: "assigned" | "handoff" | "unblocked"): string {
	if (isHumanActor(order.nextActors[0] ?? "")) {
		return `等你处理 ${order.id}：${order.title}\n状态 ${order.state}\n读正文：orders_show(id="${order.id}")`;
	}
	const head =
		kind === "handoff"
			? `${order.id} 交到你手上`
			: kind === "unblocked"
				? `${order.id} 的前置已收口，可以开工`
				: `新单 ${order.id}`;
	return `${head}：${order.title}\n状态 ${order.state}｜下一步找 ${order.nextActors.join(" → ")}\n读正文：orders_show(id="${order.id}")`;
}
