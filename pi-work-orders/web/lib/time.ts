/** 时间换算：把库里的 ISO 时间戳转成页面上的「多久了」。formatAgo 复用工单包 core。 */
export { formatAgo } from "../../core/format.ts";

/** 页面统一的「现在」。集中一处，避免散落的 Date.now 调用 */
export function nowMs(): number {
	return Date.now();
}

export function minutesSince(iso: string, now: number): number {
	const at = Date.parse(iso);
	return Number.isFinite(at) ? Math.max(0, (now - at) / 60_000) : 0;
}

/** 绝对时刻：`2026-10-11 12:48`，给悬浮提示与详情页用 */
export function stamp(iso: string): string {
	return iso.slice(0, 16).replace("T", " ");
}