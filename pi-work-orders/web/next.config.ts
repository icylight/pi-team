import * as path from "node:path";
import type { NextConfig } from "next";

// 本地只读看板：每次请求都要读最新库，别做静态化与预取（故不开 cacheComponents）。
// turbopack 的根覆盖工单 core 与 peer 的只读观察模块，避免多个 lockfile 的根推断告警。
const nextConfig: NextConfig = {
	// dev 默认只放行 localhost；按 127.0.0.1 打开时 /_next/hmr 被拦，
	// 客户端等不到 HMR 就不 hydration，整页按钮点不动。
	allowedDevOrigins: ["127.0.0.1"],
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
