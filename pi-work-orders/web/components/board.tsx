import { DispatchFacts } from "@/components/dispatch-facts";
import type { DispatchOrder, DispatchSnapshot } from "../../core/dispatch";
import Link from "next/link";
import { ActorName, HUMAN_ACCENT, waitsForHuman } from "@/components/human-actor";
import { TypeLabel } from "@/components/order-type";
import { waitedLabel } from "@/components/orders-table";
import { stateDefOf } from "@/components/state-badge";
import type { ListedOrder, StateDef, Waiting } from "../../core/types";

/**
 * 状态分列看板：非终态状态各一列（空列不渲染），卡片进详情页。
 * 列顺序按项目声明的状态顺序，不是按单量。
 */
export function Board({
	slug,
	orders,
	states,
	waiting,
	now,
	dispatch,
}: {
	slug: string;
	orders: readonly ListedOrder[];
	states: StateDef[];
	waiting: readonly Waiting[];
	now: number;
	dispatch?: DispatchSnapshot;
}) {
	const byState = new Map<string, ListedOrder[]>();
	for (const o of orders) {
		const def = stateDefOf(states, o.state);
		if (!def || def.terminal) continue;
		const list = byState.get(def.name) ?? [];
		list.push(o);
		byState.set(def.name, list);
	}
	const columns = states.filter((def) => !def.terminal && (byState.get(def.name)?.length ?? 0) > 0);
	if (columns.length === 0) return <p className="text-sm text-muted-foreground">没有在办的单</p>;

	const orderById = new Map(orders.map((o) => [o.id, o]));
	const waitedByOrder = new Map(waiting.map((w) => [w.order.id, w]));
	const dispatchById = new Map(dispatch?.orders.map((item) => [item.id, item]));

	return (
		<div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-3 items-start">
			{columns.map((def) => (
				<section key={def.name} className="rounded-lg border bg-muted/30 p-2">
					<header className="flex items-baseline justify-between px-1 pb-2 text-sm font-medium">
						{def.name}
						<span className="font-mono text-xs text-muted-foreground">{byState.get(def.name)!.length}</span>
					</header>
					<div className="flex flex-col gap-2">
						{byState.get(def.name)!.map((o) => (
							<Card
								key={o.id}
								slug={slug}
								order={o}
								waited={waitedLabel(waitedByOrder.get(o.id), now)}
								blockedBy={unresolvedDeps(o, orderById, states)}
								dispatch={dispatchById.get(o.id)}
								observation={dispatch}
							/>
						))}
					</div>
				</section>
			))}
		</div>
	);
}

function unresolvedDeps(
	o: ListedOrder,
	orderById: Map<string, ListedOrder>,
	states: readonly StateDef[],
): string[] {
	const done = states.find((def) => def.terminal === "done")?.name;
	if (!done) return [...o.dependsOn];
	return o.dependsOn.filter((id) => orderById.get(id)?.state !== done);
}

function Card({
	slug,
	order,
	waited,
	blockedBy,
	dispatch,
	observation,
}: {
	slug: string;
	order: ListedOrder;
	waited: string | null;
	blockedBy: string[];
	dispatch?: DispatchOrder;
	observation?: DispatchSnapshot;
}) {
	const next = order.nextActors[0];
	return (
		<Link
			href={`/p/${slug}/o/${encodeURIComponent(order.id)}`}
			className={`block rounded-md border bg-background p-2.5 transition-colors hover:border-primary/60 ${waitsForHuman(order.nextActors) ? HUMAN_ACCENT : ""}`}
		>
			<div className="flex items-baseline justify-between gap-2">
				<span className="flex items-baseline gap-1.5">
					<span className="font-mono text-xs text-muted-foreground">{order.id}</span>
					<TypeLabel type={order.type} />
				</span>
				{waited ? <span className="text-xs whitespace-nowrap text-amber-600 dark:text-amber-400">{waited}</span> : null}
			</div>
			<p className="mt-1 line-clamp-2 text-sm leading-snug">{order.title}</p>
			<p className="mt-1.5 text-xs text-muted-foreground">
				下一步：{next ? <ActorName name={next} /> : "未指定"}
				{blockedBy.length > 0 ? <span> · 卡在 {blockedBy.join(" ")}</span> : null}
			</p>
			{dispatch && observation ? <DispatchFacts item={dispatch} snapshot={observation} /> : null}
		</Link>
	);
}
