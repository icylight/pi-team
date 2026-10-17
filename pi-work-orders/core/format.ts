/**
 * 给人和 agent 看的文本视图。纯函数，无副作用。
 *
 * 目标是一眼能扫：谁的活、卡在哪、下一步找谁。细节靠 orders_show。
 */

import type { DeliveryDeviation, ListedOrder, OrderEvent, OrderView, Waiting } from "./types.ts";

export function short(text: string, max = 60): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** 终端显示宽度：非 ASCII（中日韩、全角符号）按两列算 */
function width(s: string): number {
	let w = 0;
	for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
	return w;
}

/** 按显示宽度右补空格，表头与中文状态、角色名才能对齐 */
function pad(s: string, n: number): string {
	const gap = n - width(s);
	return gap > 0 ? s + " ".repeat(gap) : s;
}

/** 时长写法：分钟以内给分钟，一小时内给一位小数小时，再往上给小时 */
export function formatAgo(minutes: number): string {
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${Math.round(minutes)}m`;
	if (minutes < 24 * 60) return `${(minutes / 60).toFixed(1)}h`;
	return `${(minutes / 1440).toFixed(1)}d`;
}

/** 工期写法：带符号的偏差用这个，正数加 +，让人一眼看出多还是少 */
export function formatDelta(minutes: number): string {
	const body = formatAgo(Math.abs(minutes));
	if (minutes > 0) return `+${body}`;
	if (minutes < 0) return `-${body}`;
	return "±0m";
}

/** 有序候选：第一个是首选，其余是备选 */
function formatActors(actors: string[], width?: number): string {
	const head = actors[0] ?? "（无）";
	if (actors.length === 1) return width ? pad(head, width) : head;
	const rest = `（备选 ${actors.slice(1).join(", ")}）`;
	return width ? pad(head + rest, width) : head + rest;
}

export function formatList(orders: ListedOrder[], heading?: string, waiting: Waiting[] = []): string {
	if (!orders.length) return heading ? `${heading}：没有匹配的工单` : "没有匹配的工单";
	const reasons = new Map(waiting.filter((w) => w.kind !== "action").map((w) => [w.order.id, formatWaitingReason(w)]));
	const lines = orders.map((o) => {
		const id = pad(o.id, 6);
		const state = pad(o.state, 6);
		const who = formatActors(o.nextActors, 10);
		const dep = o.dependsOn.length ? short(o.dependsOn.join(", "), 24) : "-";
		const reason = reasons.get(o.id);
		return `${id}${state}${who}${pad(dep, 14)}${short(o.title, 70)}${reason ? `｜${reason}` : ""}`;
	});
	const head = `${pad("id", 6)}${pad("状态", 6)}${pad("下一步找", 10)}${pad("依赖", 14)}标题`;
	const body = [head, ...lines].join("\n");
	return heading ? `${heading}（${orders.length} 条）\n${body}` : body;
}

/**
 * 工期三行：估算、实际、偏差。缺哪块就省哪块——没估的单不该刷出空行，
 * 估了没收口的单要让读的人看到「还剩多少、已经过了几成」。
 */
function formatEffort(view: OrderView, deviation?: DeliveryDeviation): string[] {
	const lines: string[] = [];
	const est = view.estimate;
	if (est.activeMin != null || est.wallMin != null) {
		const parts: string[] = [];
		if (est.activeMin != null) parts.push(`主动 ${formatAgo(est.activeMin)}`);
		if (est.wallMin != null) parts.push(`墙钟 ${formatAgo(est.wallMin)}`);
		const basis = est.basis ? `（依据：${short(est.basis, 80)}）` : "";
		lines.push(`估算：${parts.join(" / ")}${basis}`);
	}
	const act = view.actual;
	if (act.activeMin != null || act.wallMin != null) {
		const parts: string[] = [];
		if (act.activeMin != null) parts.push(`主动 ${formatAgo(act.activeMin)}`);
		if (act.wallMin != null) parts.push(`墙钟 ${formatAgo(act.wallMin)}`);
		if (view.actualWaitMin != null) parts.push(`等依赖 ${formatAgo(view.actualWaitMin)}`);
		const deltas: string[] = [];
		if (deviation?.wallMin != null) deltas.push(`墙钟 ${formatDelta(deviation.wallMin)}`);
		if (deviation?.activeMin != null) deltas.push(`主动 ${formatDelta(deviation.activeMin)}`);
		const tail = deltas.length ? `｜偏差：${deltas.join(" / ")}` : "";
		lines.push(`实际：${parts.join(" / ")}${tail}`);
	}
	if (view.deliveryVariance) lines.push(`偏差原因：${short(view.deliveryVariance, 120)}`);
	if (view.placeholderBasis) lines.push(`可按占位继续：${short(view.placeholderBasis, 120)}`);
	return lines;
}

export function formatOrder(view: OrderView, extra: { deviation?: DeliveryDeviation } = {}): string {
	const lines: string[] = [];
	lines.push(`${view.id}｜${view.title}`);
	lines.push(`状态：${view.state}｜下一步找谁：${formatActors(view.nextActors)}`);
	if (view.dependsOn.length) {
		const stale = view.staleDeps.length ? `（其中已失效：${view.staleDeps.join(", ")}）` : "";
		lines.push(`依赖：${view.dependsOn.join(", ")}${stale}`);
	}
	if (view.blocks.length) lines.push(`下游：${view.blocks.join(", ")}`);
	const effort = formatEffort(view, extra.deviation);
	if (effort.length) lines.push(...effort);
	if (view.closingBasis) lines.push(`终止依据：${view.closingBasis}`);
	lines.push(
		`时间：建于 ${view.createdAt.slice(0, 16).replace("T", " ")}｜改于 ${view.updatedAt.slice(0, 16).replace("T", " ")}｜rev ${view.revision}`,
	);
	if (view.contents.length) {
		lines.push("内容入口：");
		for (const content of view.contents) lines.push(`- ${content.name}：${content.path}`);
	}
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

export function formatWaitingReason(w: Waiting): string {
	if (w.kind === "dependency") return `等依赖：${w.dependencies.map((dep) => `${dep.id} ${dep.state}`).join("、")}`;
	if (w.kind === "decision")
		return `上游已取消，需人工裁定：${w.dependencies
			.filter((dep) => dep.cancelled)
			.map((dep) => dep.id)
			.join("、")}`;
	return "";
}

/** 在等某人动的单：依赖等待不显示催办时长，保留阻塞原因。 */
export function formatWaiting(items: Waiting[], heading?: string, now = Date.now()): string {
	if (!items.length) return heading ? `${heading}：没有` : "没有";
	const lines = [...items]
		.sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
		.map((w) => {
			const waited =
				w.kind === "dependency" ? "不计催办" : formatAgo(Math.max(0, (now - Date.parse(w.since)) / 60_000));
			const o = w.order;
			const reason = formatWaitingReason(w);
			return `${o.id.padEnd(6)}${o.state.padEnd(6)}${waited.padStart(7)}  ${short(o.title, 60)}${reason ? `｜${reason}` : ""}`;
		});
	const head = `${"id".padEnd(6)}${"状态".padEnd(6)}${"等了".padStart(7)}  标题`;
	return [heading ? `${heading}（${items.length} 条）` : undefined, head, ...lines].filter(Boolean).join("\n");
}

/** 错误统一成一句，别把栈甩给 agent */
export function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
