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
 *   /peer-reload         当前终端新建会话，上下文清空，名字、角色、模型与思考等级沿用当前
 *   /peer-role [角色|none]  查看/中途切换本会话角色（换角色卡、应用角色默认模型）；不带参弹列表选，none 取消
 *   /peer-focus [off]    进入/退出专注模式：对其他会话隐身、不接收消息，自己发出一条消息后自动退出
 *
 * 角色会话：领取角色时把角色卡与项目流程注入 system prompt，消息按具体实例名寻址。
 * 重启会话会沿用会话里记录的角色（含中途切换与取消）。
 *
 * 工具：peer_list / peer_send / peer_inbox
 *
 * 关闭：项目内 <cwd>/.pi/peer.json 写 {"enabled": false}；或进程级环境变量 PI_PEER_OFF=1
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
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
	THINKING_LEVELS,
	type ThinkingLevel,
} from "./config.ts";
import { hasPersistedHandoff } from "./handoff-persistence.ts";
import { registerSessionControl, SESSION_TASK_ENTRY } from "./session-control.ts";
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
	type RoleControl,
} from "./store.ts";

/** 项目级配置与「生效值从哪来」都在 config.ts，这里只留用法 */

/**
 * 旧消息的类型名。新消息改用来源名当类型（会话 tree 拿类型名当标签），
 * 这里只为重启后重放旧会话条目时还认得出它们。
 */
const LEGACY_PEER_TYPE = "peer";
const HEARTBEAT_MS = 5_000;
const POLL_MS = 2_000;
const DRAIN_DEBOUNCE_MS = 50;
/** 会话条目类型：记录本会话领取的角色，重启后据此恢复 */
const ROLE_ENTRY = "peer-role";
const ROLE_DEFAULTS_ENTRY = "peer-role-defaults";
/** 会话条目类型：创建方写在新会话里的初始模型与思考等级 */
const INHERIT_ENTRY = "peer-inherit";

/** 初始默认模型与思考等级：来自角色配置，或创建方写进新会话的继承项 */
type RoleDefaults = { model?: string; thinkingLevel?: ThinkingLevel };
/** 角色选择列表里的自定义项；角色名须以字母开头，所以它与真角色不会重名 */
const CUSTOM_ROLE_ITEM = "＋ 自定义角色名…";
/** /peer-role 选择列表里的取消项，同样不会与真角色重名 */
const CLEAR_ROLE_ITEM = "－ 取消角色";

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
let handleSessionControl: ((message: PeerMessage) => Promise<void>) | undefined;
let handleControl: ((message: PeerMessage) => Promise<void>) | undefined;
let persistenceTimer: NodeJS.Timeout | undefined;
const bufferedHandoffs = new Map<
	string,
	{ handoff: NonNullable<PeerMessage["handoff"]>; woken: boolean; until: number }
>();
/**
 * 专注模式：对其他会话隐身、不接收消息；自己发出一条消息后自动退出。
 *
 * 只在进程内，重启即恢复可见——静音状态忘了退出比被打断更难发现。
 */
let focused = false;

export default function (pi: ExtensionAPI) {
	// 关掉时整个扩展不注册：工具、命令、心跳、收件箱监听都不起
	// 启用开关在工厂期判定；调度权限按实际会话 cwd 每次读取。
	const configPath = path.join(process.cwd(), CONFIG_DIR_NAME, CONFIG_FILE);
	const loaded = loadProjectConfig(configPath);
	if (process.env.PI_PEER_OFF === "1" || loaded.config.enabled === false) return;

	api = pi;
	let roleTransition: Promise<void> | undefined;
	let peerCommandCount = 0;
	const assignments = new Map<
		string,
		{
			from: string;
			finish: (ok: boolean, detail: string) => void;
		}
	>();
	const currentConfig = () =>
		loadProjectConfig(path.join(ctxRef?.cwd ?? process.cwd(), CONFIG_DIR_NAME, CONFIG_FILE)).config;
	const canAssign = (role?: string) => {
		if (!role) return false;
		const config = currentConfig();
		if (config.enabled === false) return false;
		return (config.group?.roles?.[role]?.canAssignRoles ?? config.roles?.[role]?.canAssignRoles) === true;
	};
	const sessions = registerSessionControl(pi, {
		get: () =>
			store && self && ctxRef
				? { store, member: self, ctx: ctxRef, roleChanging: !!roleTransition || peerCommandCount > 0 }
				: undefined,
		canStart: (role) => {
			if (!role) return false;
			const config = currentConfig();
			return (
				config.enabled !== false &&
				(config.group?.roles?.[role]?.canStartSessions ?? config.roles?.[role]?.canStartSessions) === true
			);
		},
		resolve: resolveTarget,
		seed: (manager, member, defaults) =>
			seedSessionEntries(manager, {
				role: member.role ?? "",
				name: member.roleSlot ?? member.name,
				...defaults,
			}),
	});
	handleSessionControl = sessions.handle;
	function peerCommand(handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>) {
		return async (args: string, ctx: ExtensionCommandContext) => {
			if (sessions.isPending()) {
				ctx.ui.notify("已有远程会话切换请求，请稍后再操作角色或会话。", "warning");
				return;
			}
			peerCommandCount++;
			try {
				await handler(args, ctx);
			} finally {
				peerCommandCount--;
			}
		};
	}
	function sendControl(target: Member, control: RoleControl): string {
		if (!store || !self) throw new Error("pi-peer 未启用");
		const msg: PeerMessage = {
			id: newMessageId(),
			from: self.key,
			fromName: self.name,
			fromModel: self.model,
			to: target.key,
			text: control.kind === "assign-role" ? `分配角色：${control.role}` : `角色分配结果：${control.detail}`,
			ts: Date.now(),
			control,
		};
		store.send(msg);
		store.logSent(self.key, msg);
		return msg.id;
	}
	handleControl = async (msg) => {
		if (!store || !self || !ctxRef || msg.to !== self.key) return;
		const control = msg.control;
		if (control?.kind === "assign-role-result") {
			const pending = assignments.get(control.requestId);
			if (pending?.from === msg.from) pending.finish(control.ok === true, control.detail);
			return;
		}
		if (control?.kind !== "assign-role") return;
		const caller = store.listMembers().find((member) => member.key === msg.from);
		// 同桶在线注册表是身份依据；同一 OS 用户可写文件，不作为进程隔离安全边界。
		if (!caller || caller.key === self.key) return;
		let detail: string;
		let ok = false;
		if (!canAssign(caller.role)) detail = "调用者当前角色没有 canAssignRoles 权限";
		else if (!Number.isFinite(control.expiresAt) || control.expiresAt <= Date.now()) detail = "角色分配请求已过期";
		else if (self.busy || !ctxRef.isIdle() || sessions.isPending() || peerCommandCount > 0)
			detail = "目标会话在忙，未切换角色";
		else if (self.role !== control.expectedRole || self.name !== control.expectedName)
			detail = "目标角色已变化，请重新查询后分配";
		else if (typeof control.role !== "string" || !isValidRoleName(control.role)) detail = "角色名非法";
		else if (!resolveRoleCard(ctxRef.cwd, loaded.config, control.role, CONFIG_DIR_NAME).path)
			detail = "目标角色卡不存在";
		else {
			try {
				roleTransition = setRole(control.role, ctxRef, { applyRoleDefaults: false });
				await roleTransition;
				ok = self?.role === control.role;
				detail = ok ? `已切换角色：${self.role}，实例名：${self.name}，当前模型：${self.model}` : "切换角色失败";
			} catch (error) {
				detail = `切换角色失败：${(error as Error).message}`;
			} finally {
				roleTransition = undefined;
			}
		}
		sendControl(caller, { kind: "assign-role-result", requestId: msg.id, ok, detail });
	};

	/** 生效配置的报告：启动提示与 /peer-config 共用，保证「报的」就是「跑的」 */
	function configReport(cwd: string, role?: string) {
		return describeConfig(loadProjectConfig(path.join(cwd, CONFIG_DIR_NAME, CONFIG_FILE)), {
			cwd,
			role,
			dirName: CONFIG_DIR_NAME,
		});
	}

	/** 角色配置声明的默认模型与思考等级；group.roles 逐字段覆盖 roles */
	function roleDefaults(role?: string): RoleDefaults {
		if (!role) return {};
		return { ...loaded.config.roles?.[role], ...loaded.config.group?.roles?.[role] };
	}

	/** 当前会话的模型与思考等级：角色不变时由它当新会话的初始值 */
	function currentDefaults(ctx: ExtensionContext): RoleDefaults {
		return {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			thinkingLevel: ctx.thinkingLevel,
		};
	}

	/** 应用默认模型与思考等级；失败保留会话设置并提示，返回是否全部生效与实际模型 */
	async function applyDefaults(
		defaults: RoleDefaults,
		ctx: ExtensionContext,
		what: string,
	): Promise<{ applied: boolean; model?: ReturnType<ExtensionContext["modelRegistry"]["find"]> }> {
		let applied = true;
		let model: ReturnType<ExtensionContext["modelRegistry"]["find"]>;
		if (defaults.model) {
			const slash = defaults.model.indexOf("/");
			try {
				model = ctx.modelRegistry.find(defaults.model.slice(0, slash), defaults.model.slice(slash + 1));
				if (!model || !(await pi.setModel(model))) {
					throw new Error("模型未注册或缺少认证");
				}
			} catch (error) {
				applied = false;
				if (ctx.hasUI)
					ctx.ui.notify(
						`pi-peer: ${what} ${defaults.model} 未应用：${(error as Error).message}，保留会话设置`,
						"warning",
					);
			}
		}
		if (applied && defaults.thinkingLevel !== undefined) pi.setThinkingLevel(defaults.thinkingLevel);
		return { applied, model };
	}

	// ── 生命周期 ────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		sessions.dispose();
		for (const pending of assignments.values()) pending.finish(false, "会话已切换，分配结果未确认");
		teardown();

		const root = process.env.PI_PEER_ROOT?.trim() || path.join(os.homedir(), CONFIG_DIR_NAME, "peers");
		store = new PeerStore(root, ctx.cwd);

		// 会话里的历史 peer 消息也要按来源渲染（重启后重放）：重放发生在 session_start
		// 之后，这里按条目补注册，否则历史气泡会落到默认样式。
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom_message") continue;
			const details = entry.details as { from?: string; fromName?: string } | undefined;
			if (details?.from && details.fromName) ensureMessageRenderer(entry.customType);
		}

		const key = newSessionKey();
		const restoredRole = restoreRole(ctx);
		// 远程新会话保留目标当前角色，优先于进程最初启动时指定的角色。
		const remoteSession = ctx.sessionManager
			.getEntries()
			.some((entry) => entry.type === "custom" && entry.customType === SESSION_TASK_ENTRY);
		const requestedRole = remoteSession ? restoredRole?.role : process.env.PI_PEER_ROLE?.trim() || restoredRole?.role;
		const role = requestedRole && isValidRoleName(requestedRole) ? requestedRole : undefined;
		const roleCardPath = role ? resolveRoleCard(ctx.cwd, loaded.config, role, CONFIG_DIR_NAME).path : undefined;
		if (requestedRole && !role && ctx.hasUI) {
			ctx.ui.notify(`pi-peer: 角色名非法，忽略 PI_PEER_ROLE=${JSON.stringify(requestedRole)}`, "warning");
		}
		if (role && !roleCardPath && ctx.hasUI) {
			ctx.ui.notify(`pi-peer: 未找到角色 ${role} 的角色卡，按普通会话启动`, "warning");
		}
		const effectiveRole = role && roleCardPath ? role : undefined;
		let activeModel = ctx.model;
		// AI(TAG): [会话初始设置] 创建方写下的继承项优先，缺的字段落回角色配置；每个角色键只初始化一次，恢复会话保留用户后续选择。
		const inherited = restoreInherited(ctx);
		const roleConfig = roleDefaults(effectiveRole);
		const defaultsKey = effectiveRole ?? "";
		if (
			(inherited || effectiveRole) &&
			!ctx.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === ROLE_DEFAULTS_ENTRY &&
						(entry.data as { role?: string } | undefined)?.role === defaultsKey,
				)
		) {
			const desired: RoleDefaults = {
				model: inherited?.model ?? roleConfig.model,
				thinkingLevel: inherited?.thinkingLevel ?? roleConfig.thinkingLevel,
			};
			const res = await applyDefaults(
				desired,
				ctx,
				inherited?.model !== undefined ? "继承的模型" : `角色 ${effectiveRole ?? ""} 默认模型`,
			);
			if (res.applied) {
				activeModel = res.model ?? activeModel;
				pi.appendEntry(ROLE_DEFAULTS_ENTRY, { role: defaultsKey });
			}
		}

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
			roleAssignmentVersion: 1,
			newSessionVersion: 1,
			newSessionEpoch: newMessageId(),
			busy: ctx.isIdle?.() === false,
			messageProtocol: 1,
			model: activeModel ? `${activeModel.provider}/${activeModel.id}` : "unknown",
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

	pi.on("message_end", (event) => {
		if (event.message.role !== "custom") return;
		const details = event.message.details as { handoff?: PeerMessage["handoff"] } | undefined;
		if (!details?.handoff) return;
		confirmHandoff(details.handoff);
	});

	pi.on("model_select", (event) => {
		if (!store || !self) return;
		self.model = `${event.model.provider}/${event.model.id}`;
		store.register(self);
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
		sessions.dispose();
		for (const pending of assignments.values()) pending.finish(false, "会话已关闭，分配结果未确认");
		teardown();
	});

	pi.on("before_agent_start", async (event) => {
		// 空闲校验后若人工恰好发起新一轮，先等角色变更完成，再构造该轮提示。
		if (roleTransition) await roleTransition;
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
		opts: {
			replyTo?: string;
			thread?: string;
			priority?: "normal" | "urgent";
			handoff?: PeerMessage["handoff"];
		} = {},
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
			priority: opts.priority ?? "normal",
			handoff: opts.handoff,
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

	/**
	 * 自己主动发出一句话就退出专注模式。
	 *
	 * 只挂在工具与 /peer-send 上：代其他扩展（工单派工与交接）的投递不算本会话开口，
	 * 在 deliverTo 里解除会让系统代投意外把自己叫醒。
	 */
	function exitFocusIfNeeded(): void {
		if (focused) setFocus(false, "已发出消息");
	}

	// ── TUI 渲染：把注入的消息画成对话气泡 ────────────

	pi.registerMessageRenderer(LEGACY_PEER_TYPE, renderPeerMessage);

	// ── 工具 ────────────────────────────────────────

	pi.registerTool({
		name: "peer_list",
		label: "Peer List",
		description:
			'列出同目录的 pi 会话（含自己，自己在第一行）：名称、模型、会话 id、状态。scope="all" 连其他项目的会话一起列。',
		promptSnippet: "列出同目录 pi 会话（含自己）",
		promptGuidelines: [
			"用 peer_list 查看当前文件夹下的 pi 会话（第一行是自己）；用 peer_send 给其他会话发消息（对方会被唤醒并看到正文）。",
			'peer_list 传 scope="all" 看其他项目的会话；发消息时写「项目/名字」当目标。',
			"收到 [peer …] 消息后只在确实需要回答或行动时才回复；对方只是通报进度或结论时不要回确认，避免两个会话互相刷屏。",
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
			const scan = scopeAll ? store.listAllMembers({ includeStale: true, selfKey: self.key }) : undefined;
			const ownAll = scan
				? scan.filter((s) => s.bucket === store!.dir)
				: store.listScoped({ includeStale, selfKey: self.key });
			const me = ownAll.find((s) => s.member.key === self!.key);
			const own = ownAll.filter((s) => s.member.key !== self!.key);
			const foreign = (scan ?? []).filter((s) => s.bucket !== store!.dir && s.member.key !== self!.key);

			// 「在忙」只是提示：手动发消息照样能发，会自动插到对方当前这轮之后
			const render = (m: Member, live: boolean, label: string, isSelf = false) => {
				const age = Math.round((Date.now() - m.lastSeen) / 1000);
				const tag = isSelf
					? m.hidden
						? "（我·专注中，其他会话看不到）"
						: m.role
							? `（我，角色：${m.role}）`
							: "（我）"
					: m.role
						? `（角色：${m.role}）`
						: "";
				return (
					`- ${label}${tag}｜${m.model}｜${live ? (isBusy(m) ? "在线·在忙" : "在线·空闲") : "离线"}` +
					`｜id=${m.key}｜pid=${m.pid}｜${age}s 前心跳`
				);
			};

			// 自己排第一：要跟别人说话，先得知道自己在这套寻址里叫什么
			const lines = [
				...(me ? [render(me.member, true, me.member.name, true)] : []),
				...own.map((s) => render(s.member, s.live, s.member.name)),
				...foreign.map((s) => render(s.member, s.live, `${s.project}/${s.member.name}`)),
			];
			if (own.length === 0 && foreign.length === 0) {
				lines.push(
					"（同目录暂无其他会话：新终端 cd 到同目录再开一个 pi，或用 /peer-new 新建，可带角色；当前会话用 /peer-role 领角色）",
				);
			}
			if (!scopeAll) {
				const others = store.listAllMembers().filter((s) => s.bucket !== store!.dir);
				if (others.length > 0) {
					lines.push(`（另有 ${others.length} 个其他项目的在线会话，peer_list 传 scope="all" 看）`);
				}
			}
			return text(`同目录会话（${(me ? 1 : 0) + own.length + foreign.length}）：\n${lines.join("\n")}`);
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
			priority: Type.Optional(Type.String({ description: "normal（默认，不打断）或 urgent（显式 steer 打断）" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!store || !self) return text("pi-peer 未启用（未注册成功）");

			if (params.priority !== undefined && params.priority !== "normal" && params.priority !== "urgent")
				throw new Error("priority 只接受 normal 或 urgent");
			const priority = params.priority ?? "normal";
			const res = resolveTarget(params.to);
			if (!res.ok) return text(resolveHint(params.to, res));
			if (priority === "normal" && res.member.messageProtocol !== 1)
				throw new Error("目标版本不支持普通消息不打断，请先重载目标扩展");

			const msg = deliverTo(res, params.text, { replyTo: params.replyTo, thread: params.thread, priority });
			if (!msg) return text("pi-peer 未启用（未注册成功）");
			exitFocusIfNeeded();
			ctx?.ui.notify(`→ ${res.member.name}: ${firstLine(msg.text)}`, "info");

			return text(
				`已写入 ${res.member.name} 的收件箱｜id=${msg.id}｜${priority === "urgent" ? "urgent / steer，允许打断" : "normal / followUp，不打断当前轮"}；写入收件箱不代表已处理`,
			);
		},
	});

	pi.registerTool({
		name: "peer_assign_role",
		label: "Peer Assign Role",
		description:
			"给同项目其他空闲在线 pi 会话设定角色；调用者当前角色须配置 canAssignRoles: true。等待目标确认，不新建进程，也不清空目标上下文，不改目标的模型与思考强度。",
		parameters: Type.Object({
			to: Type.String({ description: "同项目目标会话的名称、id 或 pid，先用 peer_list 查看" }),
			role: Type.String({ description: "要分配的角色名，须有有效角色卡" }),
		}),
		async execute(_id, params, signal) {
			if (!store || !self) throw new Error("pi-peer 未启用");
			if (!canAssign(self.role)) throw new Error("当前角色没有 canAssignRoles 权限");
			if (
				!isValidRoleName(params.role) ||
				!resolveRoleCard(self.cwd, loaded.config, params.role, CONFIG_DIR_NAME).path
			) {
				throw new Error("角色名非法或角色卡不存在");
			}
			const target = resolveTarget(params.to);
			if (!target.ok) throw new Error(resolveHint(params.to, target));
			if (target.bucket !== store.dir || target.member.key === self.key)
				throw new Error("只能给同项目的其他会话分配角色");
			if (target.member.roleAssignmentVersion !== 1) throw new Error("目标版本不支持角色分配，请先重载目标扩展");
			if (isBusy(target.member)) throw new Error("目标会话在忙，未发送角色分配请求");
			if (signal?.aborted) throw new Error("已取消，未发送请求");
			return new Promise<ReturnType<typeof text>>((resolve, reject) => {
				const requestId = sendControl(target.member, {
					kind: "assign-role",
					role: params.role,
					expiresAt: Date.now() + 8_000,
					expectedRole: target.member.role,
					expectedName: target.member.name,
				});
				const finish = (ok: boolean, detail: string) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", abort);
					assignments.delete(requestId);
					if (ok) resolve(text(detail));
					else reject(new Error(detail));
				};
				const abort = () => finish(false, "等待已取消，目标可能已执行；请用 peer_list 核实，勿盲目重试");
				const timer = setTimeout(() => finish(false, "角色分配确认超时，结果未知；请用 peer_list 核实"), 10_000);
				assignments.set(requestId, { from: target.member.key, finish });
				signal?.addEventListener("abort", abort, { once: true });
			});
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
				return `[${clockTime(m.ts)}] ${m.fromName}（${ago}s 前）id=${m.id}\n  ${m.text.replace(/\n/g, "\n  ")}`;
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

	pi.events.on("peer:handoff-support", (data) => {
		if (!store || !self) return;
		const request = data as { version?: number } | undefined;
		self.handoffConsumer = request?.version === 1 ? 1 : undefined;
		store.register(self);
	});

	pi.events.on(WAKE_CHANNEL, (data) => {
		const request = data as
			| {
					id?: string;
					targets?: string[];
					text?: string;
					requireIdle?: boolean;
					priority?: "normal" | "urgent";
					handoff?: PeerMessage["handoff"];
			  }
			| undefined;
		if (!request?.id) return;
		const targets = request.targets ?? [];
		const reply = (ok: boolean, detail: string, to?: string) =>
			pi.events.emit(WAKE_RESULT_CHANNEL, { id: request.id, ok, detail, to });

		if (!store || !self) return reply(false, "该会话没启用 pi-peer");
		const skipped: string[] = [];
		for (const target of targets) {
			const resolved =
				request.handoff && target === self.name
					? { ok: true as const, member: self, bucket: store.dir, live: true }
					: request.requireIdle
						? store.resolveIdle(target, self.key)
						: resolveTarget(target);
			if (!resolved.ok) {
				// 在忙与离线要分开报：前者等一等就好，后者得换人
				if (resolved.reason === "busy") skipped.push(`${resolved.candidates[0]?.name ?? target} 在忙`);
				continue;
			}
			if (resolved.member.key === self.key && !request.handoff) continue;
			if (request.handoff && path.resolve(resolved.member.cwd) !== path.resolve(self.cwd)) {
				skipped.push(`${resolved.member.name} 属于其他项目，拒绝工单交接`);
				continue;
			}
			if (
				request.handoff &&
				(isBusy(resolved.member) || resolved.member.messageProtocol !== 1 || resolved.member.handoffConsumer !== 1)
			) {
				skipped.push(`${resolved.member.name} 在忙或不支持交接协议`);
				continue;
			}
			const message = deliverTo(resolved, request.text ?? "", {
				priority: request.priority ?? "normal",
				handoff: request.handoff,
			});
			if (message) return reply(true, "已写入收件箱，尚未确认注入", resolved.member.name);
		}
		if (skipped.length) return reply(false, skipped.join("、"));
		return reply(false, targets.length ? `候选都不在线：${targets.join("、")}` : "没有候选");
	});

	// ── 命令 ────────────────────────────────────────

	pi.registerCommand("peers", {
		description: "列出同目录 pi 会话（含自己；/peers all 连其他项目一起列）",
		handler: async (args, ctx) => {
			if (!store || !self) {
				ctx.ui.notify("pi-peer 未启用", "warning");
				return;
			}
			const scopeAll = args.trim() === "all";
			const selfKey = self.key;
			const ownAll = store.listScoped();
			const me = ownAll.find((s) => s.member.key === selfKey);
			const own = ownAll.filter((s) => s.member.key !== selfKey);
			const foreignAll = store.listAllMembers().filter((s) => s.bucket !== store!.dir && s.member.key !== self!.key);
			const row = (member: Member, label: string, isSelf = false) =>
				`${label}${
					isSelf
						? member.role
							? `（我，角色：${member.role}）`
							: "（我）"
						: member.role
							? `（角色：${member.role}）`
							: ""
				} · ${member.model} · id=${member.key}`;
			const lines = [
				...(me ? [row(me.member, me.member.name, true)] : []),
				...own.map((s) => row(s.member, s.member.name)),
				...(scopeAll ? foreignAll.map((s) => row(s.member, `${s.project}/${s.member.name}`)) : []),
			];
			if (own.length === 0 && foreignAll.length === 0) {
				lines.push(
					"（同目录暂无其他会话：新终端 cd 到同目录再开一个 pi，或用 /peer-new 新建，可带角色；当前会话用 /peer-role 领角色）",
				);
			}
			if (!scopeAll && foreignAll.length > 0) {
				lines.push(`（另有 ${foreignAll.length} 个其他项目的在线会话，/peers all 看）`);
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
		description: "查看或中途切换本会话角色（不带参弹列表选；用法：/peer-role [角色|none]）",
		handler: peerCommand(async (args, ctx) => {
			if (!store || !self) {
				ctx.ui.notify("pi-peer 未启用", "warning");
				return;
			}
			const me = self;
			const arg = args.trim();
			if (!arg) {
				ctx.ui.notify(self.role ? `当前角色：${self.role}，实例名：${self.name}` : "当前会话未加载角色", "info");
				const names = listRoleNames(ctx.cwd, loaded.config);
				if (names.length === 0) return;
				if (!ctx.hasUI) {
					ctx.ui.notify(`可用角色：${names.join("、")}`, "info");
					return;
				}
				const labelOf = (n: string) => (n === me.role ? `${n}（当前）` : n);
				const picked = await ctx.ui.select("切换本会话角色？", [...names.map(labelOf), CLEAR_ROLE_ITEM]);
				if (!picked) return;
				if (picked === CLEAR_ROLE_ITEM) {
					clearRole(ctx);
					return;
				}
				const role = names.find((n) => labelOf(n) === picked);
				if (role) await setRole(role, ctx);
				return;
			}
			if (arg === "none") {
				clearRole(ctx);
				return;
			}
			await setRole(arg, ctx);
		}),
	});

	/** 中途领取角色：换角色卡、认领实例名槽位，按需套用角色默认设置；记入会话供重启恢复 */
	async function setRole(
		role: string,
		ctx: ExtensionContext,
		options: { applyRoleDefaults?: boolean } = {},
	): Promise<void> {
		if (!store || !self) return;
		if (!isValidRoleName(role)) {
			ctx.ui.notify("角色名只能包含字母、数字、下划线和连字符，且必须以字母开头", "warning");
			return;
		}
		if (self.role === role) {
			ctx.ui.notify(`已是角色 ${role}（实例名：${self.name}）`, "info");
			return;
		}
		const cardPath = resolveRoleCard(ctx.cwd, loaded.config, role, CONFIG_DIR_NAME).path;
		if (!cardPath) {
			ctx.ui.notify(
				`找不到角色 ${role} 的角色卡：在 ${CONFIG_DIR_NAME}/characters/<角色>.md 放一份，或在 ${CONFIG_FILE} 的 roles 里声明`,
				"warning",
			);
			return;
		}
		const activeStore = store;
		const activeMember = self;
		const oldRole = self.role;
		const oldSlot = self.roleSlot;
		let slot: string;
		try {
			slot = store.claimRoleName(role, self.key, process.pid);
		} catch (error) {
			ctx.ui.notify((error as Error).message, "warning");
			return;
		}
		// 远程分配角色只换身份：调度者不该顺手改目标的模型与思考强度
		const res =
			options.applyRoleDefaults === false
				? undefined
				: await applyDefaults(roleDefaults(role), ctx, `角色 ${role} 默认模型`);
		if (store !== activeStore || self !== activeMember) {
			activeStore.releaseRoleName(role, slot, activeMember.key);
			throw new Error("目标会话已切换，角色变更未应用");
		}
		if (oldRole && oldSlot) store.releaseRoleName(oldRole, oldSlot, self.key);
		// 不套用时同样要记：这条是「该角色的初始设置已处理」的标记，缺了它下次加载会补套用角色默认模型
		if (!res || res.applied) pi.appendEntry(ROLE_DEFAULTS_ENTRY, { role });
		roleCard = readOptionalFile(cardPath);
		self.role = role;
		self.roleSlot = slot;
		self.name = slot;
		if (res?.model) self.model = `${res.model.provider}/${res.model.id}`;
		pi.appendEntry(ROLE_ENTRY, { role, name: slot });
		store.register(self);
		pi.events.emit("peer:identity-changed", { name: self.name, role: self.role });
		refreshStatus();
		ctx.ui.notify(`已切换角色：${role}，实例名：${slot}`, "info");
	}

	/** 取消角色：释放槽位、摘掉角色卡，名字退回手动名或会话名 */
	function clearRole(ctx: ExtensionContext): void {
		if (!store || !self) return;
		if (!self.role) {
			ctx.ui.notify("当前会话未加载角色", "info");
			return;
		}
		if (self.roleSlot) store.releaseRoleName(self.role, self.roleSlot, self.key);
		roleCard = undefined;
		const fallback =
			restoreName(ctx) ?? pi.getSessionName() ?? `${path.basename(ctx.cwd) || "session"}-${process.pid}`;
		self.role = undefined;
		self.roleSlot = undefined;
		self.name = fallback;
		// role 记空串而不是删条目：restoreRole 取最后一条，空串表示「明确取消过」
		pi.appendEntry(ROLE_ENTRY, { role: "", name: fallback });
		store.register(self);
		pi.events.emit("peer:identity-changed", { name: self.name });
		refreshStatus();
		ctx.ui.notify(`已取消角色，名称回到 ${fallback}`, "info");
	}

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
			const urgent = args.trim().startsWith("--urgent ");
			const m = /^(\S+)\s+([\s\S]+)$/.exec(urgent ? args.trim().slice("--urgent ".length) : args.trim());
			if (!m) {
				ctx.ui.notify("用法：/peer-send <目标|项目/目标> <正文>", "warning");
				return;
			}
			const res = resolveTarget(m[1]);
			if (!res.ok) {
				ctx.ui.notify(resolveHint(m[1], res), "warning");
				return;
			}
			if (!urgent && res.member.messageProtocol !== 1) {
				ctx.ui.notify("目标版本不支持普通消息不打断，请先重载目标扩展", "warning");
				return;
			}
			deliverTo(res, m[2], { priority: urgent ? "urgent" : "normal" });
			exitFocusIfNeeded();
			ctx.ui.notify(
				`→ ${res.member.name}（已写入收件箱，${urgent ? "urgent / steer" : "normal / followUp"}）`,
				"info",
			);
		},
	});

	pi.registerCommand("peer-focus", {
		description: "进入/退出专注模式：进入后对其他会话隐身、不接收消息，自己发出一条消息后自动退出（off 手动退出）",
		handler: async (args, ctx) => {
			if (!store || !self) {
				ctx.ui.notify("pi-peer 未启用", "warning");
				return;
			}
			const want = args.trim().toLowerCase();
			if (want && want !== "on" && want !== "off") {
				ctx.ui.notify("用法：/peer-focus [on|off]", "warning");
				return;
			}
			const on = want !== "off";
			if (on === focused) {
				ctx.ui.notify(on ? "已在专注模式；发出一条消息或 /peer-focus off 退出" : "当前不在专注模式", "info");
				return;
			}
			setFocus(on);
		},
	});

	pi.registerCommand("peer-new", {
		description: "新建会话并领取角色（用法：/peer-new [--role 角色]）",
		handler: peerCommand(async (args, ctx) => {
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
			// 同名角色再开就保持现状；换角色才按新角色的配置走。
			const defaults = role === self?.role ? currentDefaults(ctx) : {};
			const result = await ctx.newSession({
				setup: async (sessionManager) => {
					seedSessionEntries(sessionManager, { role: cardPath ? role : undefined, ...defaults });
				},
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
		}),
	});

	pi.registerCommand("peer-reload", {
		description: "新建会话并继承当前名字、角色与模型（用法：/peer-reload）",
		handler: peerCommand(async (args, ctx) => {
			if (!store || !self) {
				ctx.ui.notify("pi-peer 未启用", "warning");
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("用法：/peer-reload（不带参数）", "warning");
				return;
			}
			const role = self.role;
			const cardPath = role ? resolveRoleCard(ctx.cwd, loaded.config, role, CONFIG_DIR_NAME).path : undefined;
			// 旧会话只是不再活动，日志里留作父会话，便于回头找上下文
			const parent = ctx.sessionManager.getSessionFile();
			// 替换一开始旧 ctx 就失效，setup 里不能再读它：要继承的值先取出来
			const seed = { role: cardPath ? role : undefined, name: self?.name, ...currentDefaults(ctx) };
			const result = await ctx.newSession({
				parentSession: parent && fs.existsSync(parent) ? parent : undefined,
				setup: async (sessionManager) => {
					seedSessionEntries(sessionManager, seed);
				},
				withSession: async (newCtx) => {
					if (!newCtx.hasUI) return;
					const bare = role !== undefined && !cardPath;
					newCtx.ui.notify(
						bare
							? `找不到角色 ${role} 的角色卡，已按普通会话新建，名字、模型与思考等级沿用当前`
							: `已新建会话${role ? `（角色：${role}）` : ""}，名字、模型与思考等级沿用当前`,
						bare ? "warning" : "info",
					);
				},
			});
			if (result.cancelled && ctx.hasUI) ctx.ui.notify("新建会话被取消", "warning");
		}),
	});
}

// ── 内部实现 ────────────────────────────────────────

function text(s: string) {
	return { content: [{ type: "text" as const, text: s }], details: {} };
}

/**
 * 本地时间 24 小时制 HH:MM:SS。
 * 不用 toLocaleTimeString()：它跟系统 locale 走，en-US 下会输出 8:40:30 PM，
 * 而各会话报文里的时刻一律 24 小时制，同一时刻两种写法会让人工对照串行。
 */
function clockTime(ts: number): string {
	const d = new Date(ts);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
		// 空串是 /peer-role none 的取消标记：取最后一条字符串值，让取消覆盖之前的领取
		if (e.type === "custom" && e.customType === ROLE_ENTRY && typeof e.data?.role === "string") {
			role = { role: e.data.role, name: e.data.name };
		}
	}
	return role;
}

/** 创建方写进新会话的初始默认值；没有它就不按继承初始化 */
function restoreInherited(ctx: ExtensionContext): RoleDefaults | undefined {
	let inherited: RoleDefaults | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		const e = entry as { type?: string; customType?: string; data?: { model?: unknown; thinkingLevel?: unknown } };
		if (e.type !== "custom" || e.customType !== INHERIT_ENTRY) continue;
		inherited = {
			model: typeof e.data?.model === "string" && e.data.model !== "unknown" ? e.data.model : undefined,
			thinkingLevel: THINKING_LEVELS.includes(e.data?.thinkingLevel as ThinkingLevel)
				? (e.data?.thinkingLevel as ThinkingLevel)
				: undefined,
		};
	}
	return inherited;
}

/** 新会话的初始身份与默认值：由创建方决定，新会话只按条目应用，不重新推导 */
export function seedSessionEntries(
	manager: { appendCustomEntry(customType: string, data?: unknown): void },
	seed: { role?: string; name?: string } & RoleDefaults,
): void {
	if (seed.role !== undefined) {
		const entry: { role: string; name?: string } = { role: seed.role };
		if (seed.name !== undefined) entry.name = seed.name;
		manager.appendCustomEntry(ROLE_ENTRY, entry);
	}
	if (seed.name !== undefined) manager.appendCustomEntry("peer-name", { name: seed.name });
	const defaults: RoleDefaults = {};
	if (seed.model !== undefined) defaults.model = seed.model;
	if (seed.thinkingLevel !== undefined) defaults.thinkingLevel = seed.thinkingLevel;
	if (defaults.model !== undefined || defaults.thinkingLevel !== undefined)
		manager.appendCustomEntry(INHERIT_ENTRY, defaults);
}

function livePeers(): Member[] {
	if (!store || !self) return [];
	return store.listMembers().filter((m) => m.key !== self!.key);
}

function refreshStatus(): void {
	const ctx = ctxRef;
	if (!ctx?.hasUI || !store || !self) return;
	const n = livePeers().length;
	const label = focused ? (n > 0 ? `◌ 专注 · ${n}` : "◌ 专注") : n > 0 ? `⇄ ${n}` : undefined;
	ctx.ui.setStatus("pi-peer", label ? ctx.ui.theme.fg("dim", label) : undefined);
}

/**
 * 进入/退出专注模式。
 *
 * 进入时把自己标成 hidden（别的会话在列表、解析、投递里都看不到）并停掉收件箱投递；
 * 退出时恢复可见并把专注期间积压的消息投进来。
 */
function setFocus(on: boolean, reason?: string): void {
	if (!store || !self || focused === on) return;
	focused = on;
	self.hidden = on ? true : undefined;
	try {
		store.register(self);
	} catch {
		// 写不进去不影响本地状态，下次心跳会重写
	}
	refreshStatus();
	const ui = ctxRef?.hasUI ? ctxRef.ui : undefined;
	if (on) {
		ui?.notify(
			"已进入专注模式：其他会话看不到这个会话，也不再收到消息；自己发出一条消息后自动退出（/peer-focus off 手动退出）",
			"info",
		);
		return;
	}
	ui?.notify(reason ? `已退出专注模式（${reason}）` : "已退出专注模式", "info");
	scheduleDrain();
}

function scheduleDrain(): void {
	if (drainTimer) return;
	drainTimer = setTimeout(() => {
		drainTimer = undefined;
		void drainAndDeliver();
	}, DRAIN_DEBOUNCE_MS);
	drainTimer.unref?.();
}

async function drainAndDeliver(): Promise<void> {
	// 专注期间不取收件箱：消息留在 pending，退出后再投；也不唤醒本轮
	if (focused || draining || !store || !self) return;
	draining = true;
	const activeStore = store;
	const activeMember = self;
	try {
		for (const msg of activeStore.drain(activeMember.key)) {
			if (store !== activeStore || self !== activeMember) break;
			if (msg.control) {
				await handleSessionControl?.(msg);
				await handleControl?.(msg);
			} else if (msg.handoff) {
				const persisted = diskHasHandoff(msg.handoff.id);
				if (self.busy || ctxRef?.isIdle?.() === false) continue;
				api?.events.emit("work-orders:consume-handoff", {
					...msg.handoff,
					alreadyPersisted: persisted === true,
					identities: [self.name, self.role].filter(Boolean),
					deliver: () => {
						if (persisted) confirmHandoff(msg.handoff!);
						else if (!deliver(msg)) throw new Error("会话注入失败");
					},
				});
			} else deliver(msg);
		}
	} catch (err) {
		ctxRef?.ui.notify(`pi-peer 收信失败：${(err as Error).message}`, "error");
	} finally {
		draining = false;
	}
}

function handoffBranch() {
	const manager = ctxRef?.sessionManager;
	return manager?.getBranch?.() ?? manager?.getEntries() ?? [];
}
function diskHasHandoff(id: string): boolean {
	return hasPersistedHandoff(ctxRef?.sessionManager.getSessionFile(), handoffBranch(), id);
}
function memoryHasHandoff(id: string): boolean {
	return handoffBranch().some(
		(entry) =>
			entry.type === "custom_message" &&
			(entry.details as { handoff?: { id?: string } } | undefined)?.handoff?.id === id,
	);
}
function wakeHandoff(): () => void {
	const receiver = api;
	const key = self?.key;
	return () =>
		queueMicrotask(() => {
			if (!key || self?.key !== key || focused) return;
			try {
				receiver?.sendUserMessage("请处理刚收到的工单交接，先用 orders_show 核实当前状态再行动。", {
					deliverAs: "followUp",
				});
			} catch {
				ctxRef?.ui.notify("工单交接唤醒失败，请核实通知记录并人工处理。", "warning");
			}
		});
}
function schedulePersistenceCheck(): void {
	if (persistenceTimer || !bufferedHandoffs.size) return;
	persistenceTimer = setTimeout(() => {
		persistenceTimer = undefined;
		for (const [id, pending] of bufferedHandoffs) {
			if (Date.now() >= pending.until) {
				bufferedHandoffs.delete(id);
				continue;
			}
			if (diskHasHandoff(id)) {
				try {
					api?.events.emit("work-orders:handoff-injected", {
						...pending.handoff,
						wake: pending.woken ? undefined : wakeHandoff(),
					});
					bufferedHandoffs.delete(id);
				} catch {
					/* 确认端不可用时保留等待，由有效期和耐久租约限制重试。 */
				}
			} else if (!pending.woken && memoryHasHandoff(id)) {
				pending.woken = true;
				wakeHandoff()();
			}
		}
		schedulePersistenceCheck();
	}, 100);
	persistenceTimer.unref?.();
}
function confirmHandoff(handoff: NonNullable<PeerMessage["handoff"]>): void {
	const previous = bufferedHandoffs.get(handoff.id);
	if (diskHasHandoff(handoff.id)) {
		bufferedHandoffs.delete(handoff.id);
		api?.events.emit("work-orders:handoff-injected", {
			...handoff,
			wake: previous?.woken ? undefined : wakeHandoff(),
		});
		return;
	}
	if (!ctxRef?.sessionManager.getSessionFile()) return;
	// 新空白会话的 custom entry 可能只在内存；首次用户消息落盘后才能补确认。
	const pending = { handoff, woken: previous?.woken ?? false, until: Date.now() + 30_000 };
	bufferedHandoffs.set(handoff.id, pending);
	if (!pending.woken && memoryHasHandoff(handoff.id)) {
		pending.woken = true;
		wakeHandoff()();
	}
	schedulePersistenceCheck();
}

/** 按来源名注册渲染器，使会话重放也能识别消息来源。 */
function ensureMessageRenderer(source: string): void {
	api?.registerMessageRenderer(source, renderPeerMessage);
}

const renderPeerMessage: MessageRenderer = (message, options, theme) => {
	const details = (message.details ?? {}) as { fromName?: string; fromModel?: string };
	const head =
		theme.fg("accent", `⇄ ${details.fromName ?? "peer"}`) + theme.fg("dim", ` · ${details.fromModel ?? "?"}`);
	const content =
		typeof message.content === "string"
			? message.content
			: (message.content ?? [])
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
	// 剥掉正文首行的来源标记（气泡头已经写了）；新旧两代的标记行都认
	const body = content.replace(/^\[peer[^\n]*\n\n?/, "");
	return new Text(`${head}\n${body}`, options.outputPad, 0);
};

function deliver(msg: PeerMessage): boolean {
	if (!api) return false;

	// 首行给模型认来源（custom 消息转成 LLM 输入时是普通 user 文本，没有额外标记）；
	// 长度压到一行，免得 session tree 里正文被元信息挤掉。
	const body = [
		`[peer ${msg.fromName}]`,
		"",
		msg.text,
		"",
		`—— ${msg.fromName}（${msg.fromModel ?? "未知模型"}）是另一个 pi 会话；需要回复时用：peer_send(to="${msg.fromName}", text="…", replyTo="${msg.id}")`,
	];

	ensureMessageRenderer(msg.fromName);
	try {
		api?.sendMessage(
			{
				customType: msg.fromName,
				content: body.join("\n"),
				display: true,
				details: {
					id: msg.id,
					from: msg.from,
					fromName: msg.fromName,
					fromModel: msg.fromModel,
					thread: msg.thread,
					handoff: msg.handoff,
				},
			},
			// 耐久交接以当前分支 entry 的真实落盘记录确认；空白会话须先触发首次用户消息。
			{ triggerTurn: !msg.handoff, deliverAs: msg.priority === "urgent" ? "steer" : "followUp" },
		);
		if (msg.handoff) confirmHandoff(msg.handoff);
		return true;
	} catch (err) {
		ctxRef?.ui.notify(`pi-peer 注入消息失败：${(err as Error).message}`, "error");
		return false;
	}
}

function teardown(): void {
	if (persistenceTimer) clearTimeout(persistenceTimer);
	persistenceTimer = undefined;
	bufferedHandoffs.clear();
	focused = false;
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
