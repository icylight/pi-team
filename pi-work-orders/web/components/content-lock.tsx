import type { ContentLock } from "../../core/types";

/**
 * 内容锁标记：锁住的是口径，不是进度。
 * 用带描边的中性标签，与类型标签（纯底色、表示分类）分开——两者都会紧贴标题出现。
 */
export function ContentLockLabel({ lock }: { lock: ContentLock | null }) {
	if (!lock) return null;
	const when = lock.at.slice(0, 16).replace("T", " ");
	return (
		<span
			className="inline-flex items-center rounded border border-border px-1.5 py-px text-[11px] leading-4 whitespace-nowrap text-muted-foreground"
			title={`内容已锁定：${lock.by} 于 ${when} 锁定；改标题、正文、内容入口、类型之前要先解锁`}
		>
			内容锁定
		</span>
	);
}
