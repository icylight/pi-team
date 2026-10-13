import * as fs from "node:fs";
import * as path from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { ledgers } from "@/lib/ledger";

export const dynamic = "force-dynamic";


export default async function FilePage({ params }: PageProps<"/p/[slug]/f/[...rel]">) {
	const { slug, rel } = await params;
	const ref = ledgers().find((r) => r.slug === decode(slug));
	if (!ref) notFound();

	const relPath = rel.map(decode).join("/");
	const abs = path.resolve(ref.dir, relPath);
	const inside = path.relative(ref.dir, abs);
	// 内容入口的路径来自库，库可能被改脏：读出项目目录之外的文件或非 md，一律拒绝
	if (inside.startsWith("..") || path.isAbsolute(inside) || !/\.(md|markdown|txt)$/i.test(abs)) {
		return (
			<div className="mx-auto max-w-3xl px-6 py-10">
				<h1 className="text-lg font-semibold">拒绝访问</h1>
				<p className="mt-2 text-sm text-destructive">只读项目内的 markdown：{relPath}</p>
				<p className="mt-3 text-sm">
					<Link className="text-primary hover:underline" href={`/p/${slug}`}>
						← 回到项目
					</Link>
				</p>
			</div>
		);
	}

	let content: string;
	try {
		content = fs.readFileSync(abs, "utf8");
	} catch {
		notFound();
	}

	return (
		<div className="mx-auto max-w-3xl px-6 py-10">
			<p className="mb-3 text-sm">
				<Link className="text-muted-foreground hover:text-foreground" href={`/p/${slug}`}>
					← {ref.name}
				</Link>
			</p>
			<h1 className="font-mono text-lg font-semibold">{relPath}</h1>
			<article className="mt-5 text-sm leading-relaxed">
				<Markdown text={content} />
			</article>
		</div>
	);
}

function decode(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}
