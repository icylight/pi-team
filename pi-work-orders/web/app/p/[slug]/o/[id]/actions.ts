"use server";

import { refresh } from "next/cache";
import { advanceState, ledgers, postComment } from "@/lib/ledger";

/** 提交后的回执：成功与失败互斥，`done` 每成功一次加一，客户端据此清空输入框 */
export interface CommentState {
	error?: string;
	done: number;
}

/** 状态表单的回执：同上，成功后客户端据此收起表单 */
export interface StateChangeState {
	error?: string;
	done: number;
}

/**
 * 详情页写评论。库定位靠表单里的 slug：路由段只用来找人，落库认的是真实库文件。
 *
 * 出错回值不回抛：库版本落后、单号没了这类事，页面上一行字比一整页报错有用。
 */
export async function submitComment(previous: CommentState, formData: FormData): Promise<CommentState> {
	const slug = String(formData.get("slug") ?? "");
	const id = String(formData.get("id") ?? "");
	const body = String(formData.get("body") ?? "");

	if (!body.trim()) return { ...previous, error: "评论内容不能为空" };
	const ref = ledgers().find((r) => r.slug === slug);
	if (!ref) return { ...previous, error: "找不到这个项目的工单库，刷新页面后重试" };

	try {
		postComment(ref, id, body);
	} catch (error) {
		return { ...previous, error: error instanceof Error ? error.message : String(error) };
	}

	// 页面全按 force-dynamic 渲染，这里只是让客户端路由重取一次 RSC，评论立刻出现
	refresh();
	return { done: previous.done + 1 };
}

/**
 * 详情页推状态。表单只带「变成什么、为什么、终止依据、下一步找谁」，其余字段一律不传，
 * 于是正文、类型、锁与工时都保持库里原样。
 *
 * 空值与无效值在这里先挡一道，给出人看得懂的话；真正能不能从 A 走到 B 由 core 判，
 * 它报的错（已有执行者、终态缺终止依据、版本冲突）原样透到页面上。
 */
export async function submitState(previous: StateChangeState, formData: FormData): Promise<StateChangeState> {
	const slug = String(formData.get("slug") ?? "");
	const id = String(formData.get("id") ?? "");
	const current = String(formData.get("current") ?? "");
	const currentNext = parseActors(String(formData.get("currentNext") ?? ""));
	const state = String(formData.get("state") ?? "").trim();
	const reason = String(formData.get("reason") ?? "").trim();
	const closingBasis = String(formData.get("closingBasis") ?? "").trim();
	const nextActor = String(formData.get("nextActor") ?? "").trim();
	const revision = Number(formData.get("revision"));

	if (!state) return { ...previous, error: "选一个目标状态" };
	if (!reason) return { ...previous, error: "改状态要写理由：为什么这么推，后面接手的人靠它判" };
	// 状态没变、下一步也没变，提交下去只涨一次 revision，页面上什么都不变：先挡住
	if (state === current) {
		if (!nextActor) return { ...previous, error: `已经在「${state}」：换个目标状态，或者只改下一步找谁` };
		if (currentNext.includes(nextActor)) {
			return { ...previous, error: `没变化：状态已经是「${state}」，下一步也已经是 ${nextActor}` };
		}
	}
	const ref = ledgers().find((r) => r.slug === slug);
	if (!ref) return { ...previous, error: "找不到这个项目的工单库，刷新页面后重试" };

	try {
		advanceState(
			ref,
			id,
			{ state, closingBasis: closingBasis || undefined, nextActors: nextActor ? [nextActor] : undefined },
			reason,
			Number.isFinite(revision) ? revision : undefined,
		);
	} catch (error) {
		return { ...previous, error: error instanceof Error ? error.message : String(error) };
	}

	refresh();
	return { done: previous.done + 1 };
}

/** 隐藏域里带过来的当前候选项：不是合法 JSON 就当空，不因此拦住提交 */
function parseActors(raw: string): string[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === "string") : [];
	} catch {
		return [];
	}
}
