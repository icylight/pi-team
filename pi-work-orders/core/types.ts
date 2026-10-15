/**
 * 工单台账的类型与常量。
 *
 * 分层：本文件（及 schema.ts / store.ts）不 import 任何 pi 的东西，
 * 换 harness 或加 CLI 壳时可直接复用。pi 相关代码只在 index.ts。
 */

/** 状态角色——工具只认角色，不认状态名；状态名由项目在库里声明 */
export type StateRole = "claimable" | "active" | "review" | "rework" | "paused" | "done" | "cancelled";

export const ROLES: readonly StateRole[] = [
	"claimable",
	"active",
	"review",
	"rework",
	"paused",
	"done",
	"cancelled",
] as const;

/** 终态角色：依赖判定用；done 解锁下游，cancelled 让下游待裁决 */
export const TERMINAL_ROLES: readonly StateRole[] = ["done", "cancelled"] as const;

/**
 * 默认状态集：角色 → 状态名。
 * 项目可在库里覆盖（meta.states），工具按角色查名字。
 */
export const DEFAULT_STATES: Record<StateRole, string> = {
	claimable: "待认领",
	active: "在做",
	review: "待复核",
	rework: "被打回",
	paused: "阻塞",
	done: "已收口",
	cancelled: "已取消",
};

/**
 * 合法转换，按角色声明。
 * 阻塞只从「在做」进、解除回「在做」，所以它是在做的暂停子态，不记来源。
 */
export const DEFAULT_TRANSITIONS: Record<StateRole, readonly StateRole[]> = {
	claimable: ["active", "cancelled"],
	active: ["review", "paused", "cancelled"],
	paused: ["active", "cancelled"],
	review: ["done", "rework", "cancelled"],
	rework: ["active", "cancelled"],
	done: [],
	cancelled: [],
};

/** 哪些角色在推进时必须给出终止依据（结单要证据，取消要理由） */
export const BASIS_REQUIRED: readonly StateRole[] = ["done", "cancelled"] as const;

/**
 * 「在等人动」的角色：这些状态的单坐落在某个人名下，等人接手、修复、裁定或解除。
 * 「在做」不算——有人正在干；「已收口/已取消」不算——没人需要动。
 */
export const WAITING_ROLES: readonly StateRole[] = ["claimable", "rework", "review", "paused"] as const;

/** 催办阈值（分钟）：等超过这个时长还没动，就算停滞，进提醒与扫描 */
export const STALE_MINUTES = 30;

/**
 * 人工执行者的名字：等的是坐在终端前的人，不是会话。
 * 这类单没有 peer 可投（找不到叫「用户」的会话），只能走通知，不能当投递失败。
 */
export const HUMAN_ACTOR = "用户";

export function isHumanActor(name: string): boolean {
	return name.trim() === HUMAN_ACTOR;
}

/** 台账事件：只追加，不改。状态从哪来到哪去，问它 */
export type EventKind = "create" | "state" | "field" | "handoff" | "dep-add" | "dep-remove";

export interface OrderEvent {
	id: number;
	orderId: string;
	/** 这次动作是谁做的 */
	actor: string;
	kind: EventKind;
	fromState: string | null;
	toState: string | null;
	/** 为什么这么动（状态变更的 reason）/ 依赖边的说明 */
	note: string;
	at: string;
}

export interface OrderContent {
	name: string;
	/** 项目内 md 路径；入口本身不保证文件存在。 */
	path: string;
}

export interface Order {
	id: string;
	title: string;
	/** 正文，markdown 文本；范围修订用追加，不覆盖 */
	body: string;
	contents: OrderContent[];
	/** 当前状态名（取值为项目声明的状态集之一） */
	state: string;
	/** 这一步该谁动：有序候选，第一个是首选，后面是首选不在时的备选；用户本人也写成名字 */
	nextActors: string[];
	/** 终止依据：结单填证据指针，取消填理由或取代它的单号 */
	closingBasis: string | null;
	createdAt: string;
	updatedAt: string;
	/** 乐观锁版本号，防同一秒内的并发覆盖 */
	revision: number;
}

/** 列表行：订单 + 上游依赖清单（展示用；下游与失效判定只在 getOrder 里算） */
export interface ListedOrder extends Order {
	dependsOn: string[];
}

export interface OrderView extends Order {
	/** 这条依赖谁 */
	dependsOn: string[];
	/** 谁依赖这条（下游） */
	blocks: string[];
	/** 上游里已取消的：这些依赖边已失效，需要人工裁决 */
	staleDeps: string[];
}

/** 库级元信息：需求层与项目约定都落在这里 */
export interface Meta {
	/** 需求：目标、边界、验收口径、基线 */
	requirement?: Requirement;
	/** 状态集：角色 → 状态名 */
	states?: Partial<Record<StateRole, string>>;
	/** 转换表覆盖：角色 → 允许到达的角色；不给就用默认表 */
	transitions?: Partial<Record<StateRole, StateRole[]>>;
	/** ID 前缀，默认 T */
	idPrefix?: string;
}

export interface Requirement {
	/** 接到的是什么需求 */
	goal: string;
	/** 范围边界 */
	scope?: string;
	/** 什么算交付 */
	acceptance?: string;
	/** 基线（提交号或版本） */
	baseline?: string;
	updatedAt: string;
}

export interface CreateInput {
	id?: string;
	title: string;
	body?: string;
	contents?: OrderContent[];
	nextActors: string[];
	/** 初始状态的角色，默认 claimable */
	role?: StateRole;
	dependsOn?: string[];
}

export interface UpdateInput {
	state?: string;
	/** 换成谁：给一个就是收敛成单人，给多个就是重新指定备选 */
	nextActors?: string[];
	title?: string;
	/** 整段替换正文；空串或全空白视为「这次不改正文」，不会把正文清空 */
	body?: string;
	/** 追加一段正文（范围修订用这个），在 body 之后拼接；与本次其他字段同一次事务 */
	appendBody?: string;
	/** 替换完整内容入口列表；省略保留，空数组清空。 */
	contents?: OrderContent[];
	closingBasis?: string;
}

export interface ListFilter {
	/** 连终态一起列。不给、也没显式 state 时，只看未到终态的 */
	history?: boolean;
	/** 只看某状态名；给了就以它为准，终态也算命中（不再叠加「跳过终态」） */
	state?: string;
	/** 只看候选里包含这个名字的 */
	nextActor?: string;
	/** 只看依赖已解、可开工的 */
	ready?: boolean;
}

export interface DependencyBlocker {
	id: string;
	state: string;
	cancelled: boolean;
}

/** 等处理、等依赖与取消依赖待裁定；分类不改变工单状态。 */
export interface Waiting {
	order: Order;
	kind: "action" | "dependency" | "decision";
	dependencies: DependencyBlocker[];
	/** 可处理起点；等依赖时仅记录状态进入时刻，不计催办。 */
	since: string;
}

export interface ActorContext {
	/** 谁在做这次改动，用于校验与留痕 */
	actor: string;
	/** 变更理由，必填 */
	reason: string;
}

export class LedgerError extends Error {}
