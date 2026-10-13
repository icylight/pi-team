/**
 * 找本机有哪些工单库，给跨项目看板用。
 *
 * 库跟着项目走（<项目>/.work-orders/work-orders.sqlite），要看全部就得先知道哪些目录是项目。
 * 只扫根目录自身和它的一级子目录：~/code 下每个仓库一个库、加上当前会话所在项目，
 * 正好是这两种形态；再深的层级用 --root 显式指。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_DB_DIR, DEFAULT_DB_NAME } from "../../core/schema.ts";

export interface LedgerRef {
	/** URL 段用的短名；不同根下同名目录靠后缀区分 */
	slug: string;
	/** 展示名：项目目录名 */
	name: string;
	/** 项目根目录 */
	dir: string;
	dbPath: string;
}

export function discoverLedgers(roots: readonly string[]): LedgerRef[] {
	const candidates: string[] = [];
	for (const raw of roots) {
		const dir = raw.trim();
		if (!dir) continue;
		candidates.push(dir);
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue; // 根不存在或读不了：跳过，不是错误
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			// 符号链接也收：项目常以链接挂在工作目录下
			if (entry.isDirectory() || entry.isSymbolicLink()) candidates.push(path.join(dir, entry.name));
		}
	}

	const found: LedgerRef[] = [];
	const seen = new Set<string>();
	for (const dir of candidates) {
		const dbPath = path.join(dir, DEFAULT_DB_DIR, DEFAULT_DB_NAME);
		if (!isFile(dbPath)) continue;
		const real = fs.realpathSync(dbPath);
		if (seen.has(real)) continue; // 同一个库被多个根扫到
		seen.add(real);
		const root = path.resolve(dir);
		found.push({ slug: "", name: path.basename(root), dir: root, dbPath: real });
	}

	// slug 只由目录名派生（中文名会落到 project），重名按出现顺序加后缀
	const used = new Map<string, number>();
	for (const ref of found) {
		const base = slugify(ref.name);
		const n = (used.get(base) ?? 0) + 1;
		used.set(base, n);
		ref.slug = n === 1 ? base : `${base}-${n}`;
	}
	return found.sort((a, b) => a.name.localeCompare(b.name));
}

function isFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function slugify(name: string): string {
	const base = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return base || "project";
}
