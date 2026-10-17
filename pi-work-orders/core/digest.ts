/**
 * 摘要与定时提醒共用的行：把「谁该动了」压成几行。
 *
 * 这里是纯逻辑——只读库、只拼文本，不发消息。投递（peer / 注入自己）由调用方决定，
 * 所以只用工单、不用 peer 的场景也走同一条路径。
 */

import type { DatabaseSync } from "node:sqlite";
import { formatAgo, formatDelta, formatWaitingReason, short } from "./format.ts";
import {
	dependencyWaitMinutes,
	estimateStatus,
	groupByActor,
	idleReady,
	listOrders,
	staleWaiting,
	type UpstreamArtifact,
	upstreamArtifacts,
	waitedMinutes,
	waitingOrders,
} from "./store.ts";
import { type EstimateStatus, HUMAN_ACTOR, isHumanActor, type Order, STALE_MINUTES, type Waiting } from "./types.ts";

export interface Digest {
	/** 未收口总数 */
	openCount: number;
	/** 等「我」处理的，不含依赖等待与单列的人工裁定。 */
	mine: Waiting[];
	blocked: Waiting[];
	decisions: Waiting[];
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
	const waiting = waitingOrders(db);
	const me = options.me;
	const mine = me ? waiting.filter((w) => w.kind === "action" && w.order.nextActors.includes(me)) : [];
	const blocked = waiting.filter((w) => w.kind === "dependency");
	const decisions = waiting.filter((w) => w.kind === "decision");
	const stale = staleWaiting(db, staleMinutes, undefined, now);
	const idle = idleReady(db);

	return {
		openCount: open.length,
		mine,
		blocked,
		decisions,
		stale,
		idle,
		text: renderDigest({ openCount: open.length, mine, blocked, decisions, stale, idle }, now, staleMinutes),
	};
}

function renderDigest(d: Omit<Digest, "text">, now: number, staleMinutes: number): string {
	if (d.openCount === 0) return "";
	const lines: string[] = [`工单台账：${d.openCount} 条未收口`];

	if (d.mine.length) {
		lines.push(`等你的 ${d.mine.length} 条（从可处理起点算起）：`);
		for (const w of pickOldest(d.mine, MAX_LINES)) {
			lines.push(`  ${formatWaitingLine(w, now)}`);
		}
	}

	if (d.blocked.length) {
		lines.push(`等依赖的 ${d.blocked.length} 条（不计催办）：`);
		for (const w of pickOldest(d.blocked, MAX_LINES))
			lines.push(`  ${formatWaitingLine(w, now, w.order.nextActors[0])}`);
	}
	if (d.decisions.length) {
		lines.push(`上游已取消，需人工裁定的 ${d.decisions.length} 条：`);
		for (const w of pickOldest(d.decisions, MAX_LINES))
			lines.push(`  ${formatWaitingLine(w, now, w.order.nextActors[0])}`);
	}

	// 已经列出的等待或裁定不重复占用停滞区。
	const shown = new Set([...d.mine, ...d.decisions].map((w) => w.order.id));
	const others = d.stale.filter((s) => !shown.has(s.order.id));
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
	const who = actor ? `｜下一步找 ${actor}` : "";
	const elapsed = w.kind === "dependency" ? "" : ` 等了 ${formatAgo(waitedMinutes(w, now))}`;
	const reason = formatWaitingReason(w);
	return `${w.order.id} ${w.order.state}${elapsed}${who}｜${w.order.title}${reason ? `｜${reason}` : ""}`;
}

/**
 * 估算类的单不是在等谁，不该显示「等了多久」。
 * 它还在做的过程中，等的是自己的时间预算。
 */
export function formatEstimateLine(w: Waiting): string {
	return `${w.order.id} ${w.order.state}｜${w.order.title}`;
}

/** 按角色分组的停滞概览：给人看的（/orders stale 用） */
export function renderStale(db: DatabaseSync, options: { staleMinutes?: number; now?: number } = {}): string {
	const now = options.now ?? Date.now();
	const staleMinutes = options.staleMinutes ?? STALE_MINUTES;
	const stale = staleWaiting(db, staleMinutes, undefined, now);
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
 * 派工前该知道的几件事：卡在哪个前置、前置留下了什么能直接用的东西、
 * 能不能先按占位往下做、以及哪些变化意味着「手上那份已经过期」。
 *
 * 不写进正文：正文是任务本身，这些是每次派工都会变的现场情况。
 */
export interface DispatchBrief {
	/** 当前还挡着的前置（已收口的不算） */
	dependencies: { id: string; state: string; cancelled: boolean }[];
	/** 近期已知产物：已收口上游写下的终止依据 */
	artifacts: UpstreamArtifact[];
	/** 可按占位继续的依据；null 表示必须等前置 */
	placeholder: string | null;
	/** 必须重读的信号：空表示手上那份还是最新的 */
	reread: string[];
	estimate: EstimateStatus;
	/** 等依赖的分钟数 */
	waitMin: number;
}

export function buildDispatchBrief(
	db: DatabaseSync,
	order: Order,
	options: { now?: number; heldRevision?: number } = {},
): DispatchBrief {
	const now = options.now ?? Date.now();
	const waiting = waitingOrders(db).find((w) => w.order.id === order.id);
	const dependencies = waiting?.dependencies ?? [];
	const artifacts = upstreamArtifacts(db, order.id);
	const estimate = estimateStatus(db, order, now);
	const waitMin = dependencyWaitMinutes(db, order, now);

	const reread: string[] = [];
	if (options.heldRevision != null && options.heldRevision !== order.revision) {
		reread.push(`库里的 rev 是 ${order.revision}，你手上是 ${options.heldRevision}`);
	}
	const cancelledDeps = dependencies.filter((dep) => dep.cancelled).map((dep) => dep.id);
	if (cancelledDeps.length) reread.push(`前置已取消：${cancelledDeps.join("、")}，依赖边需要裁定`);
	if (artifacts.length) reread.push(`上游已收口：${artifacts.map((a) => a.id).join("、")}，前置产物可以取下`);
	if (estimate.level === "over") reread.push(`估算已过 100%（${formatDelta(-(estimate.remainMin ?? 0))}）`);
	return {
		dependencies,
		artifacts,
		placeholder: order.placeholderBasis,
		reread,
		estimate,
		waitMin,
	};
}

/** 派工简报文：空块不占行，最多几行，篇幅与正文分开算 */
export function formatDispatchBrief(brief: DispatchBrief): string {
	const lines: string[] = [];
	if (brief.dependencies.length) {
		lines.push(`当前依赖：${brief.dependencies.map((dep) => `${dep.id} ${dep.state}`).join("、")}`);
	}
	if (brief.waitMin > 0) lines.push(`已等依赖 ${formatAgo(brief.waitMin)}`);
	if (brief.artifacts.length) {
		lines.push("近期已知产物：");
		for (const artifact of brief.artifacts) {
			// 终止依据常是一大段证据：这里只给指针的头部，细节读 orders_show(id=上游)
			const pointer = artifact.closingBasis ? ` → ${short(artifact.closingBasis, 100)}` : "（上游没写终止依据）";
			lines.push(`- ${artifact.id}${pointer}`);
		}
	}
	if (brief.placeholder) lines.push(`可按占位继续：${brief.placeholder}`);
	else if (brief.dependencies.length) lines.push("不可按占位继续：必须等前置收口");
	if (brief.estimate.level === "warn" || brief.estimate.level === "over") {
		const pct = Math.round((brief.estimate.ratio ?? 0) * 100);
		lines.push(
			brief.estimate.level === "over"
				? `估算已过 100%（已用 ${pct}%，超 ${formatAgo(-(brief.estimate.remainMin ?? 0))}）`
				: `估算已用 ${pct}%，还剩 ${formatAgo(brief.estimate.remainMin ?? 0)}`,
		);
	}
	if (brief.reread.length) {
		lines.push("必须重读：");
		for (const signal of brief.reread) lines.push(`- ${signal}`);
	}
	return lines.join("\n");
}

/**
 * 派工条：写库后投给对方的一句话。
 * 只带定位信息——对方会自己去 orders_show 读正文，避免正文在消息与库之间两份。
 */
export function buildWakeText(
	order: Order,
	kind: "assigned" | "handoff" | "unblocked",
	/** 给了库就带上现场情况：依赖、前置产物、能否占位、要不要重读 */
	brief?: DispatchBrief,
): string {
	const tail = brief ? formatDispatchBrief(brief) : "";
	const extra = tail ? `\n${tail}` : "";
	if (isHumanActor(order.nextActors[0] ?? "")) {
		return `等你处理 ${order.id}：${order.title}\n状态 ${order.state}\n读正文：orders_show(id="${order.id}")${extra}`;
	}
	const head =
		kind === "handoff"
			? `${order.id} 交到你手上`
			: kind === "unblocked"
				? `${order.id} 的前置已收口，可以开工`
				: `新单 ${order.id}`;
	return `${head}：${order.title}\n状态 ${order.state}｜下一步找 ${order.nextActors.join(" → ")}\n读正文：orders_show(id="${order.id}")${extra}`;
}
