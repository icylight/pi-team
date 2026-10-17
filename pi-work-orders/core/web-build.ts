/**
 * 看板构建产物的新鲜度判定。
 *
 * Next 的生产模式（`next start`）跑的是构建时生成的副本：改 `core/*.ts` 之后不重建，
 * 看板仍在用旧逻辑。表现是页面报与库无关的错（典型是 `SCHEMA_VERSION` 对不上，
 * 看起来像数据库坏了），实际只是产物旧了。
 *
 * 纯逻辑，不 import 任何 pi 的东西：拉起重建的副作用留在 index.ts。
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface BuildFreshness {
	/** 产物比源码旧（或压根没有产物） */
	stale: boolean;
	/** 产物时刻；没有产物时为 0 */
	buildAt: number;
	/** 最新的源文件绝对路径；没有源码时为占位说明 */
	newestSource: string;
	/** 最新源文件的修改时刻；没有源码时为 0 */
	sourceAt: number;
}

/** 参与比较的源码后缀：Next 会打进去的那些 */
const SOURCE_EXT = /\.(ts|tsx|css|json|mjs|js)$/;

function newestSourceUnder(dir: string, current: { at: number; file: string }): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		// node_modules 与 .next 不是源码；点开头的目录（.git 等）也不看
		if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			newestSourceUnder(full, current);
			continue;
		}
		if (!SOURCE_EXT.test(entry.name)) continue;
		let at: number;
		try {
			at = fs.statSync(full).mtimeMs;
		} catch {
			continue;
		}
		if (at > current.at) {
			current.at = at;
			current.file = full;
		}
	}
}

/**
 * 产物是否过期。看两个来源：看板自身的源码，和它 import 的 `core/`。
 * 两边都要看 —— 只改 `core/schema.ts` 的版本号，同样会让产物失效。
 */
export function buildFreshness(webRoot: string): BuildFreshness {
	let buildAt = 0;
	try {
		buildAt = fs.statSync(path.join(webRoot, ".next", "BUILD_ID")).mtimeMs;
	} catch {
		return { stale: true, buildAt: 0, newestSource: "（没有构建产物）", sourceAt: 0 };
	}
	const newest = { at: 0, file: "" };
	newestSourceUnder(webRoot, newest);
	newestSourceUnder(path.join(path.dirname(webRoot), "core"), newest);
	return {
		stale: newest.at > buildAt,
		buildAt,
		newestSource: newest.file || "（没有源码）",
		sourceAt: newest.at,
	};
}
