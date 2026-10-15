import * as path from "node:path";
import type { NextConfig } from "next";

// 本地只读看板：每次请求都要读最新库，别做静态化与预取（故不开 cacheComponents）。
// turbopack 的根覆盖工单 core 与 peer 的只读观察模块，避免多个 lockfile 的根推断告警。
const nextConfig: NextConfig = {
	turbopack: {
		root: path.resolve(import.meta.dirname, "../.."),
		rules: {
			"*.css": {
				loaders: ["@tailwindcss/turbopack"],
				as: "*.css",
			},
		},
	},
};

export default nextConfig;
