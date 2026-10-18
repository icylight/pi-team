/**
 * 工单类型是分类，不是状态：用中性灰标签，不带状态徽记的语义色，
 * 免得两者混成同一套视觉语言。比状态徽记小一号，紧贴 id 时也读得开。
 */
export function TypeLabel({ type, fallback = null }: { type: string | null; fallback?: React.ReactNode }) {
	if (!type) return <>{fallback}</>;
	return (
		<span className="inline-flex items-center rounded bg-muted px-1.5 py-px text-[11px] leading-4 whitespace-nowrap text-muted-foreground">
			{type}
		</span>
	);
}
