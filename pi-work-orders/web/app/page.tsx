import Link from "next/link";
import { ActorName } from "@/components/human-actor";
import { attention, ledgers, openOrders, snapshot, type AttentionItem } from "@/lib/ledger";
import { formatAgo, minutesSince, nowMs } from "@/lib/time";

// 每次请求都读最新库，不做静态化
export const dynamic = "force-dynamic";

/**
 * 总览（决策层）：全局统计 + 跨项目「需关注」队列。
 * 项目索引用侧边栏；单条工单的明细在 /p/<项目> 的状态看板里。
 */
export default function IndexPage() {
	const refs = ledgers();
	const snapshots = refs.map(snapshot);
	const ok = snapshots.filter((l) => l.ok);
	const total = ok.reduce((n, l) => n + (l.orders?.length ?? 0), 0);
	const open = ok.reduce((n, l) => n + openOrders(l).length, 0);
	const stale = ok.reduce((n, l) => n + (l.stale?.length ?? 0), 0);
	const items = attention(snapshots);
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
			) : items.length > 0 ? (
				<AttentionList items={items} now={now} />
			) : (
				<p className="text-sm text-muted-foreground">没有在等人动手的单。</p>
			)}
		</div>
	);
}

function AttentionList({ items, now }: { items: AttentionItem[]; now: number }) {
	return (
		<section>
			<h2 className="mb-2 text-sm font-medium text-muted-foreground">需关注（等人动手，等待最久在前）</h2>
			<ul className="divide-y rounded-lg border bg-card">
				{items.map((it) => (
					<li key={`${it.slug}:${it.order.id}`} className="flex items-baseline gap-3 px-3 py-2 text-sm">
						<Link
							className="font-mono text-xs text-primary hover:underline"
							href={`/p/${it.slug}/o/${encodeURIComponent(it.order.id)}`}
						>
							{it.order.id}
						</Link>
						<span className="w-32 shrink-0 truncate text-muted-foreground">{it.project}</span>
						<Link
							className="min-w-0 flex-1 truncate hover:underline"
							href={`/p/${it.slug}/o/${encodeURIComponent(it.order.id)}`}
						>
							{it.order.title}
						</Link>
						<span className="shrink-0 text-xs text-muted-foreground">
							等 <ActorName name={it.order.nextActors[0] ?? "未指定"} />
						</span>
						<span
							className={`shrink-0 font-mono text-xs ${it.stale ? "text-destructive" : "text-amber-600 dark:text-amber-400"}`}
						>
							{it.stale ? "停滞 " : ""}
							{formatAgo(minutesSince(it.waiting.since, now))}
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}
