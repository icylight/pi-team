/**
 * pi-work-orders —— 本机 SQLite 工单台账（扩展壳）
 *
 * 分工：
 * - core/ 是纯 sqlite 逻辑，不 import pi 的东西，可单独测试与复用
 * - 本文件只做三件事：解析库路径、注入 actor、把 core 的能力挂成工具与命令
 *
 * 推进靠四条路，各管一段：
 * 1. 库是真相源：谁该动、挂了多久，任何会话都能查
 * 2. 每轮对话开始时算一次摘要注入上下文（before_agent_start）——只用台账、不用 peer 也看得到
 * 3. 写库后尝试唤醒对方（走 peer 的事件总线）——有 peer 就快，没 peer 不报错
 * 4. 定时提醒（跟一个角色会话走）——会话静下来时，停滞的单自己响
 *
 * 约定层的规则（角色怎么分工、状态集叫什么）不在这里，由项目的 skill 声明；
 * 这里只锚定「角色」，不认状态名。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { Type } from "typebox";
import { buildDigest, buildWakeText, renderStale } from "./core/digest.ts";
import { describeError, formatHistory, formatList, formatOrder, formatWaiting } from "./core/format.ts";
import {
	defaultDbPath,
	eventsOf,
	initLedger,
	isTerminal,
	isWaitingState,
	openLedger,
	statesOf,
} from "./core/schema.ts";
import {
	addDep,
	countBlockedDownstream,
	createOrder,
	getOrder,
	listHint,
	listOrders,
	readyOrders,
	removeDep,
	requirementOf,
	setRequirement,
	updateOrder,
	waitingOrders,
} from "./core/store.ts";
import { isHumanActor, type Order, STALE_MINUTES, type StateRole } from "./core/types.ts";
import {
	buildWatchText,
	followsRole,
	loadWatchConfig,
	WATCH_DEFAULTS,
	type WatchConfig,
	type WatchState,
	watchConfigFile,
} from "./core/watch.ts";

let api: ExtensionAPI | undefined;

export default function (pi: ExtensionAPI) {
	api = pi;

	// ── 库路径与打开 ────────────────────────────────

	function dbPathFor(ctx?: ExtensionContext): string {
		const fromEnv = process.env.PI_WORK_ORDERS_DB?.trim();
		if (fromEnv) return fromEnv;
		return defaultDbPath(ctx?.cwd ?? process.cwd());
	}

	function withDb<T>(ctx: ExtensionContext | undefined, fn: (db: ReturnType<typeof openLedger>) => T): T {
		const db = openLedger(dbPathFor(ctx));
		try {
			return fn(db);
		} finally {
			db.close();
		}
	}

	// ── actor ───────────────────────────────────────

	// 本会话的身份名：优先 peer 角色名（dev / qa / owner 这种，跨重启稳定），
	// 其次 pi 的会话名，都没有就按「用户」——开着终端坐在前面的人。
	// 不用「目录名-pid」：它重启即变，写进 next_actors 就是一条没人接得住的死链。
	let identity = "";

	function actorName(): string {
		if (identity) return identity;
		const sessionName = api?.getSessionName?.()?.trim();
		return sessionName || "用户";
	}

	/** 问 pi-peer「我是谁」；peer 不在场就返回空串，安静降级 */
	async function askPeerWhoami(): Promise<string> {
		if (!api?.events) return "";
		const events = api.events;
		const id = `whoami-${Date.now().toString(36)}`;
		return await new Promise<string>((resolve) => {
			let unsubscribe: (() => void) | undefined;
			const finish = (name: string) => {
				clearTimeout(timer);
				unsubscribe?.();
				resolve(name);
			};
			const timer = setTimeout(() => finish(""), 300);
			unsubscribe = events.on("peer:whoami:result", (data) => {
				const reply = data as { id?: string; name?: string } | undefined;
				if (reply?.id === id) finish(reply.name?.trim() ?? "");
			});
			events.emit("peer:whoami", { id });
		});
	}

	function resolveActor(_ctx: ExtensionContext | undefined, explicit?: string): string {
		if (explicit?.trim()) return explicit.trim();
		return actorName();
	}

	// ── 定时提醒：跟随一个角色，自己叫自己 ───────────────

	// 停滞的单没人提就永远停在那里。外部定时器只认库、认不出在场的人，所以定时这件事跟着角色会话走：
	// 配置指定的角色会话活着时，自己隔一会儿自查一次，把该动的拼成一条注入成用户消息。
	// 会话不在就没人提——这是这个设计的边界，不是漏洞。
	let watchTimer: NodeJS.Timeout | undefined;
	let watchCtx: ExtensionContext | undefined;
	let watchConfig: WatchConfig = WATCH_DEFAULTS;
	let watchState: WatchState = {};
	let agentBusy = false;

	pi.on("agent_start", () => {
		agentBusy = true;
	});

	pi.on("agent_end", () => {
		agentBusy = false;
	});

	function stopWatch(): void {
		if (watchTimer !== undefined) clearTimeout(watchTimer);
		watchTimer = undefined;
	}

	function scheduleWatch(): void {
		stopWatch();
		if (!watchCtx) return;
		watchTimer = setTimeout(watchTick, watchConfig.intervalMinutes * 60_000);
		// 提醒不该拖着 pi 不退出
		watchTimer.unref?.();
	}

	/** 到点自查一次：忙就不插队（跟写库派工只投空闲会话一个道理），下轮再看 */
	function watchTick(): void {
		const ctx = watchCtx;
		if (!ctx) return;
		scheduleWatch();
		// 在跑一轮时不打断：对方手上的活比提醒重要
		if (agentBusy || ctx.isIdle?.() === false) return;
		// 库是会话中途才建也认：这里每轮看一次，建了就从下一轮开始提
		const dbPath = dbPathFor(ctx);
		if (!fs.existsSync(dbPath)) return;

		try {
			const db = openLedger(dbPath);
			try {
				const note = buildWatchText(db, { me: actorName(), config: watchConfig, state: watchState });
				watchState = note.state;
				if (note.text) pi.sendUserMessage(note.text);
			} finally {
				db.close();
			}
		} catch {
			// 库读不了：静默跳过。工具与 /orders 会在有人真去看的那一刻正面报错
		}
	}

	function startWatch(ctx: ExtensionContext): void {
		stopWatch();
		watchCtx = ctx;
		watchState = {};
		const file = watchConfigFile(ctx.cwd);
		const { config, problems } = loadWatchConfig(file);
		watchConfig = config;
		// 配置没读全就当场说一声：静默按默认值跑，等于配了没生效
		if (problems.length && ctx.hasUI) ctx.ui.notify(`工单定时提醒的配置没读全：\n${problems.join("\n")}`, "warning");
		if (!followsRole(actorName(), config.followRole)) return;
		scheduleWatch();
	}

	// ── 工具返回 ────────────────────────────────────

	type ToolResult = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };

	function ok(text: string): ToolResult {
		return { content: [{ type: "text", text }], details: {} };
	}

	function fail(error: unknown): ToolResult {
		return { content: [{ type: "text", text: `失败：${describeError(error)}` }], details: {} };
	}

	function run(fn: () => string): ToolResult {
		try {
			return ok(fn());
		} catch (error) {
			return fail(error);
		}
	}

	// ── 唤醒：写库后把「该你了」投给对方 ──────────────

	/** 事件总线上与 pi-peer 约定的两个频道；peer 不在场时 emit 无回声，按超时处理 */
	const WAKE_CHANNEL = "peer:deliver";
	const WAKE_RESULT_CHANNEL = "peer:deliver:result";
	const WAKE_TIMEOUT_MS = 400;

	/**
	 * 问 pi-peer：这批候选里第一个在线且空闲的，把这句话带过去。
	 *
	 * 要求空闲是故意的：peer 的投递会 steer 插进对方当前这轮，把正在做事的人带偏。
	 * 忙就跳过，对方下一轮开始时读到的启动摘要里本来就有这条单。
	 */
	async function wake(targets: string[], text: string): Promise<string> {
		if (!api?.events || !targets.length) return "";
		const events = api.events;
		const id = `wake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const reply = await new Promise<string>((resolve) => {
			let unsubscribe: (() => void) | undefined;
			const finish = (note: string) => {
				clearTimeout(timer);
				unsubscribe?.();
				resolve(note);
			};
			const timer = setTimeout(() => finish(""), WAKE_TIMEOUT_MS);
			unsubscribe = events.on(WAKE_RESULT_CHANNEL, (data) => {
				const replyData = data as { id?: string; ok?: boolean; to?: string; detail?: string } | undefined;
				if (replyData?.id !== id) return;
				if (replyData.ok) finish(`已通知 ${replyData.to ?? targets[0]}`);
				else finish(`没叫到人（${replyData.detail ?? "未知原因"}）`);
			});
			events.emit(WAKE_CHANNEL, { id, targets, text, requireIdle: true });
		});
		return reply;
	}

	/**
	 * 写库后的派工：唤对方一次，把结果写成一行附在工具返回里。
	 * 唤不到不算失败——库已经落了，摘要会在对方（或自己）下次开会话时把它拽出来。
	 * 两种不值得唤的：自己（认领后的在做单、自派）、人工执行者（没有叫这个名的会话）。
	 */
	async function wakeFor(order: Order, kind: "assigned" | "handoff" | "unblocked", me: string): Promise<string> {
		const targets = order.nextActors.filter((name) => name !== me && !isHumanActor(name));
		if (!targets.length) return "";
		return wake(targets, buildWakeText(order, kind));
	}

	interface Mutation {
		text: string;
		order: Order;
		/** 这次写库之后该不该叫人、叫谁 */
		wake: "assigned" | "handoff" | "unblocked" | "none";
		/** 收口解锁的下游：wake=unblocked 时要叫的人 */
		unblocked: Order[];
	}

	/** 写库之后统一收尾：派工的结果附在返回文本里 */
	async function finishMutation(mutation: Mutation, me: string): Promise<ToolResult> {
		if (mutation.wake === "none") return ok(mutation.text);
		const notes: string[] = [];
		const targets = mutation.wake === "unblocked" ? mutation.unblocked : [mutation.order];
		for (const order of targets) {
			const note = await wakeFor(order, mutation.wake, me);
			if (note) notes.push(targets.length > 1 ? `${order.id}：${note}` : note);
		}
		return ok([mutation.text, ...notes].filter(Boolean).join("\n"));
	}

	// ── 工具 ────────────────────────────────────────

	pi.registerTool({
		name: "orders_init",
		label: "建工单库",
		description:
			"在当前项目建立工单库（默认 .work-orders/work-orders.sqlite，随项目走、不进 git）。可同时写入本轮需求的目标、边界与验收口径。库已存在则报错，不会覆盖。",
		parameters: Type.Object({
			goal: Type.Optional(Type.String({ description: "这一轮接到的是什么需求" })),
			scope: Type.Optional(Type.String({ description: "范围边界：不做什么" })),
			acceptance: Type.Optional(Type.String({ description: "什么算交付" })),
			baseline: Type.Optional(Type.String({ description: "基线：从哪个提交或版本开工" })),
			idPrefix: Type.Optional(Type.String({ description: "工单号前缀，默认 T" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return run(() => {
				const dbPath = dbPathFor(ctx);
				const db = initLedger(dbPath, {
					requirement: params.goal
						? {
								goal: params.goal,
								scope: params.scope,
								acceptance: params.acceptance,
								baseline: params.baseline,
							}
						: undefined,
					idPrefix: params.idPrefix,
				});
				try {
					return `工单库已建：${dbPath}\n状态集：${Object.values(statesOf(db)).join(" · ")}`;
				} finally {
					db.close();
				}
			});
		},
	});

	pi.registerTool({
		name: "orders_list",
		label: "列工单",
		description:
			"列工单。默认只看未到终态的。ready=true 只看依赖已解、可以开工的；next 只看下一步找某人的；state 只看某个状态（写已收口这类终态也算命中，不用再加 history）；history=true 连已收口与已取消一起列。",
		parameters: Type.Object({
			next: Type.Optional(Type.String({ description: "只看下一步找这个名字的工单" })),
			state: Type.Optional(Type.String({ description: "只看某个状态；终态也算命中" })),
			ready: Type.Optional(Type.Boolean({ description: "只看依赖已解、可开工的" })),
			history: Type.Optional(Type.Boolean({ description: "回看历史时用：把已收口与已取消也列出来（默认不列）" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return run(() =>
				withDb(ctx, (db) => {
					const filter = {
						history: params.history,
						state: params.state?.trim() || undefined,
						nextActor: params.next?.trim() || undefined,
						ready: params.ready,
					};
					if (params.ready) {
						const rows = readyOrders(db).filter(
							(o) => !filter.nextActor || o.nextActors.includes(filter.nextActor),
						);
						const hint = rows.length ? undefined : listHint(db, { ...filter, ready: false });
						return [formatList(rows, "可开工"), hint].filter(Boolean).join("\n");
					}
					const rows = listOrders(db, filter);
					const heading = filter.state ? `状态：${filter.state}` : filter.history ? "全部" : "未收口";
					const hint = rows.length ? undefined : listHint(db, filter);
					return [formatList(rows, heading), hint].filter(Boolean).join("\n");
				}),
			);
		},
	});

	pi.registerTool({
		name: "orders_show",
		label: "看工单",
		description: "看一条工单的全文：正文、依赖、下游、终止依据、时间，以及最近几次动作。",
		parameters: Type.Object({
			id: Type.String({ description: "工单号，如 T01" }),
			history: Type.Optional(Type.Number({ description: "带上最近几条动作记录，默认 5，最多 20" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return run(() =>
				withDb(ctx, (db) => {
					const view = getOrder(db, params.id);
					const limit = Math.min(20, Math.max(0, Math.floor(params.history ?? 5)));
					const events = limit ? eventsOf(db, params.id, limit) : [];
					return [formatOrder(view), events.length ? `最近动作：\n${formatHistory(events)}` : ""]
						.filter(Boolean)
						.join("\n\n");
				}),
			);
		},
	});

	pi.registerTool({
		name: "orders_create",
		label: "建工单",
		description:
			"建一条工单。正文写目标、交付物、边界、输入、验收口径（markdown）。dependsOn 传上游工单号，会做环检测。",
		parameters: Type.Object({
			title: Type.String({ description: "一句话说清这条要干什么" }),
			nextActors: Type.Array(Type.String(), {
				description: "下一步找谁：第一个是首选，后面是首选不在时的备选（会话名；等用户批准就写用户）",
			}),
			body: Type.Optional(Type.String({ description: "正文，markdown" })),
			id: Type.Optional(Type.String({ description: "指定工单号；不给就自动编号" })),
			role: Type.Optional(
				Type.String({
					description: "初始状态角色：claimable（默认）/ active（接了就直接在做）",
				}),
			),
			dependsOn: Type.Optional(Type.Array(Type.String({ description: "上游工单号" }))),
			reason: Type.Optional(Type.String({ description: "这条为什么要建" })),
			actor: Type.Optional(Type.String({ description: "操作者名字，默认取本会话名" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const me = resolveActor(ctx, params.actor);
			let mutation: Mutation;
			try {
				mutation = withDb(ctx, (db) => {
					const view = createOrder(
						db,
						{
							id: params.id,
							title: params.title,
							body: params.body,
							nextActors: params.nextActors,
							role: params.role as StateRole | undefined,
							dependsOn: params.dependsOn,
						},
						{ actor: me, reason: params.reason ?? "建单" },
					);
					return { text: formatOrder(view), order: view, wake: "assigned", unblocked: [] };
				});
			} catch (error) {
				return fail(error);
			}
			return finishMutation(mutation, me);
		},
	});

	pi.registerTool({
		name: "orders_update",
		label: "改工单",
		description:
			"改工单状态或字段。转换按角色校验（未声明的转换会拒绝）；结单必须有终止依据（证据指针），取消必须给理由或取代它的单号。appendBody 用于范围修订：追加一段，不覆盖旧句。",
		parameters: Type.Object({
			id: Type.String({ description: "工单号" }),
			reason: Type.String({ description: "为什么这么改（必填）" }),
			state: Type.Optional(Type.String({ description: "目标状态" })),
			nextActors: Type.Optional(
				Type.Array(Type.String(), { description: "改成谁：给一个就是这个人接手，给多个就是重新指定备选" }),
			),
			title: Type.Optional(Type.String({ description: "改标题" })),
			body: Type.Optional(Type.String({ description: "整段替换正文（少用）；传空串表示这次不改正文" })),
			appendBody: Type.Optional(
				Type.String({ description: "追加一段正文（范围修订用这个）；与同一次调用的其他字段同事务" }),
			),
			closingBasis: Type.Optional(Type.String({ description: "终止依据：结单填证据指针，取消填理由/被谁取代" })),
			expectedRevision: Type.Optional(Type.Number({ description: "手里这条的 rev，用于并发冲突检测" })),
			actor: Type.Optional(Type.String({ description: "操作者名字，默认取本会话名" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const me = resolveActor(ctx, params.actor);
			let mutation: Mutation;
			try {
				mutation = withDb(ctx, (db) => {
					const actorCtx = { actor: me, reason: params.reason };
					// 空串当「这次不改这个字段」：调用方习惯用 "" 占位，不能让它把正文清空
					const body = params.body?.trim() ? params.body : undefined;
					const append = params.appendBody?.trim() ? params.appendBody : undefined;
					const needsPatch =
						params.state != null ||
						params.nextActors != null ||
						params.title != null ||
						body != null ||
						append != null ||
						params.closingBasis != null;
					// 正文追加跟字段写入走同一次 updateOrder：一起生效或一起回滚，
					// 否则第二次调用报错时，正文已经落库，调用方却以为失败。
					const view = needsPatch
						? updateOrder(
								db,
								params.id,
								{
									state: params.state,
									nextActors: params.nextActors,
									title: params.title,
									body,
									appendBody: append,
									closingBasis: params.closingBasis,
								},
								actorCtx,
								params.expectedRevision,
							)
						: getOrder(db, params.id);
					const notes: string[] = [];
					if (params.state && view.closingBasis == null) {
						const downstream = countBlockedDownstream(db, params.id);
						if (downstream > 0) notes.push(`下游还有 ${downstream} 条未收口，确认它们的前置是否已经落空`);
					}
					// 收口解锁下游：把刚变可开工、还没人接的下游带回去，写完就派下去
					const unblocked = isTerminal(db, view.state)
						? readyOrders(db).filter(
								(o) => o.state === statesOf(db).claimable && view.blocks.includes(o.id) && o.nextActors.length,
							)
						: [];
					// 叫人的判据：进了「等人动」的状态就叫当事人；收口则改叫刚解锁的下游；
					// 认领/阻塞这类不叫人（前者是自己接手，后者谁也没得动）。
					const kind = isTerminal(db, view.state)
						? unblocked.length
							? "unblocked"
							: "none"
						: isWaitingState(db, view.state)
							? "handoff"
							: "none";
					return { text: [formatOrder(view), ...notes].join("\n\n"), order: view, wake: kind, unblocked };
				});
			} catch (error) {
				return fail(error);
			}
			return finishMutation(mutation, me);
		},
	});

	pi.registerTool({
		name: "orders_dep",
		label: "改依赖",
		description: "加工单之间的依赖边（DAG，插入时环检测），或删一条。",
		parameters: Type.Object({
			id: Type.String({ description: "这条工单" }),
			dep: Type.String({ description: "依赖/不依赖的那条" }),
			action: Type.String({ description: "add 或 remove" }),
			reason: Type.String({ description: "为什么改依赖" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return run(() =>
				withDb(ctx, (db) => {
					const actorCtx = { actor: resolveActor(ctx), reason: params.reason };
					const view =
						params.action === "remove"
							? removeDep(db, params.id, params.dep, actorCtx)
							: addDep(db, params.id, params.dep, actorCtx);
					return formatOrder(view);
				}),
			);
		},
	});

	pi.registerTool({
		name: "orders_requirement",
		label: "看/改需求",
		description: "看本轮需求（目标、边界、验收口径、基线）；给了字段就更新。交付前对照它核对。",
		parameters: Type.Object({
			goal: Type.Optional(Type.String({ description: "需求目标" })),
			scope: Type.Optional(Type.String({ description: "范围边界" })),
			acceptance: Type.Optional(Type.String({ description: "什么算交付" })),
			baseline: Type.Optional(Type.String({ description: "基线" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return run(() =>
				withDb(ctx, (db) => {
					const hasPatch =
						params.goal != null || params.scope != null || params.acceptance != null || params.baseline != null;
					const req = hasPatch
						? setRequirement(db, {
								goal: params.goal ?? requirementOf(db)?.goal ?? "",
								scope: params.scope ?? requirementOf(db)?.scope,
								acceptance: params.acceptance ?? requirementOf(db)?.acceptance,
								baseline: params.baseline ?? requirementOf(db)?.baseline,
							})
						: requirementOf(db);
					if (!req) return "还没有记录需求（用 orders_requirement 写一条）";
					const lines = [`目标：${req.goal}`];
					if (req.scope) lines.push(`边界：${req.scope}`);
					if (req.acceptance) lines.push(`验收口径：${req.acceptance}`);
					if (req.baseline) lines.push(`基线：${req.baseline}`);
					lines.push(`更新于 ${req.updatedAt.slice(0, 16).replace("T", " ")}`);
					return lines.join("\n");
				}),
			);
		},
	});

	// ── 会话启动：先认下身份，再把「谁该动了」注入上下文 ──

	// 身份在会话启动时问一次 peer 并缓存：工具调用时 resolveActor 要同步拿到它。
	// 拿到身份之后就能判「这个会话是不是该负责定时提醒的那个角色」。
	pi.on("session_start", async (_event, ctx) => {
		identity = await askPeerWhoami();
		startWatch(ctx);
	});

	// 会话结束、切走、重载：定时器跟着这个会话的生命周期走，别留给下一个会话
	pi.on("session_shutdown", () => {
		stopWatch();
		watchCtx = undefined;
	});

	// 摘要区在系统提示里，每轮对话开始前重算一次。这是「只用台账、不用 peer」场景的兜底：
	// 不管会话是谁开的、peer 在不在，只要打开项目就能看到有东西在等。
	pi.on("before_agent_start", (event, ctx) => {
		const sections = event.systemPromptOptions.sections;
		try {
			const text = withDb(ctx, (db) => buildDigest(db, { me: actorName(), staleMinutes: staleMinutes() }).text);
			if (text) sections.work_orders = `当前项目的工单台账（自动摘要，处理完用 orders_update 回写）：\n\n${text}`;
			else delete sections.work_orders;
		} catch {
			// 库没建、版本不匹配等：不在系统提示里报错，需要时由工具报
			delete sections.work_orders;
		}
	});

	function staleMinutes(): number {
		const fromEnv = Number(process.env.PI_WORK_ORDERS_STALE_MINUTES?.trim());
		return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : STALE_MINUTES;
	}

	// ── 命令 ────────────────────────────────────────

	pi.registerCommand("orders", {
		description: "看当前项目的在办工单（用法：/orders [ready|stale|all|doctor]）",
		handler: async (args, ctx) => {
			const mode = args.trim();
			try {
				const text = withDb(ctx, (db) => {
					if (mode === "ready") return formatList(readyOrders(db), "可开工");
					if (mode === "stale") return renderStale(db, { staleMinutes: staleMinutes() });
					if (mode === "mine") return formatWaiting(waitingOrders(db, actorName()), "等你的");
					if (mode === "doctor") return renderDoctor(db);
					if (mode === "all") return formatList(listOrders(db, { history: true }), "全部");
					return formatList(listOrders(db), "未收口");
				});
				ctx.ui.notify(text, "info");
			} catch (error) {
				ctx.ui.notify(describeError(error), "warning");
			}
		},
	});

	/**
	 * `/orders doctor`：查那些会静默失效的写法。
	 * 最典型的是 next_actors 里写了会话 key——当时能用，会话一重启就没人接得住。
	 */
	function renderDoctor(db: ReturnType<typeof openLedger>): string {
		const lines: string[] = [];
		const all = listOrders(db, { history: true });
		const states = statesOf(db);
		lines.push(
			`工单 ${all.length} 条｜未收口 ${all.filter((o) => o.state !== states.done && o.state !== states.cancelled).length} 条`,
		);

		const ephemeral = all.filter((o) =>
			o.nextActors.some((n) => /^\d+-[0-9a-f]{4}$/.test(n) || /[A-Za-z0-9_.-]+-\d{2,}$/.test(n)),
		);
		if (ephemeral.length) {
			lines.push(`下一步找谁写了会话 key（重启即失效，请换成角色名）：`);
			for (const o of ephemeral) lines.push(`  ${o.id} ${o.state} → ${o.nextActors.join(", ")}`);
		}

		const noActor = all.filter(
			(o) => o.nextActors.length === 0 && o.state !== states.done && o.state !== states.cancelled,
		);
		if (noActor.length) lines.push(`未收口但没写下一步找谁：${noActor.map((o) => o.id).join("、")}`);

		const staleDeps = all.filter((o) => getOrder(db, o.id).staleDeps.length);
		if (staleDeps.length) lines.push(`上游已取消、依赖已失效：${staleDeps.map((o) => o.id).join("、")}`);

		if (lines.length === 1) lines.push("没发现问题");
		return lines.join("\n");
	}
}
