/**
 * 定时提醒：让一个角色会话隔一会儿自查一次停滞的单，把该动的推到它自己眼前。
 *
 * 分工：这里只读配置、挑出这轮该提的单、拼一条文本；定时器、注入与身份识别在 index.ts。
 * 与 digest.ts 的区别：那边是「每轮对话开始时算一份上下文」；这边是「没人动时按时间自己响」。
 *
 * 配置写在 pi-peer 的项目配置里（<项目>/.pi/peer.json）——定时提醒跟的就是 peer 的角色，
 * 项目有哪些角色、谁负责提，放一处看：
 *   { "enabled": true, "workOrders": { "followRole": "owner" } }
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { formatWaitingLine } from "./digest.ts";
import { groupByActor, staleWaiting } from "./store.ts";
import { isHumanActor, STALE_MINUTES, type Waiting } from "./types.ts";

export interface WatchConfig {
	/** 谁负责定时自查：角色名（peer 角色实例名，其次会话名）；空串 = 不跑 */
	followRole: string;
	/** 隔多少分钟看一次 */
	intervalMinutes: number;
	/** 等超过多少分钟算停滞 */
	staleMinutes: number;
	/** 同一条单最短隔多少分钟再提一次 */
	repeatMinutes: number;
}

export const WATCH_DEFAULTS: WatchConfig = {
	followRole: "",
	intervalMinutes: 15,
	staleMinutes: STALE_MINUTES,
	repeatMinutes: 60,
};

/** 每条单上次提醒时的等待阶段与时刻：阶段没变、又没到 repeat，就不重复提 */
export type WatchState = Record<string, { since: string; at: number }>;

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
	if (source.followRole !== undefined) {
		if (typeof source.followRole === "string") target.followRole = source.followRole.trim();
		else problems.push(`${file}：workOrders.followRole 要写角色名字符串，这一项被忽略`);
	}
	for (const key of ["intervalMinutes", "staleMinutes", "repeatMinutes"] as const) {
		const value = source[key];
		if (value === undefined) continue;
		if (typeof value === "number" && Number.isFinite(value) && value > 0) target[key] = value;
		else problems.push(`${file}：workOrders.${key} 要写正数，这一项被忽略`);
	}
}

/**
 * 这一轮该提什么。空串就是不提——库里没有停滞的单，或者该提的刚才提过。
 * state 只记「这条单在等什么阶段、上次什么时候提的」：阶段一变（进了新状态）就重开一轮提醒。
 */
export function buildWatchText(
	db: DatabaseSync,
	options: { me: string; config: WatchConfig; state?: WatchState; now?: number },
): { text: string; state: WatchState } {
	const now = options.now ?? Date.now();
	const repeatMs = options.config.repeatMinutes * 60_000;
	const stale = staleWaiting(db, options.config.staleMinutes, undefined, now);
	const state: WatchState = {};
	const due: Waiting[] = [];

	for (const item of stale) {
		const last = options.state?.[item.order.id];
		if (!last || last.since !== item.since || now - last.at >= repeatMs) {
			state[item.order.id] = { since: item.since, at: now };
			due.push(item);
		} else {
			state[item.order.id] = last;
		}
	}
	if (!due.length) return { text: "", state };
	return { text: renderNote(due, options.me, options.config, now), state };
}

/** 一个角色名下最多列几条：提醒要短，列不下就说还有多少 */
const MAX_LINES = 5;

function renderNote(due: Waiting[], me: string, config: WatchConfig, now: number): string {
	const lines = [
		`【工单台账 · 定时提醒】这轮 ${due.length} 条停滞单（每 ${config.intervalMinutes}m 自查，等超 ${config.staleMinutes}m 即提醒）`,
	];
	// 等这个角色自己的排最前：那是它该动的；排在后面的是别人的，可以改派
	const groups = groupByActor(due).sort((a, b) => Number(b.actor === me) - Number(a.actor === me));
	for (const group of groups) {
		const items = [...group.items].sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
		const who = isHumanActor(group.actor)
			? `等 ${group.actor} 的 ${items.length} 条（人不在会话里，叫不动）：`
			: group.actor === me
				? `等你动的 ${items.length} 条：`
				: `等 ${group.actor} 的 ${items.length} 条：`;
		lines.push(who);
		for (const item of items.slice(0, MAX_LINES)) lines.push(`  ${formatWaitingLine(item, now)}`);
		if (items.length > MAX_LINES) lines.push(`  ……另有 ${items.length - MAX_LINES} 条，用 orders_list 看全`);
	}
	lines.push(
		"下一步：orders_show(id=…) 读正文；接不下的改派给别的角色（orders_update 的 nextActors），收口要带终止依据。",
	);
	return lines.join("\n");
}
