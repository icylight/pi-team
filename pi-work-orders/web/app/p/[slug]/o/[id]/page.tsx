import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StateBadge } from "@/components/state-badge";
import { Markdown } from "@/components/markdown";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ledgers, orderPage } from "@/lib/ledger";
import { formatAgo, minutesSince, nowMs, stamp } from "@/lib/time";

export const dynamic = "force-dynamic";


export default async function OrderPage({ params }: PageProps<"/p/[slug]/o/[id]">) {
	const { slug, id } = await params;
	const ref = ledgers().find((r) => r.slug === decode(slug));
	if (!ref) notFound();

	let data: ReturnType<typeof orderPage>;
	try {
		data = orderPage(ref, decode(id));
	} catch {
		notFound();
	}
	const { view, states, events } = data;
	const now = nowMs();

	const fields: string[] = [
		`rev ${view.revision}`,
		`建于 ${stamp(view.createdAt)}`,
		`改于 ${stamp(view.updatedAt)}（${formatAgo(minutesSince(view.updatedAt, now))} 前）`,
	];

	const links: { label: string; value: React.ReactNode }[] = [];
	if (view.dependsOn.length) {
		links.push({ label: "依赖", value: <IdList slug={slug} ids={view.dependsOn} /> });
	}
	if (view.blocks.length) {
		links.push({ label: "下游", value: <IdList slug={slug} ids={view.blocks} /> });
	}
	if (view.contents.length) {
		links.push({
			label: "内容入口",
			value: (
				<div className="flex flex-col gap-0.5">
					{view.contents.map((c) => (
						<span key={`${c.name}:${c.path}`}>
							<Link
								className="text-primary hover:underline"
								href={`/p/${slug}/f/${c.path.split("/").map(encodeURIComponent).join("/")}`}
							>
								{c.name}
							</Link>{" "}
							<span className="font-mono text-xs text-muted-foreground">{c.path}</span>
						</span>
					))}
				</div>
			),
		});
	}

	return (
		<div className="mx-auto max-w-3xl px-6 py-10">
			<p className="mb-3 text-sm">
				<Link className="text-muted-foreground hover:text-foreground" href={`/p/${slug}`}>
					← {data.project}
				</Link>
			</p>

			<header>
				<h1 className="text-xl font-semibold">
					<span className="font-mono">{view.id}</span> · {view.title}
				</h1>
				<div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
					<StateBadge state={view.state} states={states} />
					<span>
						下一步找谁：
						{view.nextActors.length ? view.nextActors.join("、") : "（未指定）"}
					</span>
					{fields.map((f) => (
						<span key={f}>· {f}</span>
					))}
				</div>
			</header>

			{view.staleDeps.length ? (
				<p className="mt-3 text-sm text-destructive">
					上游已取消，这条的依赖失效，需要裁定：{view.staleDeps.join("、")}
				</p>
			) : null}

			{links.length ? (
				<dl className="mt-4 grid grid-cols-[80px_1fr] gap-x-3 gap-y-1.5 rounded-lg bg-muted/40 px-4 py-3 text-sm">
					{links.map((l) => (
						<Fragment key={l.label}>
							<dt className="text-muted-foreground">{l.label}</dt>
							<dd className="min-w-0">{l.value}</dd>
						</Fragment>
					))}
				</dl>
			) : null}

			{view.body.trim() ? (
				<article className="mt-5 text-sm leading-relaxed text-foreground">
					<Markdown text={view.body} />
				</article>
			) : null}

			{events.length ? (
				<section className="mt-8">
					<h2 className="border-b pb-1.5 text-base font-semibold">动作记录</h2>
					<Table className="mt-2">
						<TableHeader>
							<TableRow>
								<TableHead className="w-28">时间</TableHead>
								<TableHead className="w-28">谁</TableHead>
								<TableHead className="w-32">变化</TableHead>
								<TableHead>为什么</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{events
								.slice()
								.reverse()
								.map((e) => (
									<TableRow key={e.id}>
										<TableCell className="font-mono text-xs text-muted-foreground" title={e.at}>
											{stamp(e.at).slice(5)}
										</TableCell>
										<TableCell className="text-sm">{e.actor}</TableCell>
										<TableCell className="text-sm">
											{e.fromState && e.toState ? `${e.fromState} → ${e.toState}` : e.toState || e.kind}
										</TableCell>
										<TableCell className="text-sm">{e.note}</TableCell>
									</TableRow>
								))}
						</TableBody>
					</Table>
				</section>
			) : null}
		</div>
	);
}

function IdList({ slug, ids }: { slug: string; ids: string[] }) {
	return (
		<span className="inline-flex flex-wrap gap-x-2">
			{ids.map((id) => (
				<Link key={id} className="text-primary hover:underline" href={`/p/${slug}/o/${encodeURIComponent(id)}`}>
					{id}
				</Link>
			))}
		</span>
	);
}

function decode(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}
