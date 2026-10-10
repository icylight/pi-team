import * as path from "node:path";
import { LedgerError, type OrderContent } from "./types.ts";

// AI(TAG): [工单内容] 具名入口承载工单内容，保存路径而不读取或改写文件。
export function normalizeContents(value: unknown): OrderContent[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new LedgerError("contents 要写成内容入口数组");
	const names = new Set<string>();
	return value.map((entry: unknown) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new LedgerError("内容入口要写成 { name, path }");
		}
		const item = entry as Record<string, unknown>;
		if (typeof item.name !== "string" || !item.name.trim() || /[\x00-\x1f\x7f]/.test(item.name)) {
			throw new LedgerError("内容入口名称不能为空或包含控制字符");
		}
		const name = item.name.trim();
		if (names.has(name)) throw new LedgerError(`内容入口名称重复：${name}`);
		names.add(name);
		if (typeof item.path !== "string") throw new LedgerError(`内容入口「${name}」要写项目内相对 md 路径`);
		const file = item.path.trim().replace(/\\/g, "/");
		if (
			!file ||
			file.startsWith("/") ||
			file.startsWith("~/") ||
			/^[a-z][a-z\d+.-]*:/i.test(file) ||
			file.split("/").includes("..") ||
			/[\x00-\x1f\x7f]/.test(file) ||
			!/\.md$/i.test(file)
		) {
			throw new LedgerError(`内容入口「${name}」要写项目内相对 md 路径`);
		}
		return { name, path: path.posix.normalize(file) };
	});
}
