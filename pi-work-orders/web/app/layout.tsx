import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import { SiteSidebar } from "@/components/sidebar";
import "./globals.css";

const mono = Geist_Mono({ variable: "--font-mono", subsets: ["latin"] });

export const metadata: Metadata = {
	title: "工单看板",
	description: "本机所有项目的工单台账（只读）",
};

// 布局里读库算侧边栏，整站按动态渲染
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: LayoutProps<"/">) {
	return (
		<html lang="zh-CN" className={mono.variable}>
			<body className="min-h-svh bg-background text-foreground antialiased">
				<div className="flex min-h-svh">
					<SiteSidebar />
					<main className="min-w-0 flex-1">{children}</main>
				</div>
			</body>
		</html>
	);
}
