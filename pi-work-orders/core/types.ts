/**
 * 工单台账的类型与常量。
 *
 * 分层：本文件（及 schema.ts / store.ts）不 import 任何 pi 的东西，
 * 换 harness 或加 CLI 壳时可直接复用。pi 相关代码只在 index.ts。
 */

/** 终态语义：done 解锁下游，cancelled 让下游进待裁决 */
export type TerminalKind = "done" | "cancelled";

/**
 * 状态声明：项目自己定状态名与能力开关。
 *
 * 工具只读这些开关，不认状态名——项目可以加「待部署」「灰度中」这类自己的状态，
 * 只要声明它算不算等人、算不算在计时、算不算完。
 */
export interface StateDef {
	/** 状态名，项目的工单库里用的就是这个字面量 */
	name: string;
	/** 等人接手或裁定：停滞计时、待办视图按它挑单 */
	waiting?: boolean;
	/** 执行期内：墙钟在走，估算进度按它提醒 */
	timing?: boolean;
	/** 只许一个执行者：推进到这个状态时，执行者自动落成本次操作者 */
	singleOwner?: boolean;
	/** 执行视角：依赖没解就算阻塞，不催办 */
	execution?: boolean;
	/** 终态：done 解锁下游；cancelled 让下游进待裁决 */
	terminal?: TerminalKind;
	/** 推进到这个状态必须给终止依据：结单给证据，取消给理由 */
	needsBasis?: boolean;
	/** 建单不指定状态时的落点；没标就用第一个非终态状态 */
	initial?: boolean;
}

/**
 * 默认状态集：沿用「待认领 → 在做 → 待复核 → 收口」这套最常用的划分。
 * 项目可在库里整体替换（meta.states），不必与这里同名或同数量。
 */
export const DEFAULT_STATE_DEFS: readonly StateDef[] = [
	{ name: "待认领", waiting: true, execution: true, initial: true },
	{ name: "在做", timing: true, singleOwner: true, execution: true },
	{ name: "待复核", waiting: true },
	{ name: "被打回", waiting: true, execution: true },
	{ name: "阻塞", waiting: true, timing: true },
	{ name: "已收口", terminal: "done", needsBasis: true },
	{ name: "已取消", terminal: "cancelled", needsBasis: true },
];

/**
 * 默认工单类型枚举：只做分类与筛选，不参与状态流转。
 * 项目可在库里覆盖（meta.types），跟状态集同一套路。
 */
export const DEFAULT_TYPES: readonly string[] = ["需求单", "实施单", "bug 单"] as const;

/** 催办阈值（分钟）：等超过这个时长还没动，就算停滞，进提醒与扫描 */
export const STALE_MINUTES = 30;

/** 估算进度提醒的预警比例：过了预估墙钟的这个比例就提醒，不等超期才知道 */
export const ESTIMATE_WARN_RATIO = 0.8;

/** 等依赖超过这个分钟数就提醒（与「停滞」分开：等依赖不是谁没干活） */
export const WAIT_MINUTES = 120;

/** 工期：预估与实际都给「主动工时」与「墙钟」两个口径，差值就是被等待吃掉的部分 */
export interface Effort {
	/** 主动工时（分钟）：人在干的时间 */
	activeMin: number | null;
	/** 墙钟（分钟）：从开工到收尾的自然时间，含等待 */
	wallMin: number | null;
}

export type EstimateLevel = "none" | "ok" | "warn" | "over";

export interface EstimateStatus {
	level: EstimateLevel;
	/** 已用 / 预估墙钟；没有预估就是 null */
	ratio: number | null;
	/** 还剩多少分钟；超期时为负 */
	remainMin: number | null;
}

/** 交付偏差：实际减预估，只做减法不判断好坏 */
export interface DeliveryDeviation {
	/** 墙钟偏差（分钟）：实际 - 预估；缺一边就是 null */
	wallMin: number | null;
	/** 主动工时偏差（分钟） */
	activeMin: number | null;
	/** 等待占用的分钟数：优先取交付时填的 actualWaitMin，没填才用「墙钟 - 主动工时」推 */
	waitMin: number | null;
}

/** 估算：开工前给的数，附评估依据与不确定性 */
export interface Estimate extends Effort {
	/** 为什么是这个数、哪些地方不确定 */
	basis: string | null;
}

/**
 * 人工执行者的名字：等的是坐在终端前的人，不是会话。
 * 这类单没有 peer 可投（找不到叫「用户」的会话），只能走通知，不能当投递失败。
 */
export const HUMAN_ACTOR = "用户";

export function isHumanActor(name: string): boolean {
	return name.trim() === HUMAN_ACTOR;
}

/** 台账事件：只追加，不改。状态从哪来到哪去，问它 */
export type EventKind = "create" | "state" | "field" | "handoff" | "lock" | "unlock" | "dep-add" | "dep-remove";

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
	/** 这次动作写完之后工单是第几版；迁移前的旧事件为 null */
	revision: number | null;
}

/** 一条评论：与动作分开记，不推状态、不涨 revision、不触发交接通知 */
export interface OrderComment {
	id: number;
	orderId: string;
	actor: string;
	body: string;
	/** 作者当时看到的工单版本；没写就是 null */
	revision: number | null;
	at: string;
}

export interface OrderContent {
	name: string;
	/** 项目内 md 路径；入口本身不保证文件存在。 */
	path: string;
}

/**
 * 内容锁：口径定了就冻结，防止有人在执行途中改需求。
 *
 * 锁住的是「内容面」——标题、正文、内容入口、类型；状态、下一步、工时、终止依据不受影响，
 * 那些本来就是推进过程中要动的。解锁要单独一次调用，理由与时刻都进动作记录。
 */
export interface ContentLock {
	at: string;
	/** 谁锁的 */
	by: string;
}

export interface Order {
	id: string;
	title: string;
	/** 正文，markdown 文本；**以当前有效口径为准**，范围修订直接覆盖（旧内容留在 events 的理由里） */
	body: string;
	/** 工单类型，取值须在配置的枚举内；不分类就是 null */
	type: string | null;
	contents: OrderContent[];
	/** 当前状态名（取值为项目声明的状态集之一） */
	state: string;
	/** 这一步该谁动：有序候选，第一个是首选，后面是首选不在时的备选；用户本人也写成名字 */
	nextActors: string[];
	/** 终止依据：结单填证据指针，取消填理由或取代它的单号 */
	closingBasis: string | null;
	/** 开工前的估算；没估就是 null（不强制，缺了就只是没有进度提醒） */
	estimate: Estimate;
	/** 交付时的实际；未交付都是 null */
	actual: Effort;
	/** 等待依赖占用的分钟数，交付时填；不给就按依赖解锁事件推 */
	actualWaitMin: number | null;
	/** 偏差原因：实际与估算差在哪 */
	deliveryVariance: string | null;
	/** 可按占位继续的依据；空表示不可，必须等前置收口 */
	placeholderBasis: string | null;
	/** 内容锁；null 表示未锁 */
	contentLock: ContentLock | null;
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
	/** 状态集：项目自己声明的状态与能力开关；不给就用默认集 */
	states?: StateDef[];
	/** 工单类型枚举；不给就用默认三种，空数组表示这个项目不分类 */
	types?: string[];
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
	/** 初始状态名；省略落声明的初始状态 */
	state?: string;
	type?: string | null;
	dependsOn?: string[];
	/** 开工前的估算（主动工时 / 墙钟 / 依据） */
	estimate?: Partial<Estimate>;
	/** 可按占位继续的依据 */
	placeholderBasis?: string;
}

export interface UpdateInput {
	state?: string;
	/** 换成谁：给一个就是收敛成单人，给多个就是重新指定备选 */
	nextActors?: string[];
	title?: string;
	/** 改类型：省略保留，null 清空分类 */
	type?: string | null;
	/** 整段替换正文；空串或全空白视为「这次不改正文」，不会把正文清空 */
	body?: string;
	/** 追加一段正文（范围修订用这个），在 body 之后拼接；与本次其他字段同一次事务 */
	appendBody?: string;
	/** 替换完整内容入口列表；省略保留，空数组清空。 */
	contents?: OrderContent[];
	closingBasis?: string;
	/** 改写或补估：只传给出的字段，其余保留 */
	estimate?: Partial<Estimate>;
	/** 交付时回填的实际工时 */
	actual?: Partial<Effort>;
	actualWaitMin?: number | null;
	deliveryVariance?: string | null;
	placeholderBasis?: string | null;
	/** 锁定（true）或解锁（false）内容；解锁不能与本次的内容修改同时进行 */
	contentLock?: boolean;
}

export interface ListFilter {
	/** 连终态一起列。不给、也没显式 state 时，只看未到终态的 */
	history?: boolean;
	/** 只看某状态名；给了就以它为准，终态也算命中（不再叠加「跳过终态」） */
	state?: string;
	/** 只看候选里包含这个名字的 */
	nextActor?: string;
	/** 只看某个类型；不在枚举内的名字直接报错 */
	type?: string;
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
	/**
	 * 可处理起点 / 等待判定的起点。
	 *
	 * 等依赖时它指「当前这组未完成前置开始的时刻」——换过依赖边就从边变过的那一刻算，
	 * 不从头算。阈值告警用这个值：新的前置刚挂上就报「等了两小时」会催错人。
	 */
	since: string;
	/**
	 * 连续处于等依赖状态的起点（仅 kind=dependency 时有意义）。
	 * 与 since 不同时，说明中途换过依赖边：since 指当前这组，blocked 指这一整段。
	 * 只用于展示，不参与阈值判定。
	 */
	blockedSince?: string;
}

export interface ActorContext {
	/** 谁在做这次改动，用于校验与留痕 */
	actor: string;
	/** 变更理由，必填 */
	reason: string;
}

export class LedgerError extends Error {}
