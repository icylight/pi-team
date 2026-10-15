// AI(TAG): [交接持久化] 自定义消息事件可能只到内存；按当前分支的 entry id 核对真实 JSONL, 不扫描废弃分支确认。
import * as fs from "node:fs";

export function hasPersistedHandoff(
	file: string | undefined,
	branch: readonly unknown[],
	notificationId: string,
): boolean {
	if (!file?.endsWith(".jsonl")) return false;
	const ids = new Set<string>();
	for (const item of branch) {
		const entry = item as { type?: string; id?: string; details?: { handoff?: { id?: string } } } | null;
		if (
			entry?.type === "custom_message" &&
			typeof entry.id === "string" &&
			entry.details?.handoff?.id === notificationId
		)
			ids.add(entry.id);
	}
	if (!ids.size) return false;
	try {
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			try {
				const entry = JSON.parse(line) as {
					type?: string;
					id?: string;
					details?: { handoff?: { id?: string } };
				} | null;
				if (
					entry?.type === "custom_message" &&
					entry.id &&
					ids.has(entry.id) &&
					entry.details?.handoff?.id === notificationId
				)
					return true;
			} catch {
				/* 部分写入的尾行不构成持久化确认。 */
			}
		}
	} catch {
		/* 不存在、不可读或内存会话均不确认。 */
	}
	return false;
}
