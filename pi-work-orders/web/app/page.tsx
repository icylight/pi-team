import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { OrdersTable } from "@/components/orders-table";
import { ledgers, snapshot, type LedgerSnapshot } from "@/lib/ledger";
import { nowMs } from "@/lib/time";
import type { StateRole } from "../../core/types";

// 每次请求都读最新库，不做静态化
export const dynamic = "force-dynamic";


function openOrders(l: LedgerSnapshot) {
	const states = l.states;
	if (!states) return [];
	return (l.orders ?? []).filter((o) => o.state !== states.done && o.state !== states.cancelled);
}

export default function IndexPage() {
	const refs = ledgers();
	const snapshots = refs.map(snapshot);
	const total = snapshots.reduce((n, l) => n + (l.orders?.length ?? 0), 0);
	const open = snapshots.reduce((n, l) => n + openOrders(l).length, 0);
	const stale = snapshots.reduce((n, l) => n + (l.stale?.length ?? 0), 0);
	const now = nowMs();

	return (
		<div className="mx-auto max-w-5xl px-6 py-10">
			<header className="mb-6">
				<h1 className="text-xl font-semibold">工单总览</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					{snapshots.length} 个项目 · 未收口 {open} / 共 {total}
					{stale ? ` · 停滞 ${stale}` : ""}
				</p>
			</header>

			{snapshots.length === 0 ? (
				<p className="text-muted-foreground">
					没找到工单库。用 <code className="rounded bg-muted px-1 py-0.5 font-mono text-[13px]">--root</code>{" "}
					指到项目所在的目录。
				</p>
			) : (
				<div className="flex flex-col gap-10">
					{snapshots.map((l) => (
						<ProjectSection key={l.slug} ledger={l} now={now} />
					))}
				</div>
			)}
		</div>
	);
}

function ProjectSection({ ledger, now }: { ledger: LedgerSnapshot; now: number }) {
	if (!ledger.ok) {
		return (
			<section id={ledger.slug}>
				<h2 className="text-base font-semibold">{ledger.name}</h2>
				<p className="mt-0.5 font-mono text-xs text-muted-foreground">{ledger.dir}</p>
				<p className="mt-2 text-sm text-destructive">读不出来：{ledger.error ?? "未知原因"}</p>
			</section>
		);
	}

	const orders = ledger.orders ?? [];
	const states = (ledger.states ?? {}) as Record<StateRole, string>;
	const open = openOrders(ledger);
	const closed = orders.filter((o) => !open.includes(o));
	const req = ledger.requirement;

	return (
		<section id={ledger.slug}>
			<div className="flex items-baseline justify-between gap-4">
				<h2 className="text-base font-semibold">{ledger.name}</h2>
				<span className="text-sm text-muted-foreground">
					未收口 {open.length} / 共 {orders.length}
				</span>
			</div>
			<p className="mt-0.5 font-mono text-xs text-muted-foreground">{ledger.dir}</p>
			{req && (req.goal || req.baseline) ? (
				<p className="mt-1.5 text-xs text-muted-foreground">
					{[req.goal, req.baseline ? `基线 ${req.baseline}` : ""].filter(Boolean).join(" · ")}
				</p>
			) : null}

			<div className="mt-3">
				{open.length ? (
					<OrdersTable
						slug={ledger.slug}
						orders={open}
						states={states}
						waiting={ledger.waiting ?? []}
						now={now}
					/>
				) : (
					<p className="text-sm text-muted-foreground">没有在办的单</p>
				)}
			</div>

			{closed.length ? (
				<Collapsible className="mt-4">
					<CollapsibleTrigger className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
						已收口 / 已取消 {closed.length}
					</CollapsibleTrigger>
					<CollapsibleContent className="mt-2">
						<OrdersTable
							slug={ledger.slug}
							orders={closed}
							states={states}
							waiting={ledger.waiting ?? []}
							now={now}
						/>
					</CollapsibleContent>
				</Collapsible>
			) : null}
		</section>
	);
}
