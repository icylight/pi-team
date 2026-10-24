"use client";

import { useActionState, useState } from "react";
import { submitComment, type CommentState } from "./actions";

const INITIAL: CommentState = { done: 0 };

/**
 * 写评论的表单。成功一次清空输入框，失败保留内容并在按钮旁给原因。
 * 清空走「渲染期对齐 state」而不是 effect：effect 会多一顿渲染，也过不了 lint 的 set-state-in-effect。
 * 署名固定「用户」，不给人改：这里就是人自己写的。
 */
export function CommentForm({ slug, id }: { slug: string; id: string }) {
	const [state, action, pending] = useActionState(submitComment, INITIAL);
	const [body, setBody] = useState("");
	const [handled, setHandled] = useState(INITIAL.done);

	if (handled !== state.done) {
		setHandled(state.done);
		setBody("");
	}

	return (
		<form action={action} className="mt-3">
			<input type="hidden" name="slug" value={slug} />
			<input type="hidden" name="id" value={id} />
			<textarea
				name="body"
				value={body}
				onChange={(e) => setBody(e.target.value)}
				required
				rows={3}
				placeholder="写一条评论：为什么这样判、看到什么、留给后面接手的人"
				className="w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
			/>
			<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
				<button
					type="submit"
					disabled={pending}
					className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
				>
					{pending ? "提交中…" : "写评论"}
				</button>
				{state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
			</div>
		</form>
	);
}
