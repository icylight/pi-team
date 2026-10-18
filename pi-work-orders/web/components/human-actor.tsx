import { isHumanActor } from "../../core/types";

/**
 * 「用户」是坐在终端前的人，不是会话：这类单要人工介入。
 * 统一用天蓝标出来，跟状态徽记的紫/琥珀/绿区分开。
 */
export const HUMAN_TEXT = "text-sky-600 dark:text-sky-400";
/** 卡片左侧竖条：一眼看出这条等的是人 */
export const HUMAN_ACCENT = "border-l-2 border-l-sky-500";

/** 只看首选责任人：备选里带「用户」不算等人 */
export function waitsForHuman(actors: readonly string[]): boolean {
	return isHumanActor(actors[0] ?? "");
}

export function ActorName({ name }: { name: string }) {
	return isHumanActor(name) ? <span className={HUMAN_TEXT}>{name}</span> : <>{name}</>;
}
