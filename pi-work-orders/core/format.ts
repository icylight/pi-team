/**
 * 给人和 agent 看的文本视图。纯函数，无副作用。
 *
 * 目标是一眼能扫：谁的活、卡在哪、下一步找谁。细节靠 orders_show。
 */

import type { Order, OrderEvent, OrderView, Waiting } from "./types.ts";

function short(text: string, max = 60): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** 时长写法：分钟以内给分钟，一小时内给一位小数小时，再往上给小时 */
export function formatAgo(minutes: number): string {
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${Math.round(minutes)}m`;
	if (minutes < 24 * 60) return `${(minutes / 60).toFixed(1)}h`;
	return `${(minutes / 1440).toFixed(1)}d`;
}

/** 有序候选：第一个是首选，其余是备选 */
function formatActors(actors: string[], width?: number): string {
	const head = actors[0] ?? "（无）";
	if (actors.length === 1) return width ? head.padEnd(width) : head;
	const rest = `（备选 ${actors.slice(1).join(", ")}）`;
	return width ? (head + rest).padEnd(width) : head + rest;
}

export function formatList(orders: Order[], heading?: string): string {
	if (!orders.length) return heading ? `${heading}：没有匹配的工单` : "没有匹配的工单";
	const lines = orders.map((o) => {
		const id = o.id.padEnd(6);
		const state = o.state.padEnd(6);
		const who = formatActors(o.nextActors, 10);
		return `${id}${state}${who}${short(o.title, 70)}`;
	});
	const head = `${"id".padEnd(6)}${"状态".padEnd(6)}${"下一步找".padEnd(10)}标题`;
	const body = [head, ...lines].join("\n");
	return heading ? `${heading}（${orders.length} 条）\n${body}` : body;
}

export function formatOrder(view: OrderView): string {
	const lines: string[] = [];
	lines.push(`${view.id}｜${view.title}`);
	lines.push(`状态：${view.state}｜下一步找谁：${formatActors(view.nextActors)}`);
	if (view.dependsOn.length) {
		const stale = view.staleDeps.length ? `（其中已失效：${view.staleDeps.join(", ")}）` : "";
		lines.push(`依赖：${view.dependsOn.join(", ")}${stale}`);
	}
	if (view.blocks.length) lines.push(`下游：${view.blocks.join(", ")}`);
	if (view.closingBasis) lines.push(`终止依据：${view.closingBasis}`);
	lines.push(
		`时间：建于 ${view.createdAt.slice(0, 16).replace("T", " ")}｜改于 ${view.updatedAt.slice(0, 16).replace("T", " ")}｜rev ${view.revision}`,
	);
	if (view.body.trim()) {
		lines.push("─".repeat(40));
		lines.push(view.body.trim());
	}
	return lines.join("\n");
}

/** 一条单的动作记录：谁、何时、从哪到哪、为什么 */
export function formatHistory(events: OrderEvent[]): string {
	if (!events.length) return "还没有动作记录";
	return events
		.map((e) => {
			const when = e.at.slice(5, 16).replace("T", " ");
			const move = e.fromState && e.toState ? `${e.fromState} → ${e.toState}` : (e.toState ?? e.kind);
			const note = e.note ? `｜${short(e.note, 50)}` : "";
			return `${when} ${e.actor} ${move}${note}`;
		})
		.join("\n");
}

/** 在等某人动的单：等多久 + 找谁 + 标题 */
export function formatWaiting(items: Waiting[], heading?: string, now = Date.now()): string {
	if (!items.length) return heading ? `${heading}：没有` : "没有";
	const lines = [...items]
		.sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
		.map((w) => {
			const waited = formatAgo(Math.max(0, (now - Date.parse(w.since)) / 60_000));
			const o = w.order;
			return `${o.id.padEnd(6)}${o.state.padEnd(6)}${waited.padStart(7)}  ${short(o.title, 60)}`;
		});
	const head = `${"id".padEnd(6)}${"状态".padEnd(6)}${"等了".padStart(7)}  标题`;
	return [heading ? `${heading}（${items.length} 条）` : undefined, head, ...lines]
		.filter(Boolean)
		.join("\n");
}

/** 错误统一成一句，别把栈甩给 agent */
export function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
