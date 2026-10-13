import * as path from "node:path";
import type { NextConfig } from "next";

// 本地只读看板：每次请求都要读最新库，别做静态化与预取（故不开 cacheComponents）。
// turbopack 的 CSS 规则供 Tailwind v4 用；root 指到 pi-work-orders 目录，
// 既盖住 web/ 又要读的 ../core，也免去上游多个 lockfile 的根推断告警。
const nextConfig: NextConfig = {
	turbopack: {
		root: path.resolve(import.meta.dirname, ".."),
		rules: {
			"*.css": {
				loaders: ["@tailwindcss/turbopack"],
				as: "*.css",
			},
		},
	},
};

export default nextConfig;