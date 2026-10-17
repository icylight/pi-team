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

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildDigest, buildDispatchBrief, formatDispatchBrief, renderStale } from "./core/digest.ts";
import { describeError, formatHistory, formatList, formatOrder, formatWaiting } from "./core/format.ts";
import {
	acknowledgeNotification,
	claimNotification,
	consumeNotification,
	deferNotification,
	listNotifications,
	NOTIFICATION_PROTOCOL,
	notificationPath,
	openNotifications,
	reconcileNotifications,
} from "./core/notifications.ts";
import { defaultDbPath, eventsOf, initLedger, openLedger, statesOf } from "./core/schema.ts";
import {
	addDep,
	countBlockedDownstream,
	createOrder,
	deliveryDeviation,
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
import { type Order, STALE_MINUTES, type StateRole } from "./core/types.ts";
import {
	buildWatchText,
	followsRole,
	loadWatchConfig,
	WATCH_DEFAULTS,
	type WatchConfig,
	type WatchState,
	watchConfigFile,
} from "./core/watch.ts";
import { buildFreshness } from "./core/web-build.ts";

let api: ExtensionAPI | undefined;

// ── 看板：跨项目只读浏览，跑在独立进程里 ──────────────

// 不挂在会话上：会话开开关关，看板还在；多个会话共用一个端口。
const WEB_LOG = path.join(os.tmpdir(), "pi-work-orders-web.log");
const WEB_PORT_DEFAULT = 8787;

function webPort(): number {
	const value = Number(process.env.PI_WORK_ORDERS_WEB_PORT?.trim());
	return Number.isInteger(value) && value > 0 && value <= 65535 ? value : WEB_PORT_DEFAULT;
}

/** 探端口上是不是我们的看板：既能问「在没在跑」，也能等「起来没」 */
async function webAlive(port: number, timeout = 500): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const req = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout, agent: false }, (res) => {
			res.resume();
			resolve(res.statusCode === 200);
		});
		req.on("error", () => resolve(false));
		req.on("timeout", () => {
			req.destroy();
			resolve(false);
		});
	});
}

async function webStop(port: number): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const req = http.request(
			{ host: "127.0.0.1", port, path: "/shutdown", method: "POST", timeout: 1000, agent: false },
			(res) => {
				res.resume();
				resolve(res.statusCode === 200);
			},
		);
		req.on("error", () => resolve(false));
		req.on("timeout", () => {
			req.destroy();
			resolve(false);
		});
		req.end();
	});
}

function openBrowser(url: string): void {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		spawn(command, args, { detached: true, stdio: "ignore" }).unref();
	} catch {
		// 打不开不算失败：地址会告知用户，手动点一样
	}
}

/** 重建看板产物。同步跑：这个操作要在起服务之前完成，用户等十几秒比拿到旧页面好 */
async function webRebuild(webRoot: string): Promise<{ ok: boolean; detail: string }> {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	return await new Promise((resolve) => {
		const child = spawn(npm, ["run", "build"], { cwd: webRoot, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		const collect = (chunk: Buffer) => {
			out += chunk.toString();
			if (out.length > 20_000) out = out.slice(-20_000);
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		child.on("error", (error) => resolve({ ok: false, detail: String(error) }));
		child.on("close", (code) => {
			if (code === 0) resolve({ ok: true, detail: "" });
			else resolve({ ok: false, detail: out.trimEnd().split("\n").slice(-12).join("\n") });
		});
	});
}

/** `/orders web`：没有在跑的就起一个，然后开浏览器；`stop` 把常驻的那个收掉 */
async function handleWeb(sub: string, ctx: ExtensionContext): Promise<void> {
	const port = webPort();
	const url = `http://127.0.0.1:${port}/`;
	if (sub === "stop") {
		if (await webStop(port)) {
			// 等它真退再报：立刻回报会撞上退出中的服务，用户接着敲 web 就误判成「已在跑」
			for (let i = 0; i < 10 && (await webAlive(port, 200)); i++) await sleep(100);
			ctx.ui.notify(`看板已停（端口 ${port}）`, "info");
			return;
		}
		ctx.ui.notify(`端口 ${port} 上没有在跑的看板`, "warning");
		return;
	}
	const webRoot = fileURLToPath(new URL("./web", import.meta.url));
	const nextBin = path.join(webRoot, "node_modules", "next", "dist", "bin", "next");
	const running = await webAlive(port);

	// 产物旧了就先重建：否则跑的是旧代码，页面上报的错与库无关（典型是 SCHEMA_VERSION 对不上）。
	// 已在跑也一样——旧进程同样得换掉，不然用户看到的还是旧逻辑。
	const build = buildFreshness(webRoot);
	if (build.stale && fs.existsSync(nextBin)) {
		const why = build.buildAt
			? `产物建于 ${new Date(build.buildAt).toLocaleString("zh-CN", { hour12: false })}，` +
				`而 ${path.relative(webRoot, build.newestSource) || "源码"} 改于 ` +
				`${new Date(build.sourceAt).toLocaleString("zh-CN", { hour12: false })}`
			: "还没有构建产物";
		ctx.ui.notify(`看板产物过期（${why}），正在重建，约十几秒…`, "info");
		if (running) {
			await webStop(port);
			for (let i = 0; i < 30 && (await webAlive(port, 200)); i++) await sleep(100);
		}
		const rebuilt = await webRebuild(webRoot);
		if (!rebuilt.ok) {
			ctx.ui.notify(`看板重建失败：\n${rebuilt.detail}`, "warning");
			return;
		}
		if (await webAlive(port)) {
			// 重建期间别人可能已经把服务起起来了，那它读的也是新产物，直接用
			openBrowser(url);
			ctx.ui.notify(`看板已重建并在跑：${url}`, "info");
			return;
		}
	} else if (running) {
		openBrowser(url);
		ctx.ui.notify(`看板已在跑，已打开浏览器：${url}`, "info");
		return;
	}

	try {
		// Next 的服务：用 next 的 bin 直接起（不依赖 PATH 里的 next），绑 127.0.0.1 由 -H 指定。
		// 产物过期时上面已重建；没有产物又缺依赖的，给出安装命令。
		if (!fs.existsSync(nextBin)) {
			ctx.ui.notify(`看板的 Next 依赖没装。先构建：cd ${webRoot} && npm install && npm run build`, "warning");
			return;
		}
		const log = fs.openSync(WEB_LOG, "a");
		spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
			cwd: webRoot,
			env: {
				...process.env,
				// 会话所在目录当扫描根，看板里就有当前项目（原 serve --root 的等价物）
				PI_WORK_ORDERS_WEB_ROOTS: ctx.cwd,
			},
			detached: true,
			stdio: ["ignore", log, log],
		}).unref();
		fs.closeSync(log);
	} catch (error) {
		ctx.ui.notify(`看板起不来：${describeError(error)}`, "warning");
		return;
	}

	// 等它就绪：起来了才敢说「已打开」，没起来就把日志尾巴给用户
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		if (await webAlive(port)) {
			openBrowser(url);
			ctx.ui.notify(`看板起在 ${url}，浏览器随后打开。停：/orders web stop`, "info");
			return;
		}
	}
	ctx.ui.notify(`看板没起来，日志（${WEB_LOG}）尾部：\n${tailLog()}`, "warning");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function tailLog(): string {
	try {
		return fs.readFileSync(WEB_LOG, "utf8").trimEnd().split("\n").slice(-8).join("\n");
	} catch {
		return "（没有日志）";
	}
}

const ContentEntrySchema = Type.Object({
	name: Type.String({ description: "内容名称，同一工单内唯一，如需求、方案或验证" }),
	path: Type.String({ description: "项目内相对 md 路径；允许尚未创建的文件，只保存入口" }),
});

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

	pi.events.on("peer:identity-changed", (data) => {
		const change = data as { name?: string } | undefined;
		if (typeof change?.name !== "string") return;
		identity = change.name.trim();
		if (watchCtx) startWatch(watchCtx);
	});

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

	/** 请求空闲目标接收本次租约；返回只确认收件箱写入，送达另等持久化事件。 */
	async function wake(
		targets: string[],
		text: string,
		handoff: { id: string; lease: string },
	): Promise<{ accepted: boolean; detail: string }> {
		if (!api?.events || !targets.length) return { accepted: false, detail: "没有可用 peer 或候选" };
		const events = api.events;
		const id = `wake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const reply = await new Promise<{ accepted: boolean; detail: string }>((resolve) => {
			let unsubscribe: (() => void) | undefined;
			const finish = (note: { accepted: boolean; detail: string }) => {
				clearTimeout(timer);
				unsubscribe?.();
				resolve(note);
			};
			const timer = setTimeout(
				() => finish({ accepted: false, detail: "peer 确认超时，留待恢复" }),
				WAKE_TIMEOUT_MS,
			);
			unsubscribe = events.on(WAKE_RESULT_CHANNEL, (data) => {
				const replyData = data as { id?: string; ok?: boolean; to?: string; detail?: string } | undefined;
				if (replyData?.id !== id) return;
				finish({
					accepted: replyData.ok === true,
					detail: replyData.detail ?? (replyData.ok ? "已写入收件箱，等待注入确认" : "未知原因"),
				});
			});
			events.emit(WAKE_CHANNEL, { id, targets, text, requireIdle: true, priority: "normal", handoff });
		});
		return reply;
	}

	/** 耐久交接可由任意同项目会话恢复，队列不依赖发起者存活。 */
	let deliveryTimer: NodeJS.Timeout | undefined;
	let flushing = false;
	async function flushNotifications(ctx?: ExtensionContext): Promise<void> {
		if (flushing || !fs.existsSync(dbPathFor(ctx))) return;
		flushing = true;
		let queue: ReturnType<typeof openNotifications> | undefined;
		try {
			queue = openNotifications(notificationPath(dbPathFor(ctx)));
			const currentQueue = queue;
			withDb(ctx, (db) => reconcileNotifications(db, currentQueue));
			for (const row of listNotifications(queue)
				.filter((n) => n.status === "waiting" || (n.status === "sending" && n.leaseUntil <= Date.now()))
				.slice(0, 20)) {
				const claimed = claimNotification(queue, row.id);
				if (!claimed?.lease) continue;
				const result = await wake(claimed.targets, claimed.text, { id: claimed.id, lease: claimed.lease });
				if (!result.accepted) deferNotification(queue, claimed.id, claimed.lease, result.detail);
			}
		} finally {
			queue?.close();
			flushing = false;
		}
	}
	function scheduleDelivery(ctx: ExtensionContext): void {
		if (deliveryTimer) clearTimeout(deliveryTimer);
		deliveryTimer = setTimeout(() => {
			void flushNotifications(ctx)
				.catch(() => {})
				.finally(() => {
					if (watchCtx === ctx) scheduleDelivery(ctx);
				});
		}, 5_000);
		deliveryTimer.unref?.();
	}
	pi.events.on("work-orders:consume-handoff", (data) => {
		const request = data as
			| { id?: string; lease?: string; identities?: string[]; alreadyPersisted?: boolean; deliver?: () => void }
			| undefined;
		if (
			!watchCtx ||
			agentBusy ||
			watchCtx.isIdle?.() === false ||
			typeof request?.id !== "string" ||
			typeof request.lease !== "string" ||
			!Array.isArray(request.identities) ||
			typeof request.deliver !== "function"
		)
			return;
		const queue = openNotifications(notificationPath(dbPathFor(watchCtx)));
		try {
			withDb(watchCtx, (db) =>
				consumeNotification(
					db,
					queue,
					request.id!,
					request.lease!,
					request.identities!,
					request.deliver!,
					Date.now(),
					request.alreadyPersisted === true,
				),
			);
		} finally {
			queue.close();
		}
	});

	pi.events.on("work-orders:handoff-injected", (data) => {
		const request = data as { id?: string; lease?: string; wake?: () => void } | undefined;
		if (!watchCtx || typeof request?.id !== "string" || typeof request.lease !== "string") return;
		const queue = openNotifications(notificationPath(dbPathFor(watchCtx)));
		let acknowledged = false;
		try {
			acknowledged = acknowledgeNotification(queue, request.id, request.lease);
		} finally {
			queue.close();
		}
		if (acknowledged) request.wake?.();
	});

	interface Mutation {
		text: string;
		order: Order;
	}

	/** 写库之后统一收尾：派工的结果附在返回文本里 */
	async function finishMutation(mutation: Mutation, _me: string, ctx: ExtensionContext): Promise<ToolResult> {
		try {
			await flushNotifications(ctx);
			const queue = openNotifications(notificationPath(dbPathFor(ctx)));
			try {
				const rows = listNotifications(queue, mutation.order.id);
				const note = rows.length
					? rows.map((n) => `${n.status}：${n.reason || "等待目标会话持久化确认"}`).join("；")
					: "当前无须通知（本人、人工作业或等待依赖）";
				return ok(`${mutation.text}\n台账写入成功；通知：${note}。通知不代表已认领。`);
			} finally {
				queue.close();
			}
		} catch (error) {
			return ok(
				`${mutation.text}\n台账写入成功；通知记录失败：${describeError(error)}，恢复扫描会重建交接，勿重复业务写入。`,
			);
		}
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
		name: "orders_notifications",
		label: "工单通知状态",
		description: "只读查询本项目交接通知的等待、传输中、已注入、失效或失败状态；与台账写入和认领状态分别看。",
		parameters: Type.Object({ id: Type.Optional(Type.String({ description: "只看此工单；省略看全部通知" })) }),
		async execute(_callId, params, _signal, _update, ctx) {
			const file = notificationPath(dbPathFor(ctx));
			if (!fs.existsSync(file)) return ok("尚无通知记录；不代表所有工单已通知");
			const queue = openNotifications(file, true);
			try {
				return ok(JSON.stringify(listNotifications(queue, params.id).slice(-100), null, 2));
			} finally {
				queue.close();
			}
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
					return [formatList(rows, heading, waitingOrders(db)), hint].filter(Boolean).join("\n");
				}),
			);
		},
	});

	pi.registerTool({
		name: "orders_show",
		label: "看工单",
		description: "看一条工单的全文：正文、具名 md 内容入口、依赖、下游、终止依据、时间，以及最近几次动作。",
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
					// 派工要看的是现场：卡哪个前置、前置留下什么、能不能先占位、手上那份过期没
					const brief = formatDispatchBrief(buildDispatchBrief(db, view));
					return [
						formatOrder(view, { deviation: deliveryDeviation(view) }),
						brief ? `现场：\n${brief}` : "",
						events.length ? `最近动作：\n${formatHistory(events)}` : "",
					]
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
			"建一条工单。正文写目标、交付物、边界、输入、验收口径（markdown）；详细内容可用 contents 关联具名 md 文件。dependsOn 传上游工单号，会做环检测。有把握的话一并给估算（主动工时 / 墙钟 / 依据），没估也能建，只是没有进度提醒。",
		parameters: Type.Object({
			title: Type.String({ description: "一句话说清这条要干什么" }),
			nextActors: Type.Array(Type.String(), {
				description: "下一步找谁：第一个是首选，后面是首选不在时的备选（会话名；等用户批准就写用户）",
			}),
			body: Type.Optional(Type.String({ description: "正文，markdown" })),
			contents: Type.Optional(Type.Array(ContentEntrySchema, { description: "具名 md 内容入口；省略默认为空列表" })),
			id: Type.Optional(Type.String({ description: "指定工单号；不给就自动编号" })),
			role: Type.Optional(
				Type.String({
					description: "初始状态角色：claimable（默认）/ active（接了就直接在做）",
				}),
			),
			dependsOn: Type.Optional(Type.Array(Type.String({ description: "上游工单号" }))),
			estimateActiveMin: Type.Optional(
				Type.Number({ description: "预估主动工时（分钟）：真正在干的时间，不含等待" }),
			),
			estimateWallMin: Type.Optional(
				Type.Number({ description: "预估墙钟（分钟）：从现在到收尾的自然时间，含等待与中断" }),
			),
			estimateBasis: Type.Optional(Type.String({ description: "评估依据与不确定性：为什么是这个数、哪块没底" })),
			placeholderBasis: Type.Optional(Type.String({ description: "可按占位继续的依据；不写表示必须等前置收口" })),
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
							contents: params.contents,
							nextActors: params.nextActors,
							role: params.role as StateRole | undefined,
							dependsOn: params.dependsOn,
							estimate: {
								activeMin: params.estimateActiveMin,
								wallMin: params.estimateWallMin,
								basis: params.estimateBasis,
							},
							placeholderBasis: params.placeholderBasis,
						},
						{ actor: me, reason: params.reason ?? "建单" },
					);
					return { text: formatOrder(view, { deviation: deliveryDeviation(view) }), order: view };
				});
			} catch (error) {
				return fail(error);
			}
			return finishMutation(mutation, me, ctx);
		},
	});

	pi.registerTool({
		name: "orders_update",
		label: "改工单",
		description:
			"改工单状态或字段。转换按角色校验（未声明的转换会拒绝）；结单必须有终止依据（证据指针），取消必须给理由或取代它的单号。正文以当前有效口径为准：范围修订直接用 body 覆盖旧口径（理由写进 reason），appendBody 只用于补一小段，别靠追加堆大部头。收口时回填实际工时与实际偏差。",
		parameters: Type.Object({
			id: Type.String({ description: "工单号" }),
			reason: Type.String({ description: "为什么这么改（必填）" }),
			state: Type.Optional(Type.String({ description: "目标状态" })),
			nextActors: Type.Optional(
				Type.Array(Type.String(), { description: "改成谁：给一个就是这个人接手，给多个就是重新指定备选" }),
			),
			title: Type.Optional(Type.String({ description: "改标题" })),
			body: Type.Optional(
				Type.String({
					description:
						"换掉正文：范围修订与口径变化用这个，改完正文就是唯一有效的说法（旧口径由 reason 与动作记录留痕）；传空串表示这次不改正文",
				}),
			),
			appendBody: Type.Optional(
				Type.String({
					description: "往正文末尾补一小段（只用于补充，不用于范围修订）；与同一次调用的其他字段同事务",
				}),
			),
			contents: Type.Optional(
				Type.Array(ContentEntrySchema, {
					description: "替换完整内容入口列表；省略保留，传 [] 清空，建议同时传 expectedRevision",
				}),
			),
			closingBasis: Type.Optional(Type.String({ description: "终止依据：结单填证据指针，取消填理由/被谁取代" })),
			estimateActiveMin: Type.Optional(Type.Number({ description: "预估主动工时（分钟）；改估就直接覆盖" })),
			estimateWallMin: Type.Optional(Type.Number({ description: "预估墙钟（分钟）；改估就直接覆盖" })),
			estimateBasis: Type.Optional(Type.String({ description: "评估依据与不确定性" })),
			actualActiveMin: Type.Optional(Type.Number({ description: "实际主动工时（分钟），交付时回填" })),
			actualWallMin: Type.Optional(Type.Number({ description: "实际墙钟（分钟），交付时回填" })),
			actualWaitMin: Type.Optional(Type.Number({ description: "其中等待依赖占用的分钟数，交付时回填" })),
			deliveryVariance: Type.Optional(
				Type.String({ description: "偏差原因：实际与估算差在哪（等待、返工、范围变化…）" }),
			),
			placeholderBasis: Type.Optional(Type.String({ description: "可按占位继续的依据；传空串表示取消这个许可" })),
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
						params.contents !== undefined ||
						params.closingBasis != null ||
						params.estimateActiveMin != null ||
						params.estimateWallMin != null ||
						params.estimateBasis != null ||
						params.actualActiveMin != null ||
						params.actualWallMin != null ||
						params.actualWaitMin != null ||
						params.deliveryVariance != null ||
						params.placeholderBasis !== undefined;
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
									contents: params.contents,
									closingBasis: params.closingBasis,
									estimate: {
										activeMin: params.estimateActiveMin,
										wallMin: params.estimateWallMin,
										basis: params.estimateBasis,
									},
									actual: {
										activeMin: params.actualActiveMin,
										wallMin: params.actualWallMin,
									},
									actualWaitMin: params.actualWaitMin,
									deliveryVariance: params.deliveryVariance,
									placeholderBasis: params.placeholderBasis,
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
					if (params.actualActiveMin != null && params.deliveryVariance == null && view.estimate.wallMin != null) {
						const dev = deliveryDeviation(view);
						if (dev.wallMin != null && Math.abs(dev.wallMin) > Math.max(10, view.estimate.wallMin * 0.2)) {
							notes.push("实际与估算差得多，建议用 deliveryVariance 写下差在哪（等待、返工、范围变化）");
						}
					}
					return {
						text: [formatOrder(view, { deviation: deliveryDeviation(view) }), ...notes].join("\n\n"),
						order: view,
					};
				});
			} catch (error) {
				return fail(error);
			}
			return finishMutation(mutation, me, ctx);
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
		agentBusy = false;
		identity = await askPeerWhoami();
		startWatch(ctx);
		pi.events.emit("peer:handoff-support", { version: NOTIFICATION_PROTOCOL });
		scheduleDelivery(ctx);
	});

	// 会话结束、切走、重载：定时器跟着这个会话的生命周期走，别留给下一个会话
	pi.on("session_shutdown", () => {
		stopWatch();
		watchCtx = undefined;
		pi.events.emit("peer:handoff-support", { version: 0 });
		if (deliveryTimer) clearTimeout(deliveryTimer);
		deliveryTimer = undefined;
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
		description: "看工单（/orders [ready|stale|mine|all|doctor|web]；web 在浏览器里跨项目看，web stop 停）",
		handler: async (args, ctx) => {
			const mode = args.trim();
			if (mode === "web" || mode.startsWith("web ")) {
				await handleWeb(mode.slice(3).trim(), ctx);
				return;
			}
			try {
				const text = withDb(ctx, (db) => {
					if (mode === "ready") return formatList(readyOrders(db), "可开工");
					if (mode === "stale") return renderStale(db, { staleMinutes: staleMinutes() });
					if (mode === "mine") return formatWaiting(waitingOrders(db, actorName()), "等你的");
					if (mode === "doctor") return renderDoctor(db);
					if (mode === "all") return formatList(listOrders(db, { history: true }), "全部", waitingOrders(db));
					return formatList(listOrders(db), "未收口", waitingOrders(db));
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
