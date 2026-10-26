"use client";

import { useActionState, useState } from "react";
import type { StateDef } from "../../../../../../core/types";
import { type StateChangeState, submitState } from "./actions";

const INITIAL: StateChangeState = { done: 0 };

/**
 * 推状态的表单：默认收起，点开时按当前状态重置一遍输入。
 *
 * 目标状态声明的 needsBasis 决定「终止依据」那一栏出不出现——只是免得人提交了才被退回来；
 * 能不能真走过去（单执行者、终态要依据、版本冲突）由 core 判，报错原样显示。
 */
export function StateForm({
	slug,
	id,
	state,
	revision,
	nextActors,
	states,
}: {
	slug: string;
	id: string;
	state: string;
	revision: number;
	nextActors: readonly string[];
	states: readonly StateDef[];
}) {
	const [result, action, pending] = useActionState(submitState, INITIAL);
	const [open, setOpen] = useState(false);
	const [target, setTarget] = useState(state);
	const [reason, setReason] = useState("");
	const [basis, setBasis] = useState("");
	const [actor, setActor] = useState("");
	const [handled, setHandled] = useState(INITIAL.done);

	// 成功一次收起表单：字段留空，展开时再按最新状态重置
	if (handled !== result.done) {
		setHandled(result.done);
		setOpen(false);
	}

	const targetDef = states.find((def) => def.name === target);

	function toggle() {
		if (!open) {
			setTarget(state);
			setReason("");
			setBasis("");
			setActor("");
		}
		setOpen(!open);
	}

	return (
		<div className="mt-3">
			<button
				type="button"
				onClick={toggle}
				aria-expanded={open}
				className="rounded-md border px-2.5 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
			>
				{open ? "收起" : "改状态"}
			</button>

			{open ? (
				<form action={action} className="mt-2 rounded-lg border bg-card px-3 py-3">
					<input type="hidden" name="slug" value={slug} />
					<input type="hidden" name="id" value={id} />
					<input type="hidden" name="current" value={state} />
					<input type="hidden" name="currentNext" value={JSON.stringify(nextActors)} />
					<input type="hidden" name="revision" value={revision} />

					<div className="flex flex-wrap items-start gap-x-4 gap-y-2 text-sm">
						<label className="flex flex-col gap-1">
							<span className="text-muted-foreground">状态</span>
							<select
								name="state"
								value={target}
								onChange={(e) => setTarget(e.target.value)}
								className="rounded-md border bg-background px-2 py-1"
							>
								{states.map((def) => (
									<option key={def.name} value={def.name}>
										{def.name}
										{def.name === state ? "（当前）" : ""}
									</option>
								))}
							</select>
						</label>
						<label className="flex flex-col gap-1">
							<span className="text-muted-foreground">下一步找谁</span>
							<input
								name="nextActor"
								value={actor}
								onChange={(e) => setActor(e.target.value)}
								placeholder={nextActors.length ? `现在是 ${nextActors.join("、")}` : "（未指定）"}
								className="rounded-md border bg-background px-2 py-1"
							/>
							<span className="text-xs text-muted-foreground">留空＝不改，只填一个人</span>
						</label>
					</div>

					<label className="mt-2 flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">理由</span>
						<textarea
							name="reason"
							value={reason}
							onChange={(e) => setReason(e.target.value)}
							required
							rows={2}
							placeholder="为什么这么推：做了什么、看到什么、后面接手的人要做什么"
							className="w-full resize-y rounded-md border bg-background px-2 py-1.5 leading-relaxed"
						/>
					</label>

					{targetDef?.needsBasis ? (
						<label className="mt-2 flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">{basisLabel(targetDef)}</span>
							<input
								name="closingBasis"
								value={basis}
								onChange={(e) => setBasis(e.target.value)}
								placeholder="证据指针：提交号、文件、检查结果"
								className="rounded-md border bg-background px-2 py-1"
							/>
						</label>
					) : null}

					<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
						<button
							type="submit"
							disabled={pending}
							className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
						>
							{pending ? "提交中…" : "提交"}
						</button>
						{result.error ? <p className="text-sm text-destructive">{result.error}</p> : null}
					</div>
				</form>
			) : null}
		</div>
	);
}

/** 终态要求的依据不是一回事：结单要证据，取消要理由或接手单号 */
function basisLabel(def: StateDef): string {
	if (def.terminal === "done") return "终止依据（证据指针）";
	if (def.terminal === "cancelled") return "取消理由（或被谁取代）";
	return "终止依据";
}
