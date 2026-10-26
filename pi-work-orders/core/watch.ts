/**
 * 定时提醒：让一个角色会话隔一会儿自查一次停滞的单，把该动的推到它自己眼前。
 *
 * 分工：这里只读配置、挑出这轮该提的单、拼一条文本；定时器、注入与身份识别在 index.ts。
 * 与 digest.ts 的区别：那边是「每轮对话开始时算一份上下文」；这边是「没人动时按时间自己响」。
 *
 * 配置写在 pi-peer 的项目配置里（<项目>/.pi/peer.json）——定时提醒跟的就是 peer 的角色，
 * 项目有哪些角色、谁负责提，放一处看：
 *   { "enabled": true, "workOrders": { "followRole": "owner", "digest": true } }
 *
 * AI(TAG): [工单通知] 自动出声的两种（定时提醒、系统提示摘要）都默认关，项目里显式写才开——
 * 没人配就是安静台账，配了哪项就只响哪项。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { formatEstimateLine, formatWaitingLine } from "./digest.ts";
import { formatAgo } from "./format.ts";
import {
	dependencyWaitMinutes,
	estimateStatus,
	groupByActor,
	listOrders,
	staleWaiting,
	waitingOrders,
} from "./store.ts";
import { isHumanActor, STALE_MINUTES, WAIT_MINUTES, type Waiting } from "./types.ts";

export interface WatchConfig {
	/**
	 * 写库后是否把工单交接投给下一步的人：**默认不发**，项目里写 true 才发。
	 * 不发时不落通知记录，接的人自己扫台账发现（定时提醒不受影响）。
	 */
	handoff: boolean;
	/** 谁负责定时自查：角色名（peer 角色实例名，其次会话名）；空串 = 不跑 */
	followRole: string;
	/** 隔多少分钟看一次 */
	intervalMinutes: number;
	/** 等超过多少分钟算停滞 */
	staleMinutes: number;
	/** 同一条单最短隔多少分钟再提一次 */
	repeatMinutes: number;
	/** 等依赖超过多少分钟提醒一次（与停滞分开：等依赖不是谁没干活） */
	waitMinutes: number;
	/** 每轮对话把台账摘要注入系统提示：默认关，显式写 true 才注入 */
	digest: boolean;
	/** 提醒末尾的提示词：空串 = 用内置那两行；占位符见 README 的配置表 */
	prompt: string;
}

export const WATCH_DEFAULTS: WatchConfig = {
	handoff: false,
	followRole: "",
	intervalMinutes: 15,
	staleMinutes: STALE_MINUTES,
	repeatMinutes: 60,
	waitMinutes: WAIT_MINUTES,
	digest: false,
	prompt: "",
};

/**
 * 每条单上次提醒时的等待阶段、提醒理由与时刻。
 * 阶段或理由变了就重开一轮提醒——估算从 80% 走到 100% 是两条信息，不该被 repeat 压掉。
 */
export type WatchState = Record<string, { since: string; at: number; reason?: WatchReason }>;

/** 提醒理由：不只催进度，也报等太久与估算将到 */
export type WatchReason = "stall" | "wait" | "estimate-warn" | "estimate-over";

/**
 * 本会话是不是这个角色的实例：owner 匹配 owner 与 owner-2。
 * 角色名空着时谁都匹配不上——不配就不跑，是默认行为。
 */
export function followsRole(identity: string, role: string): boolean {
	const who = identity.trim();
	const want = role.trim();
	if (!who || !want) return false;
	return who === want || who.startsWith(`${want}-`);
}

/** 配置只在项目里：peer 的项目配置文件，跟角色声明同一份 */
export function watchConfigFile(cwd: string): string {
	return path.join(cwd, ".pi", "peer.json");
}

/**
 * 读配置。写错的字段不回退成默认值硬跑——收进 problems 交给调用方说出来，
 * 免得「配了但没生效」只能靠猜。
 */
export function loadWatchConfig(file: string): { config: WatchConfig; problems: string[] } {
	const problems: string[] = [];
	const config = { ...WATCH_DEFAULTS };
	const section = readSection(file, problems);
	if (section) applyConfig(config, section, file, problems);
	return { config, problems };
}

/** 没有这份文件、或者没写 workOrders 一段，都是正常情况；写了但读不动才算问题 */
function readSection(file: string, problems: string[]): Record<string, unknown> | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch (error) {
		problems.push(`${file}：JSON 解析失败（${(error as Error).message}）`);
		return undefined;
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		problems.push(`${file}：要写成一个 JSON 对象`);
		return undefined;
	}
	const section = (data as Record<string, unknown>).workOrders;
	if (section === undefined) return undefined;
	if (!section || typeof section !== "object" || Array.isArray(section)) {
		problems.push(`${file}：workOrders 要写成一个对象`);
		return undefined;
	}
	return section as Record<string, unknown>;
}

function applyConfig(target: WatchConfig, source: Record<string, unknown>, file: string, problems: string[]): void {
	if (source.handoff !== undefined) {
		if (typeof source.handoff === "boolean") target.handoff = source.handoff;
		else problems.push(`${file}：workOrders.handoff 要写 true 或 false，这一项被忽略`);
	}
	if (source.followRole !== undefined) {
		if (typeof source.followRole === "string") target.followRole = source.followRole.trim();
		else problems.push(`${file}：workOrders.followRole 要写角色名字符串，这一项被忽略`);
	}
	for (const key of ["intervalMinutes", "staleMinutes", "repeatMinutes", "waitMinutes"] as const) {
		const value = source[key];
		if (value === undefined) continue;
		if (typeof value === "number" && Number.isFinite(value) && value > 0) target[key] = value;
		else problems.push(`${file}：workOrders.${key} 要写正数，这一项被忽略`);
	}
	if (source.digest !== undefined) {
		if (typeof source.digest === "boolean") target.digest = source.digest;
		else problems.push(`${file}：workOrders.digest 要写 true 或 false，这一项被忽略`);
	}
	if (source.prompt !== undefined) {
		const value = source.prompt;
		// 空串与没配等价，但「显式写了个空的」按写错报出来：静默当没配，配的人会以为生效了
		if (typeof value !== "string") problems.push(`${file}：workOrders.prompt 要写字符串，这一项被忽略`);
		else if (!value.trim()) problems.push(`${file}：workOrders.prompt 是空串，这一项被忽略（不配就用内置文案）`);
		else target.prompt = value;
	}
}

/**
 * 一条被提上来的单：等它在等人的位置（Waiting），加上这次为什么提。
 * 同一个理由下一轮还在就按 repeat 压；理由变了（80% → 100%）立刻提。
 */
export interface WatchDue {
	waiting: Waiting;
	reason: WatchReason;
	/** 这条理由下的一句话说明，如「估算已用 82%，还剩 40m」 */
	detail: string;
}

/** 理由的紧迫度：同一条单命中多条时留最该说的那条 */
const REASON_RANK: Record<WatchReason, number> = {
	"estimate-over": 3,
	stall: 2,
	wait: 1,
	"estimate-warn": 0,
};

/**
 * 这一轮该提什么单。三类分开收，同一条单只留最紧迫的理由：
 * 停滞（有人该动却没动）、等依赖超阈值（谁都没错，但连续着要报）、估算到 80% / 100%。
 */
export function collectDue(db: DatabaseSync, config: WatchConfig, now = Date.now()): WatchDue[] {
	const picked = new Map<string, WatchDue>();
	const put = (item: WatchDue) => {
		if ((picked.get(item.waiting.order.id)?.reason ?? null) === null) {
			picked.set(item.waiting.order.id, item);
			return;
		}
		const current = picked.get(item.waiting.order.id)!;
		if (REASON_RANK[item.reason] > REASON_RANK[current.reason]) picked.set(item.waiting.order.id, item);
	};

	for (const waiting of staleWaiting(db, config.staleMinutes, undefined, now)) {
		put({ waiting, reason: "stall", detail: `停滞超 ${config.staleMinutes}m` });
	}

	for (const order of listOrders(db)) {
		const estimate = estimateStatus(db, order, now);
		if (estimate.level === "warn" || estimate.level === "over") {
			const waiting: Waiting = { order, kind: "action", dependencies: [], since: order.updatedAt };
			const detail =
				estimate.level === "over"
					? `估算已过 100%，超 ${formatAgo(-(estimate.remainMin ?? 0))}`
					: `估算已用 ${Math.round((estimate.ratio ?? 0) * 100)}%，还剩 ${formatAgo(estimate.remainMin ?? 0)}`;
			put({
				waiting,
				reason: estimate.level === "over" ? "estimate-over" : "estimate-warn",
				detail,
			});
		}
	}

	for (const waiting of waitingOrders(db)) {
		if (waiting.kind !== "dependency") continue;
		const waited = dependencyWaitMinutes(db, waiting.order, now);
		if (waited < config.waitMinutes) continue;
		// 换过依赖边就说明「整段多久、当前这组多久」，只报后者会让人以为整段都短
		const whole = waiting.blockedSince
			? Math.max(0, Math.round((now - Date.parse(waiting.blockedSince)) / 60_000))
			: waited;
		const detail =
			whole > waited
				? `等依赖整段 ${formatAgo(whole)}，当前这组 ${formatAgo(waited)}`
				: `等依赖已 ${formatAgo(waited)}`;
		put({ waiting, reason: "wait", detail });
	}

	return [...picked.values()].sort((a, b) => Date.parse(a.waiting.since) - Date.parse(b.waiting.since));
}

/**
 * 这一轮该提的文本。空串就是不提——库里没有该提的单，或者该提的刚才提过。
 * state 只记「这条单在等什么阶段、因为什么提的、上次什么时候提的」。
 */
export function buildWatchText(
	db: DatabaseSync,
	options: { me: string; config: WatchConfig; state?: WatchState; now?: number },
): { text: string; state: WatchState } {
	const now = options.now ?? Date.now();
	const repeatMs = options.config.repeatMinutes * 60_000;
	const state: WatchState = {};
	const due: WatchDue[] = [];

	for (const item of collectDue(db, options.config, now)) {
		const id = item.waiting.order.id;
		const last = options.state?.[id];
		const changed = !last || last.since !== item.waiting.since || last.reason !== item.reason;
		if (changed || now - last.at >= repeatMs) {
			state[id] = { since: item.waiting.since, at: now, reason: item.reason };
			due.push(item);
		} else {
			state[id] = last;
		}
	}
	if (!due.length) return { text: "", state };
	return { text: renderNote(due, options.me, options.config, now), state };
}

/** 一个角色名下最多列几条：提醒要短，列不下就说还有多少 */
const MAX_LINES = 5;

function renderNote(due: WatchDue[], me: string, config: WatchConfig, now: number): string {
	const counts = new Map<WatchReason, number>();
	for (const item of due) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
	const parts = [...counts.entries()].map(([reason, n]) => `${REASON_LABEL[reason]} ${n} 条`);
	const lines = [
		`【工单台账 · 定时提醒】这轮 ${due.length} 条（每 ${config.intervalMinutes}m 自查）：${parts.join("、")}`,
	];
	// 等这个角色自己的排最前：那是它该动的；排在后面的是别人的，可以改派
	const groups = groupByActor(due.map((d) => d.waiting)).sort(
		(a, b) => Number(b.actor === me) - Number(a.actor === me),
	);
	const detailOf = new Map(due.map((d) => [d.waiting.order.id, d.detail]));
	const reasonOf = new Map(due.map((d) => [d.waiting.order.id, d.reason]));
	for (const group of groups) {
		const items = [...group.items].sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
		const who = isHumanActor(group.actor)
			? `等 ${group.actor} 的 ${items.length} 条（人不在会话里，叫不动）：`
			: group.actor === me
				? `等你动的 ${items.length} 条：`
				: `等 ${group.actor} 的 ${items.length} 条：`;
		lines.push(who);
		for (const item of items.slice(0, MAX_LINES)) {
			const detail = detailOf.get(item.order.id);
			const reason = reasonOf.get(item.order.id);
			const line =
				reason === "estimate-warn" || reason === "estimate-over"
					? formatEstimateLine(item)
					: formatWaitingLine(item, now);
			lines.push(`  ${line}${detail ? `｜${detail}` : ""}`);
		}
		if (items.length > MAX_LINES) lines.push(`  ……另有 ${items.length - MAX_LINES} 条，用 orders_list 看全`);
	}
	for (const line of footerLines(due.length, me, config)) lines.push(line);
	return lines.join("\n");
}

/**
 * 不配置时提醒末尾的两行。**这是默认路径的一部分**：改它等于改所有项目的提醒，
 * 只想让某个项目换个说法就配 `workOrders.prompt`，别动这里。
 */
const DEFAULT_PROMPT_LINES = [
	"这一步只报读数，不是催进度：估算到了就复核估算，等依赖太久就查前置进度或改派（orders_update 的 nextActors）。",
	"下一步：orders_show(id=…) 读正文；收口要带终止依据。",
];

/**
 * 末尾提示词：配了就用配的那段（占位符按本轮读数替换），没配就用默认两行。
 * 模板按原换行拆开——提醒是一段多行文本，不是一行。
 */
function footerLines(count: number, me: string, config: WatchConfig): string[] {
	if (!config.prompt.trim()) return [...DEFAULT_PROMPT_LINES];
	const filled = config.prompt
		.replaceAll("{count}", String(count))
		.replaceAll("{interval}", String(config.intervalMinutes))
		.replaceAll("{me}", me);
	return filled.split("\n");
}

const REASON_LABEL: Record<WatchReason, string> = {
	stall: "停滞",
	wait: "等依赖超时",
	"estimate-warn": "估算将到",
	"estimate-over": "估算超期",
};
