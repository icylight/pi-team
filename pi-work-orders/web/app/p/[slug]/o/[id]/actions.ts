"use server";

import { refresh } from "next/cache";
import { ledgers, postComment } from "@/lib/ledger";

/** 提交后的回执：成功与失败互斥，`done` 每成功一次加一，客户端据此清空输入框 */
export interface CommentState {
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
