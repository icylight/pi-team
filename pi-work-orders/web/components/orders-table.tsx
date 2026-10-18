import Link from "next/link";
import { ActorName } from "@/components/human-actor";
import { StateBadge } from "@/components/state-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ListedOrder, StateRole, Waiting } from "../../core/types";
import { formatAgo, minutesSince } from "@/lib/time";

/** 「等了」只对等某人动的单显示；依赖等待还没到该催的时候 */
export function waitedLabel(w: Waiting | undefined, now: number): string | null {
	if (!w || w.kind === "dependency") return null;
	return `等了 ${formatAgo(minutesSince(w.since, now))}`;
}

export function OrdersTable({
	slug,
	orders,
	states,
	waiting,
	now,
}: {
	slug: string;
	orders: readonly ListedOrder[];
	states: Record<StateRole, string>;
	waiting: readonly Waiting[];
	now: number;
}) {
	const waitedByOrder = new Map(waiting.map((w) => [w.order.id, w]));
	const orderById = new Map(orders.map((o) => [o.id, o]));

	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead className="w-16">id</TableHead>
					<TableHead className="w-20">状态</TableHead>
					<TableHead className="w-28">下一步</TableHead>
					<TableHead className="w-24">依赖</TableHead>
					<TableHead>标题</TableHead>
					<TableHead className="w-20 text-right">改动</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{orders.map((o) => {
					const waited = waitedLabel(waitedByOrder.get(o.id), now);
					return (
						<TableRow key={o.id}>
							<TableCell className="font-mono text-xs">
								<Link className="text-primary hover:underline" href={`/p/${slug}/o/${encodeURIComponent(o.id)}`}>
									{o.id}
								</Link>
							</TableCell>
							<TableCell>
								<StateBadge state={o.state} states={states} />
							</TableCell>
							<TableCell className="text-sm">
								{o.nextActors.length ? (
									<>
										<ActorName name={o.nextActors[0]} />
										{o.nextActors.length > 1 ? (
											<span className="text-muted-foreground">
												（备选{" "}
												{o.nextActors.slice(1).map((name, i) => (
													<span key={name}>
														{i > 0 ? "、" : ""}
														<ActorName name={name} />
													</span>
												))}
												）
											</span>
										) : null}
									</>
								) : (
									<span className="text-muted-foreground">（未指定）</span>
								)}
							</TableCell>
							<TableCell className="text-sm">
								{o.dependsOn.length ? (
									<span className="inline-flex flex-wrap gap-x-1.5">
										{o.dependsOn.map((id) => {
											const up = orderById.get(id);
											const done = up?.state === states.done;
											return (
												<Link
													key={id}
													href={`/p/${slug}/o/${encodeURIComponent(id)}`}
													className={done ? "text-muted-foreground hover:underline" : "text-primary hover:underline"}
												>
													{id}
												</Link>
											);
										})}
									</span>
								) : (
									<span className="text-muted-foreground">-</span>
								)}
							</TableCell>
							<TableCell className="text-sm">
								<Link className="hover:underline" href={`/p/${slug}/o/${encodeURIComponent(o.id)}`}>
									{o.title}
								</Link>
								{waited ? (
									<span className="ml-2 text-xs whitespace-nowrap text-amber-600 dark:text-amber-400">{waited}</span>
								) : null}
							</TableCell>
							<TableCell
								className="text-right font-mono text-xs whitespace-nowrap text-muted-foreground"
								title={o.updatedAt}
							>
								{formatAgo(minutesSince(o.updatedAt, now))}
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}