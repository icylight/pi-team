import { Badge } from "@/components/ui/badge";
import type { StateDef } from "../../core/types";

/** 状态能力开关 → 徽记配色。同一套开关组合颜色一致，与状态名无关。 */
function toneOf(def: StateDef | undefined): string {
	if (!def) return "border-border text-muted-foreground";
	if (def.terminal === "done") return "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400";
	if (def.terminal === "cancelled") return "bg-muted text-muted-foreground border-border";
	if (def.timing) return "bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400";
	if (def.singleOwner) return "bg-primary/10 text-primary border-primary/20";
	if (def.execution) return "bg-destructive/10 text-destructive border-destructive/20";
	if (def.waiting) return "bg-violet-500/10 text-violet-600 border-violet-500/20 dark:text-violet-400";
	return "bg-muted text-muted-foreground border-border";
}

/** 状态名是项目自己声明的，配色按声明的开关算 */
export function stateDefOf(states: readonly StateDef[], state: string): StateDef | undefined {
	return states.find((def) => def.name === state);
}

export function StateBadge({ state, states }: { state: string; states: readonly StateDef[] }) {
	return (
		<Badge variant="outline" className={toneOf(stateDefOf(states, state))}>
			{state}
		</Badge>
	);
}
