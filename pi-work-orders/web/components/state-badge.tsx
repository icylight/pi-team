import { Badge } from "@/components/ui/badge";
import type { StateRole } from "../../core/types";

/** 状态角色 → 徽记配色。同义同色：只要两者都是同一角色，颜色就一致。 */
const ROLE_CLASS: Record<StateRole, string> = {
	claimable: "bg-muted text-muted-foreground border-border",
	active: "bg-primary/10 text-primary border-primary/20",
	review: "bg-violet-500/10 text-violet-600 border-violet-500/20 dark:text-violet-400",
	rework: "bg-destructive/10 text-destructive border-destructive/20",
	paused: "bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400",
	done: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
	cancelled: "bg-muted text-muted-foreground border-border",
};

/** 状态名是项目自己声明的，配色得先反查角色 */
export function roleOfState(states: Record<StateRole, string>, state: string): StateRole | undefined {
	return (Object.keys(states) as StateRole[]).find((role) => states[role] === state);
}

export function StateBadge({ state, states }: { state: string; states: Record<StateRole, string> }) {
	const role = roleOfState(states, state);
	const cls = role ? ROLE_CLASS[role] : "border-border text-muted-foreground";
	return (
		<Badge variant="outline" className={cls}>
			{state}
		</Badge>
	);
}