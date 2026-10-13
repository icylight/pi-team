import Link from "next/link";

export default function NotFound() {
	return (
		<div className="mx-auto max-w-3xl px-6 py-10">
			<h1 className="text-lg font-semibold">没有这个地址</h1>
			<p className="mt-2 text-sm text-muted-foreground">刷新总览页看看有哪些项目。</p>
			<p className="mt-3 text-sm">
				<Link className="text-primary hover:underline" href="/">
					← 回到总览
				</Link>
			</p>
		</div>
	);
}