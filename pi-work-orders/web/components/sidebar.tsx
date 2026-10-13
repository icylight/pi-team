import Link from "next/link";
import { SidebarNav, type SidebarItem } from "@/components/sidebar-nav";
import { ledgers, openOrders, snapshot } from "@/lib/ledger";

/** 侧边栏：总览 + 项目列表（未收口计数）。窄屏隐藏，深页靠面包屑回退 */
export function SiteSidebar() {
	const items: SidebarItem[] = ledgers().map((ref) => {
		const l = snapshot(ref);
		return { slug: ref.slug, name: l.name, open: l.ok ? openOrders(l).length : 0, ok: l.ok, error: l.error };
	});

	return (
		<aside className="sticky top-0 hidden h-svh w-56 shrink-0 flex-col border-r bg-muted/20 md:flex">
			<p className="px-3 pt-4 pb-2 text-sm font-semibold">
				<Link href="/" className="hover:underline">
					工单看板
				</Link>
			</p>
			<SidebarNav items={items} />
		</aside>
	);
}
