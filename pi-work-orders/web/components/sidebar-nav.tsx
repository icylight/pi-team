"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** 侧边栏导航：当前路由高亮。数据由服务端组件算好传入 */
export function SidebarNav({ items }: { items: SidebarItem[] }) {
	const pathname = usePathname();
	const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

	return (
		<nav className="flex flex-col gap-0.5 px-3">
			<Link
				href="/"
				className={`rounded-md px-2 py-1.5 text-sm ${
					isActive("/") ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
				}`}
			>
				总览
			</Link>
			{items.length > 0 && (
				<p className="mt-3 mb-1 px-2 text-xs text-muted-foreground">项目</p>
			)}
			{items.map((it) => (
				<Link
					key={it.slug}
					href={`/p/${it.slug}`}
					title={it.ok ? it.name : `读不出来：${it.error ?? "未知原因"}`}
					className={`flex items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-sm ${
						isActive(`/p/${it.slug}`)
							? "bg-muted font-medium text-foreground"
							: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
					}`}
				>
					<span className="min-w-0 truncate" title={it.name}>
						{it.name}
					</span>
					<span
						className={`shrink-0 font-mono text-xs ${it.ok ? "text-muted-foreground" : "text-destructive"}`}
					>
						{it.ok ? (it.open > 0 ? it.open : "") : "!"}
					</span>
				</Link>
			))}
		</nav>
	);
}

export interface SidebarItem {
	slug: string;
	name: string;
	open: number;
	ok: boolean;
	error?: string;
}
