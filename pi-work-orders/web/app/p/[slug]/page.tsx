import Link from "next/link";
import { notFound } from "next/navigation";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Board } from "@/components/board";
import { OrdersTable } from "@/components/orders-table";
import { ledgers, openOrders, snapshot, type LedgerSnapshot } from "@/lib/ledger";
import { nowMs } from "@/lib/time";

export const dynamic = "force-dynamic";

/** 项目页（工作层）：状态分列看板 + 收口/取消折叠。需求背景默认收起，不占看板位置 */
export default async function ProjectPage({ params }: PageProps<"/p/[slug]">) {
	const { slug } = await params;
	const ref = ledgers().find((r) => r.slug === decode(slug));
	if (!ref) notFound();
	const l = snapshot(ref);
	const now = nowMs();

	return (
		<div className="mx-auto max-w-6xl px-6 py-10">
			<p className="mb-3 text-sm">
				<Link className="text-muted-foreground hover:text-foreground" href="/">
					← 总览
				</Link>
			</p>

			{!l.ok ? (
				<>
					<h1 className="text-xl font-semibold">{l.name}</h1>
					<p className="mt-0.5 font-mono text-xs text-muted-foreground">{l.dir}</p>
					<p className="mt-2 text-sm text-destructive">读不出来：{l.error ?? "未知原因"}</p>
				</>
			) : (
				<ProjectBoard ledger={l} now={now} />
			)}
		</div>
	);
}

/** 路由段解码；非法转义序列原样返回 */
function decode(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

function ProjectBoard({ ledger, now }: { ledger: LedgerSnapshot; now: number }) {
	if (!ledger.ok) return null;
	const orders = ledger.orders ?? [];
	const states = ledger.states;
	if (!states) return null;
	const open = openOrders(ledger);
	const closed = orders.filter((o) => !open.includes(o));
	const req = ledger.requirement;

	return (
		<>
			<header className="mb-4">
				<div className="flex items-baseline justify-between gap-4">
					<h1 className="text-xl font-semibold">{ledger.name}</h1>
					<span className="font-mono text-sm text-muted-foreground">
						未收口 {open.length} / 共 {orders.length}
					</span>
				</div>
				<p className="mt-0.5 font-mono text-xs text-muted-foreground">{ledger.dir}</p>
				{req?.goal ? (
					<Collapsible className="mt-2">
						<CollapsibleTrigger className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
							需求：{req.goal.length > 80 ? `${req.goal.slice(0, 80)}…` : req.goal}
						</CollapsibleTrigger>
						<CollapsibleContent className="mt-2 rounded-md border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
							<p><span className="text-foreground">目标</span>　{req.goal}</p>
							{req.scope ? <p className="mt-1"><span className="text-foreground">边界</span>　{req.scope}</p> : null}
							{req.acceptance ? <p className="mt-1"><span className="text-foreground">验收</span>　{req.acceptance}</p> : null}
							{req.baseline ? <p className="mt-1"><span className="text-foreground">基线</span>　{req.baseline}</p> : null}
						</CollapsibleContent>
					</Collapsible>
				) : null}
			</header>

			<Board slug={ledger.slug} orders={orders} states={states} waiting={ledger.waiting ?? []} now={now} />

			{closed.length ? (
				<Collapsible className="mt-6">
					<CollapsibleTrigger className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
						已收口 / 已取消 {closed.length}
					</CollapsibleTrigger>
					<CollapsibleContent className="mt-2">
						<OrdersTable slug={ledger.slug} orders={closed} states={states} waiting={ledger.waiting ?? []} now={now} />
					</CollapsibleContent>
				</Collapsible>
			) : null}
		</>
	);
}
