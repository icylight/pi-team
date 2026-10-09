/**
 * pi-peer —— 同一文件夹下多个 pi 会话互通
 *
 * 场景：同一个目录里开两个 pi（可以挂不同模型），需要临时互相问/互相通报。
 *
 * 机制：
 * - 每个会话启动时把自己注册到 ~/.pi/peers/<cwdKey>/members/，并持续心跳
 * - 发消息 = 往对方的 pending/ 目录原子写一个 JSON
 * - 收消息 = fs.watch 监听自己的 pending/（2s 轮询兜底），取走后注入会话并唤醒对方
 * - 跨项目：按「项目标签/名字」寻址，投递写的是对方的桶；接收方不用升级也能收
 *
 * 与其他方案的区别：不依赖 tmux、不起 broker 进程、无网络、无第三方依赖。
 *
 * 命令：
 *   /peers [all]        列出同目录其他会话；all 连其他项目一起列
 *   /peer-name <名字>    给普通会话起名（持久化到 session）
 *   /peer-send <目标> <正文>   目标可写「项目/名字」发给其他项目
 *   /peer-new [--role 角色]  当前终端新建会话并领取角色；同角色实例自动命名为 dev、dev-2……
 *
 * 角色会话：领取角色时把角色卡与项目流程注入 system prompt，消息按具体实例名寻址。
 * 角色不支持运行中切换；重启会话会沿用会话里记录的角色。
 *
 * 工具：peer_list / peer_send / peer_inbox
 *
 * 关闭：项目内 <cwd>/.pi/peer.json 写 {"enabled": false}；或进程级环境变量 PI_PEER_OFF=1
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	CONFIG_FILE,
	configWarnings,
	declaredRoleNames,
	describeConfig,
	discoverRoles,
	loadProjectConfig,
	type ProjectConfig,
	renderConfigReport,
	resolveFlow,
	resolveRoleCard,
} from "./config.ts";
import {
	isBusy,
	MAX_TEXT,
	type Member,
	newMessageId,
	newSessionKey,
	type PeerMessage,
	PeerStore,
	projectLabel,
	type ResolveResult,
} from "./store.ts";

/** 项目级配置与「生效值从哪来」都在 config.ts，这里只留用法 */

/** 自定义消息类型（TUI 渲染 + 辨识来源用） */
const CUSTOM_TYPE = "peer";
const HEARTBEAT_MS = 5_000;
const POLL_MS = 2_000;
const DRAIN_DEBOUNCE_MS = 50;
/** 会话条目类型：记录本会话领取的角色，重启后据此恢复 */
const ROLE_ENTRY = "peer-role";
/** 角色选择列表里的自定义项；角色名须以字母开头，所以它与真角色不会重名 */
const CUSTOM_ROLE_ITEM = "＋ 自定义角色名…";

// ── 会话内状态 ──────────────────────────────────────

/** 扩展 API 句柄：模块级函数（deliver 等）需要它，不能依赖闭包参数 */
let api: ExtensionAPI | undefined;
let store: PeerStore | undefined;
let self: Member | undefined;
let ctxRef: ExtensionContext | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let drainTimer: NodeJS.Timeout | undefined;
let watcher: fs.FSWatcher | undefined;
let draining = false;
let roleCard: string | undefined;
let flowDocument: string | undefined;

export default function (pi: ExtensionAPI) {
	// 关掉时整个扩展不注册：工具、命令、心跳、收件箱监听都不起
	// 判定用工厂期 cwd —— pi 全程不改进程工作目录，与 ctx.cwd 一致
	const configPath = path.join(process.cwd(), CONFIG_DIR_NAME, CONFIG_FILE);
	const loaded = loadProjectConfig(configPath);
	if (process.env.PI_PEER_OFF === "1" || loaded.config.enabled === false) return;

	api = pi;

	/** 生效配置的报告：启动提示与 /peer-config 共用，保证「报的」就是「跑的」 */
	function configReport(cwd: string, role?: string) {
		return describeConfig(loaded, { cwd, role, dirName: CONFIG_DIR_NAME });
	}

	// ── 生命周期 ────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		teardown();

		const root = process.env.PI_PEER_ROOT?.trim() || path.join(os.homedir(), CONFIG_DIR_NAME, "peers");
		store = new PeerStore(root, ctx.cwd);

		const key = newSessionKey();
		const restoredRole = restoreRole(ctx);
		const requestedRole = process.env.PI_PEER_ROLE?.trim() || restoredRole?.role;
		const role = requestedRole && isValidRoleName(requestedRole) ? requestedRole : undefined;
		const roleCardPath = role ? resolveRoleCard(ctx.cwd, loaded.config, role, CONFIG_DIR_NAME).path : undefined;
		if (requestedRole && !role && ctx.hasUI) {
			ctx.ui.notify(`pi-peer: 角色名非法，忽略 PI_PEER_ROLE=${JSON.stringify(requestedRole)}`, "warning");
		}
		if (role && !roleCardPath && ctx.hasUI) {
			ctx.ui.notify(`pi-peer: 未找到角色 ${role} 的角色卡，按普通会话启动`, "warning");
		}
		const effectiveRole = role && roleCardPath ? role : undefined;

		// 生效配置从哪来：角色定下来才判得了「角色卡是声明的还是兜底命中的」，所以放在这里报。
		// 该不该出声由 configWarnings 判：除了项目标签，兜底真生效了、或文件本身有问题，才提。
		if (ctx.hasUI) {
			for (const warning of configWarnings(configReport(ctx.cwd, effectiveRole ?? role))) {
				ctx.ui.notify(`pi-peer: ${warning}`, "warning");
			}
		}

		const roleSlot = effectiveRole
			? store.claimRoleName(effectiveRole, key, process.pid, restoredRole?.name)
			: undefined;
		const project = projectLabel(loaded.config.group?.name, ctx.cwd);
		roleCard = roleCardPath ? readOptionalFile(roleCardPath) : undefined;
		flowDocument = readOptionalFile(resolveFlow(ctx.cwd, loaded.config, CONFIG_DIR_NAME).path);
		self = {
			key,
			name:
				roleSlot ??
				restoreName(ctx) ??
				pi.getSessionName() ??
				`${path.basename(ctx.cwd) || "session"}-${process.pid}`,
			project,
			role: effectiveRole,
			roleSlot,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
			pid: process.pid,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile(),
			startedAt: Date.now(),
			lastSeen: Date.now(),
		};
		if (effectiveRole && (restoredRole?.role !== effectiveRole || restoredRole?.name !== roleSlot)) {
			pi.appendEntry(ROLE_ENTRY, { role: effectiveRole, name: roleSlot });
		}

		store.ensure(key);
		store.register(self);

		// 收件箱监听：fs.watch 负责实时，轮询兜底（某些文件系统 watch 不可靠）
		try {
			watcher = fs.watch(store.pendingDir(key), () => scheduleDrain());
			watcher.on("error", () => {
				/* 文件系统不支持时静默退化到轮询 */
			});
		} catch {
			// 目录尚未就绪等情况，靠轮询
		}
		pollTimer = setInterval(scheduleDrain, POLL_MS);
		pollTimer.unref?.();

		heartbeatTimer = setInterval(() => {
			if (!store || !self) return;
			try {
				store.heartbeat(self);
				store.prune(self.key);
			} catch {
				// 心跳失败不影响会话
			}
			refreshStatus();
		}, HEARTBEAT_MS);
		heartbeatTimer.unref?.();

		refreshStatus();
		scheduleDrain();

		if (ctx.hasUI) {
			const peers = livePeers();
			if (peers.length > 0) {
				ctx.ui.notify(
					`pi-peer: 同目录另有 ${peers.length} 个会话（${peers.map((p) => p.name).join(", ")}）`,
					"info",
				);
			}
		}
	});

	// 忙闲：派工方据此避开正在跑一轮的会话，不打断进行中的工作。
	// agent_end 在中断路径上是否必发待确认，所以 busySince 让 store 侧能按超时兜底。
	pi.on("agent_start", () => {
		if (!store || !self) return;
		self.busy = true;
		self.busySince = Date.now();
		try {
			store.register(self);
		} catch {
			// 写不进去不影响会话
		}
	});

	pi.on("agent_end", () => {
		if (!store || !self) return;
		self.busy = false;
		self.busySince = undefined;
		try {
			store.register(self);
		} catch {
			// 同上
		}
	});

	pi.on("session_shutdown", async () => {
		teardown();
	});

	pi.on("before_agent_start", (event) => {
		const sections = event.systemPromptOptions.sections;
		if (roleCard) {
			sections.peer_role = `当前加载的 peer 角色卡（角色：${self?.role ?? "未知"}）：\n\n${roleCard}`;
		} else {
			delete sections.peer_role;
		}
		if (flowDocument) {
			sections.peer_flow = `当前项目的 peer 工作流（Markdown，仅作为交接规则参考）：\n\n${flowDocument}`;
		} else {
			delete sections.peer_flow;
		}
	});

	// ── 寻址与投递 ──────────────────────────────────

	/** 解析目标：带项目前缀走全机扫描，否则只在本项目桶里找 */
	function resolveTarget(to: string): ResolveResult {
		const { project, name } = splitTarget(to);
		if (!store || !self) return { ok: false, reason: "none", candidates: [] };
		return project ? store.resolveScoped(project, name, self.key) : store.resolve(name, self.key);
	}

	/** 投递到解析出的桶。跨桶时落款带项目前缀，对方抄回去就能回信 */
	function deliverTo(
		res: Extract<ResolveResult, { ok: true }>,
		body: string,
		opts: { replyTo?: string; thread?: string } = {},
	): PeerMessage | undefined {
		if (!store || !self) return undefined;
		const parent = opts.replyTo ? store.findMessage(self.key, opts.replyTo) : undefined;
		const id = newMessageId();
		const msg: PeerMessage = {
			id,
			from: self.key,
			fromName: res.bucket === store.dir ? self.name : `${self.project}/${self.name}`,
			fromModel: self.model,
			to: res.member.key,
			thread: opts.thread ?? parent?.thread ?? (parent ? parent.id : undefined) ?? id,
			replyTo: parent?.id,
			text: body.slice(0, MAX_TEXT),
			ts: Date.now(),
		};
		store.send(msg, res.bucket);
		store.logSent(self.key, msg);
		return msg;
	}

	/** 解析失败时给一句能自救的提示：项目不存在与名字不存在是两种错 */
	function resolveHint(to: string, res: Extract<ResolveResult, { ok: false }>): string {
		if (res.reason === "self") return "目标是你自己，不能发给自己。";
		const { project, name } = splitTarget(to);
		if (res.reason === "offline") {
			// 离线不写信箱：写进死 key 的信没人取，发件人会以为已经送达
			const who = res.candidates.map((m) => m.name).join(", ") || to;
			return `${who} 不在线，消息没发出（没有写进收件箱，避免信躺在死掉的会话里）。等对方启动后再发，或改用同目录在线会话。`;
		}
		if (res.reason === "ambiguous") {
			const names = res.candidates.map((m) => (project ? `${project}/${m.name}` : m.name)).join(", ");
			return `目标不唯一，请用更完整的名称或 id：${names}`;
		}
		if (project) {
			if (res.projects?.length) {
				return `没有项目 ${project} 的在线会话。当前在线项目：${res.projects.join(", ")}`;
			}
			const names = res.candidates.map((m) => m.name).join(", ");
			return `找不到 ${project} 的会话「${name}」。该项目在线会话：${names || "（无）"}`;
		}
		const names = res.candidates.map((m) => m.name).join(", ");
		// 本项目找不到时看看别的项目有没有同名的：最常见的错就是漏了项目前缀
		const twin = name
			? (store?.listAllMembers() ?? []).filter(
					(s) => s.bucket !== store!.dir && s.member.name.toLowerCase() === name.toLowerCase(),
				)
			: [];
		const cross = twin.length
			? `；其他项目里有 ${twin.map((s) => `${s.project}/${s.member.name}`).join(", ")}，带上项目前缀就能发`
			: "";
		return `找不到目标“${to}”。可用 peer_list 查看；现有会话：${names || "（无）"}${cross}`;
	}

	// ── TUI 渲染：把注入的消息画成对话气泡 ────────────

	pi.registerMessageRenderer(CUSTOM_TYPE, (message, options, theme) => {
		const details = (message.details ?? {}) as { fromName?: string; fromModel?: string };
		const head =
			theme.fg("accent", `⇄ ${details.fromName ?? "peer"}`) + theme.fg("dim", ` · ${details.fromModel ?? "?"}`);
		const body = (message.content ?? "").replace(/^\[peer\][^\n]*\n\n?/, "");
		return new Text(`${head}\n${body}`, options.outputPad, 0);
	});

	// ── 工具 ────────────────────────────────────────

	pi.registerTool({
		name: "peer_list",
		label: "Peer List",
		description:
			'列出同目录其他 pi 会话（可互通的同伴）：名称、模型、会话 id、状态。scope="all" 连其他项目的会话一起列。',
		promptSnippet: "列出同目录其他 pi 会话",
		promptGuidelines: [
			"用 peer_list 查看当前文件夹下其他 pi 会话；用 peer_send 给它们发消息（对方会被唤醒并看到正文）。",
			'peer_list 传 scope="all" 看其他项目的会话；发消息时写「项目/名字」当目标。',
			"收到 [peer] 消息后只在确实需要回答或行动时才回复；对方只是通报进度或结论时不要回确认，避免两个会话互相刷屏。",
		],
		parameters: Type.Object({
			all: Type.Optional(Type.Boolean({ description: "包含已离线成员（默认只列在线的）" })),
			scope: Type.Optional(Type.String({ description: '范围："local"（默认）只看本项目；"all" 连其他项目一起列' })),
		}),
		async execute(_toolCallId, params) {
			if (!store || !self) return text("pi-peer 未启用（未注册成功）");
			const includeStale = Boolean(params.all);
			const scopeAll = params.scope === "all";

			// scope=all 时一次扫完全部桶；本项目那部分从这里分出来，不再单独读一次
			const scan = scopeAll ? store.listAllMembers({ includeStale: true }) : undefined;
			const own = (scan ? scan.filter((s) => s.bucket === store!.dir) : store.listScoped({ includeStale })).filter(
				(s) => s.member.key !== self!.key,
			);
			const foreign = (scan ?? []).filter((s) => s.bucket !== store!.dir && s.member.key !== self!.key);

			// 「在忙」只是提示：手动发消息照样能发，会自动插到对方当前这轮之后
			const render = (m: Member, live: boolean, label: string) => {
				const age = Math.round((Date.now() - m.lastSeen) / 1000);
				return (
					`- ${label}${m.role ? `（角色：${m.role}）` : ""}｜${m.model}｜${
						live ? (isBusy(m) ? "在线·在忙" : "在线·空闲") : "离线"
					}` + `｜id=${m.key}｜pid=${m.pid}｜${age}s 前心跳`
				);
			};

			if (own.length === 0 && foreign.length === 0) {
				return text(
					`当前文件夹没有其他 pi 会话。\n在新终端 cd 到同一目录再开一个 pi，或用 /peer-new 在当前终端新建（可带角色）。\n（我自己的会话 id：${self.key}，名称：${self.name}${self.role ? `，角色：${self.role}` : ""}）`,
				);
			}

			const lines = [
				...own.map((s) => render(s.member, s.live, s.member.name)),
				...foreign.map((s) => render(s.member, s.live, `${s.project}/${s.member.name}`)),
			];
			if (!scopeAll) {
				const others = store.listAllMembers().filter((s) => s.bucket !== store!.dir);
				if (others.length > 0) {
					lines.push(`（另有 ${others.length} 个其他项目的在线会话，peer_list 传 scope="all" 看）`);
				}
			}
			return text(`同目录其他会话（${own.length + foreign.length}）：\n${lines.join("\n")}`);
		},
	});

	pi.registerTool({
		name: "peer_send",
		label: "Peer Send",
		description: "给同一文件夹下的另一个 pi 会话发消息。对方会被唤醒并在它的会话里看到这条消息（含回复指引）。",
		promptSnippet: "给同目录另一个 pi 会话发消息",
		promptGuidelines: [
			'peer_send 的 to 写「名字」就发给本项目；写「项目/名字」可以发给其他项目的会话（先用 peer_list 称 scope="all" 查）。',
		],
		parameters: Type.Object({
			to: Type.String({ description: "目标会话：名称、项目/名称、name#pid、id 前缀或 pid（先用 peer_list 查）" }),
			text: Type.String({ description: "消息正文，说清楚你要什么" }),
			replyTo: Type.Optional(Type.String({ description: "回复某条消息时填它的 id，会自动继承会话线索" })),
			thread: Type.Optional(Type.String({ description: "显式指定会话线索 id" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!store || !self) return text("pi-peer 未启用（未注册成功）");

			const res = resolveTarget(params.to);
			if (!res.ok) return text(resolveHint(params.to, res));

			const msg = deliverTo(res, params.text, { replyTo: params.replyTo, thread: params.thread });
			if (!msg) return text("pi-peer 未启用（未注册成功）");
			ctx?.ui.notify(`→ ${res.member.name}: ${firstLine(msg.text)}`, "info");

			return text(`已发给 ${res.member.name}（${res.member.model}）｜id=${msg.id}｜对方会被唤醒处理`);
		},
	});

	pi.registerTool({
		name: "peer_inbox",
		label: "Peer Inbox",
		description: "查看我收到的历史 peer 消息（新→旧），用于回溯对方说过什么。",
		promptSnippet: "查看收到的 peer 消息历史",
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ description: "条数，默认 10，最多 50" })),
		}),
		async execute(_toolCallId, params) {
			if (!store || !self) return text("pi-peer 未启用（未注册成功）");
			const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? 10)));
			const items = store.history(self.key, limit);
			if (items.length === 0) return text("还没有收到过 peer 消息。");
			const lines = items.map((m) => {
				const ago = Math.round((Date.now() - m.ts) / 1000);
				return `[${new Date(m.ts).toLocaleTimeString()}] ${m.fromName}（${ago}s 前）id=${m.id}\n  ${m.text.replace(/\n/g, "\n  ")}`;
			});
			return text(lines.join("\n"));
		},
	});

	// ── 代其他扩展投递：pi-work-orders 的派工走这里 ────
	//
	// 约定四个频道（两边都改动时要同时改）：
	//   peer:deliver        { id, targets: string[], text }  → 投给这批候选里第一个在线的
	//   peer:deliver:result { id, ok, to?, detail }          → 投递结果，失败也要回，否则对方等超时
	//   peer:whoami         { id }                           → 问本会话叫什么（角色实例名）
	//   peer:whoami:result  { id, name }                     → 角色名，没有角色时为空串
	//
	// 走事件总线而不是 ctx.executeTool("peer_send")：不占一次工具调用，也不触发权限询问。
	const WAKE_CHANNEL = "peer:deliver";
	const WAKE_RESULT_CHANNEL = "peer:deliver:result";

	// 台账写操作要拿会话名当 actor：名字不能靠每个工具调用手传，否则总会有人漏
	pi.events.on("peer:whoami", (data) => {
		const request = data as { id?: string } | undefined;
		if (!request?.id) return;
		pi.events.emit("peer:whoami:result", { id: request.id, name: self?.name ?? "" });
	});

	pi.events.on(WAKE_CHANNEL, (data) => {
		const request = data as { id?: string; targets?: string[]; text?: string; requireIdle?: boolean } | undefined;
		if (!request?.id) return;
		const targets = request.targets ?? [];
		const reply = (ok: boolean, detail: string, to?: string) =>
			pi.events.emit(WAKE_RESULT_CHANNEL, { id: request.id, ok, detail, to });

		if (!store || !self) return reply(false, "该会话没启用 pi-peer");
		const skipped: string[] = [];
		for (const target of targets) {
			const resolved = request.requireIdle ? store.resolveIdle(target, self.key) : resolveTarget(target);
			if (!resolved.ok) {
				// 在忙与离线要分开报：前者等一等就好，后者得换人
				if (resolved.reason === "busy") skipped.push(`${resolved.candidates[0]?.name ?? target} 在忙`);
				continue;
			}
			if (resolved.member.key === self.key) continue;
			const message = deliverTo(resolved, request.text ?? "");
			if (message) return reply(true, "已投递", resolved.member.name);
		}
		if (skipped.length) return reply(false, skipped.join("、"));
		return reply(false, targets.length ? `候选都不在线：${targets.join("、")}` : "没有候选");
	});

	// ── 命令 ────────────────────────────────────────

	pi.registerCommand("peers", {
		description: "列出同目录其他 pi 会话（/peers all 连其他项目一起列）",
		handler: async (args, ctx) => {
			if (!store || !self) {
				ctx.ui.notify("pi-peer 未启用", "warning");
				return;
			}
			const scopeAll = args.trim() === "all";
			const own = store.listScoped().filter((s) => s.member.key !== self!.key);
			const foreignAll = store.listAllMembers().filter((s) => s.bucket !== store!.dir && s.member.key !== self!.key);
			const lines = [
				...own.map(
					(s) =>
						`${s.member.name}${s.member.role ? `（角色：${s.member.role}）` : ""} · ${s.member.model} · id=${s.member.key}`,
				),
				...(scopeAll
					? foreignAll.map((s) => `${s.project}/${s.member.name} · ${s.member.model} · id=${s.member.key}`)
					: []),
			];
			if (!scopeAll && foreignAll.length > 0) {
				lines.push(`（另有 ${foreignAll.length} 个其他项目的在线会话，/peers all 看）`);
			}
			if (lines.length === 0) {
				ctx.ui.notify(`我是 ${self.name}（${self.key}）；同目录暂无其他会话`, "info");
				return;
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("peer-config", {
		description: "看生效的项目配置从哪来（哪些是声明的、哪些走了兜底）",
		handler: async (_args, ctx) => {
			const report = configReport(ctx.cwd || process.cwd(), self?.role);
			const enabled = loaded.config.enabled === false ? "已关" : "启用";
			ctx.ui.notify([renderConfigReport(report), `enabled（工具与命令是否注册）：${enabled}`].join("\n"), "info");
		},
	});

	pi.registerCommand("peer-role", {
		description: "查看本会话当前角色（角色只能在启动时指定）",
		handler: async (_args, ctx) => {
			if (!self) {
				ctx.ui.notify("pi-peer 未启用", "warning");
				return;
			}
			ctx.ui.notify(self.role ? `当前角色：${self.role}，实例名：${self.name}` : "当前会话未加载角色", "info");
		},
	});

	pi.registerCommand("peer-name", {
		description: "设置本会话在 pi-peer 里的名字（用法：/peer-name reviewer）",
		handler: async (args, ctx) => {
			const name = args.trim().slice(0, 40);
			if (!name) {
				ctx.ui.notify(`当前名称：${self?.name ?? "（未启用）"}`, "info");
				return;
			}
			if (!store || !self) {
				ctx.ui.notify("pi-peer 未启用", "warning");
				return;
			}
			if (self.role) {
				ctx.ui.notify(`角色会话名称由 peer 自动分配（当前：${self.name}），不能手动修改`, "warning");
				return;
			}
			self.name = name;
			store.register(self);
			pi.appendEntry("peer-name", { name });
			ctx.ui.notify(`pi-peer 名称已设为 ${name}`, "info");
			refreshStatus();
		},
	});

	pi.registerCommand("peer-send", {
		description: "手动给另一个 pi 会话发消息（用法：/peer-send <目标|项目/目标> <正文>）",
		handler: async (args, ctx) => {
			if (!store || !self) {
				ctx.ui.notify("pi-peer 未启用", "warning");
				return;
			}
			const m = /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
			if (!m) {
				ctx.ui.notify("用法：/peer-send <目标|项目/目标> <正文>", "warning");
				return;
			}
			const res = resolveTarget(m[1]);
			if (!res.ok) {
				ctx.ui.notify(resolveHint(m[1], res), "warning");
				return;
			}
			deliverTo(res, m[2]);
			ctx.ui.notify(`→ ${res.member.name}（已投递）`, "info");
		},
	});

	pi.registerCommand("peer-new", {
		description: "新建会话并领取角色（用法：/peer-new [--role 角色]）",
		handler: async (args, ctx) => {
			if (!store || !self) {
				ctx.ui.notify("pi-peer 未启用", "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("需要在交互界面里选择角色", "warning");
				return;
			}
			const parsed = parseRoleFlag(args);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}

			let role = parsed.role;
			if (!role) {
				const names = listRoleNames(ctx.cwd, loaded.config);
				if (names.length === 0) {
					ctx.ui.notify(
						`找不到可用角色：请在 ${CONFIG_DIR_NAME}/characters/ 下放一份 <角色>.md，` +
							`或在 ${CONFIG_DIR_NAME}/${CONFIG_FILE} 的 roles 里声明角色卡路径`,
						"warning",
					);
					return;
				}
				const picked = await ctx.ui.select("新会话用什么角色？", [...names, CUSTOM_ROLE_ITEM]);
				if (!picked) return;
				if (picked === CUSTOM_ROLE_ITEM) {
					role = (await ctx.ui.input("自定义角色名", `对应 ${CONFIG_DIR_NAME}/characters/<角色名>.md`))?.trim();
					if (!role) return;
				} else {
					role = picked;
				}
			}

			if (!isValidRoleName(role)) {
				ctx.ui.notify("角色名只能包含字母、数字、下划线和连字符，且必须以字母开头", "warning");
				return;
			}
			const cardPath = resolveRoleCard(ctx.cwd, loaded.config, role, CONFIG_DIR_NAME).path;
			// 没有角色卡也照开：只是没卡而已，会话退成普通会话，用 /peer-name 起名。
			// 这种会话不记角色条目 —— 否则每次启动都会拿一个永远找不到卡的名称再警一次。
			const result = await ctx.newSession({
				setup: cardPath
					? async (sessionManager) => {
							sessionManager.appendCustomEntry(ROLE_ENTRY, { role });
						}
					: undefined,
				withSession: async (newCtx) => {
					if (!newCtx.hasUI) return;
					newCtx.ui.notify(
						cardPath
							? `已新建角色会话 ${self?.name ?? role}（角色：${role}）`
							: `找不到角色 ${role} 的角色卡，已按普通会话新建；用 /peer-name 起名，` +
									`或补上 ${CONFIG_DIR_NAME}/characters/${role}.md 后重开`,
						cardPath ? "info" : "warning",
					);
				},
			});
			if (result.cancelled && ctx.hasUI) ctx.ui.notify("新建会话被取消", "warning");
		},
	});
}

// ── 内部实现 ────────────────────────────────────────

function text(s: string) {
	return { content: [{ type: "text" as const, text: s }], details: {} };
}

function isValidRoleName(role: string): boolean {
	return /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(role);
}

function readOptionalFile(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

/** 可选角色名：配置声明的 + characters/ 下扫出的，只留角色卡真实存在的 */
function listRoleNames(cwd: string, config: ProjectConfig): string[] {
	const names = new Set<string>([...declaredRoleNames(config), ...discoverRoles(cwd, CONFIG_DIR_NAME)]);
	return [...names].filter((role) => resolveRoleCard(cwd, config, role, CONFIG_DIR_NAME).path).sort();
}

function parseRoleFlag(args: string): { role?: string; error?: string } {
	const tokens = args.trim() ? args.trim().split(/\s+/) : [];
	let role: string | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--role") {
			role = tokens[++index];
			if (!role) return { error: "用法：/peer-new [--role 角色]" };
			continue;
		}
		if (token.startsWith("--role=")) {
			role = token.slice("--role=".length);
			if (!role) return { error: "用法：/peer-new [--role 角色]" };
			continue;
		}
		return { error: `不支持的参数：${token}（用法：/peer-new [--role 角色]）` };
	}
	return { role };
}

function firstLine(s: string): string {
	const line = s.split("\n")[0] ?? "";
	return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/**
 * 按首个斜杠拆「项目/名字」。
 *
 * 用首个而不是最后一个：会话名本身可能含斜杠（/peer-name 不校验字符），
 * 项目标签则在注册时已把斜杠清掉。开头就是斜杠的话当本项目处理。
 *
 * 跨项目的发现与投递在 store.ts，同领域的 AI(TAG) 声明也在那里。
 */
function splitTarget(to: string): { project?: string; name: string } {
	const q = to.trim().replace(/^@/, "");
	const slash = q.indexOf("/");
	if (slash <= 0) return { name: q };
	return { project: q.slice(0, slash), name: q.slice(slash + 1) };
}

function restoreName(ctx: ExtensionContext): string | undefined {
	let name: string | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		const e = entry as { type?: string; customType?: string; data?: { name?: string } };
		if (e.type === "custom" && e.customType === "peer-name" && e.data?.name) name = e.data.name;
	}
	return name;
}

function restoreRole(ctx: ExtensionContext): { role: string; name?: string } | undefined {
	let role: { role: string; name?: string } | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		const e = entry as { type?: string; customType?: string; data?: { role?: string; name?: string } };
		if (e.type === "custom" && e.customType === ROLE_ENTRY && e.data?.role) {
			role = { role: e.data.role, name: e.data.name };
		}
	}
	return role;
}

function livePeers(): Member[] {
	if (!store || !self) return [];
	return store.listMembers().filter((m) => m.key !== self!.key);
}

function refreshStatus(): void {
	const ctx = ctxRef;
	if (!ctx?.hasUI || !store || !self) return;
	const n = livePeers().length;
	ctx.ui.setStatus("pi-peer", n > 0 ? ctx.ui.theme.fg("dim", `⇄ ${n}`) : undefined);
}

function scheduleDrain(): void {
	if (drainTimer) return;
	drainTimer = setTimeout(() => {
		drainTimer = undefined;
		drainAndDeliver();
	}, DRAIN_DEBOUNCE_MS);
	drainTimer.unref?.();
}

function drainAndDeliver(): void {
	if (draining || !store || !self) return;
	draining = true;
	try {
		for (const msg of store.drain(self.key)) {
			deliver(msg);
		}
	} catch (err) {
		ctxRef?.ui.notify(`pi-peer 收信失败：${(err as Error).message}`, "error");
	} finally {
		draining = false;
	}
}

function deliver(msg: PeerMessage): void {
	if (!api) return;

	const body = [
		`[peer] 来自「${msg.fromName}」（${msg.fromModel ?? "未知模型"}）的消息`,
		"",
		msg.text,
		"",
		`—— 需要回复时用：peer_send(to="${msg.fromName}", text="…", replyTo="${msg.id}")`,
	];

	try {
		api?.sendMessage(
			{
				customType: CUSTOM_TYPE,
				content: body.join("\n"),
				display: true,
				details: {
					id: msg.id,
					from: msg.from,
					fromName: msg.fromName,
					fromModel: msg.fromModel,
					thread: msg.thread,
				},
			},
			// 忙时用 steer：插在当前 turn 的工具调用之后，不等整个 run 结束（followUp 要等）
			// 空闲时 steer/followUp 无差别，都走 triggerTurn 立即起一轮
			{ triggerTurn: true, deliverAs: "steer" },
		);
	} catch (err) {
		ctxRef?.ui.notify(`pi-peer 注入消息失败：${(err as Error).message}`, "error");
	}
}

function teardown(): void {
	if (heartbeatTimer) clearInterval(heartbeatTimer);
	if (pollTimer) clearInterval(pollTimer);
	if (drainTimer) clearTimeout(drainTimer);
	heartbeatTimer = pollTimer = drainTimer = undefined;

	try {
		watcher?.close();
	} catch {
		// ignore
	}
	watcher = undefined;

	if (store && self) {
		try {
			if (self.role && self.roleSlot) store.releaseRoleName(self.role, self.roleSlot, self.key);
			store.unregister(self.key);
		} catch {
			// ignore
		}
	}
	ctxRef?.ui?.setStatus?.("pi-peer", undefined);
	self = undefined;
	roleCard = undefined;
	flowDocument = undefined;
}

// 供扩展加载时声明 pi（避免 TS 未使用告警）
