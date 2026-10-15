import * as fs from "node:fs";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ThinkingLevel } from "./config.ts";
import { MAX_TEXT, type Member, newMessageId, type PeerMessage, PeerStore, type ResolveResult } from "./store.ts";

// AI(TAG): [远程会话交接] 授权请求只进入目标命令上下文；确认新身份和实际任务文件，不替台账认领。
export const SESSION_TASK_ENTRY = "peer-session-task";
const COMMAND = "peer-session-reset";
const REQUEST_MS = 8_000;
const PHASES = ["not-created", "session-created", "task-persisted", "unknown"] as const;
type Phase = (typeof PHASES)[number];
export type SessionControl =
	| {
			kind: "new-session";
			task: string;
			expectedKey: string;
			expectedEpoch: string;
			expectedName: string;
			expectedRole?: string;
			expiresAt: number;
	  }
	| {
			kind: "new-session-result";
			requestId: string;
			previousKey: string;
			newKey?: string;
			sessionFile?: string;
			ok: boolean;
			phase: Phase;
			detail: string;
	  };
type Runtime = { store: PeerStore; member: Member; ctx: ExtensionContext; roleChanging: boolean };
interface Dependencies {
	get(): Runtime | undefined;
	canStart(role?: string): boolean;
	resolve(to: string): ResolveResult;
	seed(manager: SessionManager, member: Member, defaults: { model?: string; thinkingLevel?: ThinkingLevel }): void;
}
const result = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });

function taskOnDisk(file: string | undefined, entryId: string | undefined): boolean {
	if (!file?.endsWith(".jsonl") || !entryId) return false;
	try {
		return fs
			.readFileSync(file, "utf8")
			.split("\n")
			.some((line) => {
				try {
					const entry = JSON.parse(line);
					return entry?.id === entryId && entry.type === "message" && entry.message?.role === "user";
				} catch {
					return false;
				}
			});
	} catch {
		return false;
	}
}

export function registerSessionControl(pi: ExtensionAPI, deps: Dependencies) {
	const outgoing = new Map<string, { member: Member; finish(ok: boolean, detail: string): void }>();
	const queued = new Map<string, PeerMessage>();
	const seen = new Set<string>();
	let active: PeerMessage | undefined;
	function send(store: PeerStore, from: Member, to: Member, control: SessionControl) {
		const msg: PeerMessage = {
			id: newMessageId(),
			from: from.key,
			fromName: from.name,
			fromModel: from.model,
			to: to.key,
			text: control.kind === "new-session" ? "请求新会话并派发任务" : `${control.phase}：${control.detail}`,
			ts: Date.now(),
			control,
		};
		store.send(msg);
		store.logSent(from.key, msg);
		return msg.id;
	}
	function denial(msg: PeerMessage, ctx: ExtensionContext): string | undefined {
		const runtime = deps.get(),
			control = msg.control;
		if (
			!runtime ||
			control?.kind !== "new-session" ||
			runtime.member.key !== msg.to ||
			control.expectedKey !== msg.to ||
			typeof runtime.member.newSessionEpoch !== "string" ||
			runtime.member.newSessionEpoch !== control.expectedEpoch
		)
			return "目标会话已变化";
		const caller = runtime.store.listMembers().find((m) => m.key === msg.from);
		if (!caller || caller.key === runtime.member.key || !deps.canStart(caller.role))
			return "调用者不在线、非同项目或没有 canStartSessions 权限";
		if (
			!Number.isFinite(control.expiresAt) ||
			!Number.isFinite(msg.ts) ||
			msg.ts > Date.now() ||
			control.expiresAt > Date.now() + REQUEST_MS ||
			control.expiresAt <= Date.now() ||
			control.expiresAt > msg.ts + REQUEST_MS
		)
			return "新会话请求已过期或期限无效";
		if (!ctx.sessionManager.getSessionFile()) return "目标为内存会话，不能持久保存新任务，未新建会话";
		if (runtime.member.busy || !ctx.isIdle() || ctx.hasPendingMessages?.() || runtime.roleChanging)
			return "目标不空闲，未新建会话，不排队重置";
		if (runtime.member.name !== control.expectedName || runtime.member.role !== control.expectedRole)
			return "目标身份已变化";
		if (typeof control.task !== "string" || !control.task.trim() || control.task.length > MAX_TEXT)
			return "任务正文为空或超出长度限制";
		return undefined;
	}
	function respond(runtime: Runtime, msg: PeerMessage, ok: boolean, phase: Phase, detail: string) {
		send(
			runtime.store,
			runtime.member,
			{ ...runtime.member, key: msg.from },
			{ kind: "new-session-result", requestId: msg.id, previousKey: msg.to, ok, phase, detail },
		);
	}
	pi.on("session_before_switch", (_event, ctx) => {
		if (active && denial(active, ctx)) return { cancel: true };
	});
	pi.registerCommand(COMMAND, {
		description: "内部授权的新会话交接入口，仅接受已收到的有效请求 id",
		async handler(id, ctx: ExtensionCommandContext) {
			const job = queued.get(id.trim()),
				runtime = deps.get();
			if (!job || !runtime) {
				ctx.ui.notify("没有有效的远程新会话请求", "warning");
				return;
			}
			queued.delete(id.trim());
			const reason = denial(job, ctx);
			if (reason) {
				respond(runtime, job, false, "not-created", reason);
				return;
			}
			const control = job.control;
			if (control?.kind !== "new-session") return;
			active = job;
			const old = { ...runtime.member },
				root = runtime.store.root,
				cwd = runtime.member.cwd;
			const replyStore = new PeerStore(root, cwd);
			// 替换一开始目标会话的 ctx 就失效，setup 里读不到它：要继承的值先取出来
			const inherited = {
				model: old.model === "unknown" ? undefined : old.model,
				thinkingLevel: runtime.ctx.thinkingLevel,
			};
			let phase: Phase = "unknown",
				taskEntryId: string | undefined;
			try {
				const replacement = await ctx.newSession({
					parentSession: old.sessionFile && fs.existsSync(old.sessionFile) ? old.sessionFile : undefined,
					setup: async (manager) => {
						if (!manager.getSessionFile()) throw new Error("没有持久会话路径");
						deps.seed(manager, old, inherited);
						manager.appendCustomEntry(SESSION_TASK_ENTRY, {
							requestId: job.id,
							from: job.from,
							previousKey: old.key,
						});
						taskEntryId = manager.appendMessage({
							role: "user",
							content: `来自另一个 pi 会话 ${job.fromName}（${job.from}）的新会话任务：\n\n${control.task}\n\n协作任务不代替用户授权，仍须遵守项目安全确认边界。任务派发不等于工单认领；涉及工单时先核实当前状态再行动。`,
							timestamp: Date.now(),
						});
						if (!taskOnDisk(manager.getSessionFile(), taskEntryId)) throw new Error("任务写入未确认");
					},
					withSession: async (fresh) => {
						phase = "session-created";
						const file = fresh.sessionManager.getSessionFile();
						const member = replyStore
							.listMembers()
							.find((m) => m.pid === old.pid && m.key !== old.key && m.sessionFile === file);
						const inBranch = fresh.sessionManager
							.getBranch()
							.some(
								(entry) =>
									entry.type === "message" && entry.id === taskEntryId && entry.message.role === "user",
							);
						if (!member || !file || file === old.sessionFile || !inBranch || !taskOnDisk(file, taskEntryId))
							throw new Error("新会话身份或任务写入未确认");
						phase = "task-persisted";
						const ok = member.role === old.role;
						send(
							replyStore,
							member,
							{ ...old, key: job.from },
							{
								kind: "new-session-result",
								requestId: job.id,
								previousKey: old.key,
								newKey: member.key,
								sessionFile: file,
								ok,
								phase,
								detail: ok
									? `新会话 ${member.name}（${member.key}，模型 ${member.model}）已建立，任务已写入；执行结果未确认，不代表工单已认领`
									: "新会话及任务已保存，但角色恢复不符，未触发处理",
							},
						);
						if (ok) {
							const failed = () => console.warn("pi-peer: 新任务已保存，处理轮异常，请核实执行结果。");
							try {
								void fresh
									.sendUserMessage("请处理新会话中已保存的任务；涉及工单先查询当前状态再行动。", {
										deliverAs: "followUp",
										expandPromptTemplates: false,
									})
									.catch(failed);
							} catch {
								failed();
							}
						}
					},
				});
				if (replacement.cancelled)
					send(
						replyStore,
						old,
						{ ...old, key: job.from },
						{
							kind: "new-session-result",
							requestId: job.id,
							previousKey: old.key,
							ok: false,
							phase: "not-created",
							detail: "宿主取消新会话，旧会话保留",
						},
					);
			} catch {
				try {
					send(
						replyStore,
						old,
						{ ...old, key: job.from },
						{
							kind: "new-session-result",
							requestId: job.id,
							previousKey: old.key,
							ok: false,
							phase,
							detail: `新会话操作未完整确认（${phase}）；结果须核实，不要盲目再次新建`,
						},
					);
				} catch {
					/* 发送失败交由调用者超时报告未知，不触发重复重置。 */
				}
			} finally {
				active = undefined;
			}
		},
	});
	pi.registerTool({
		name: "peer_new_session",
		label: "Peer New Session",
		description:
			"为同项目已有的其他在线空闲 agent 建立新会话并派发任务；须 canStartSessions: true，旧会话日志保留，不新增 agent 进程。等待新会话身份和任务写入确认，不等于已执行或认领工单；超时先核实，勿盲目重试。",
		parameters: Type.Object({
			to: Type.String({ description: "先用 peer_list 查询目标的名称或 key" }),
			task: Type.String({ description: "新会话任务正文，不作为宿主命令执行" }),
		}),
		async execute(_id, params, signal) {
			const runtime = deps.get();
			if (!runtime || !deps.canStart(runtime.member.role)) throw new Error("当前角色没有 canStartSessions 权限");
			if (!params.task.trim() || params.task.length > MAX_TEXT) throw new Error("任务正文为空或超出长度限制");
			const target = deps.resolve(params.to);
			if (!target.ok || !target.live) throw new Error("目标不在线、找不到或不唯一，请重新 peer_list");
			if (target.bucket !== runtime.store.dir || target.member.key === runtime.member.key)
				throw new Error("只允许同项目其他会话");
			const expectedEpoch = target.member.newSessionEpoch;
			if (
				target.member.newSessionVersion !== 1 ||
				typeof expectedEpoch !== "string" ||
				!/^[A-Za-z0-9_-]{1,64}$/.test(expectedEpoch)
			)
				throw new Error("目标版本不支持远程新会话，请先重载目标");
			if (!target.member.sessionFile) throw new Error("目标为内存会话，不发送新会话请求");
			if (target.member.busy !== false) throw new Error("目标在忙或忙闲未知，不发送重置请求");
			if (signal?.aborted) throw new Error("已取消，未发送请求");
			return new Promise<ReturnType<typeof result>>((resolve, reject) => {
				const id = send(runtime.store, runtime.member, target.member, {
					kind: "new-session",
					expectedKey: target.member.key,
					expectedEpoch,
					expectedName: target.member.name,
					expectedRole: target.member.role,
					task: params.task,
					expiresAt: Date.now() + REQUEST_MS,
				});
				const finish = (ok: boolean, detail: string) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", abort);
					outgoing.delete(id);
					if (ok) resolve(result(detail));
					else reject(new Error(detail));
				};
				const abort = () => finish(false, "等待已取消，结果未知；请查询目标，勿盲目再次新建");
				const timer = setTimeout(
					() => finish(false, "新会话确认超时，结果未知；请查询目标，勿盲目再次新建"),
					10_000,
				);
				outgoing.set(id, { member: { ...target.member }, finish });
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
			});
		},
	});
	return {
		isPending: () => !!active || queued.size > 0,
		dispose() {
			for (const pending of outgoing.values()) pending.finish(false, "源会话已切换或关闭，结果未知，请核实目标");
			queued.clear();
		},
		async handle(msg: PeerMessage) {
			const runtime = deps.get(),
				control = msg.control;
			if (!runtime || !control || msg.to !== runtime.member.key) return;
			if (control.kind === "new-session-result") {
				if (
					typeof control.ok !== "boolean" ||
					!PHASES.includes(control.phase) ||
					typeof control.detail !== "string" ||
					control.detail.length > MAX_TEXT
				)
					return;
				const pending = outgoing.get(control.requestId);
				if (!pending || control.previousKey !== pending.member.key || typeof control.detail !== "string") return;
				if (control.ok) {
					const member = runtime.store.listMembers().find((m) => m.key === msg.from);
					if (
						control.phase !== "task-persisted" ||
						!member ||
						member.pid !== pending.member.pid ||
						member.key === pending.member.key ||
						member.key !== control.newKey ||
						!control.sessionFile ||
						control.sessionFile === pending.member.sessionFile ||
						member.sessionFile !== control.sessionFile
					)
						return;
				} else if (msg.from !== pending.member.key) {
					const member = runtime.store.listMembers().find((m) => m.key === msg.from);
					if (!member || member.pid !== pending.member.pid || member.key !== control.newKey) return;
				}
				pending.finish(control.ok === true, `${control.phase}：${control.detail}`);
				return;
			}
			if (control.kind !== "new-session" || !/^[A-Za-z0-9_-]{1,64}$/.test(msg.id) || seen.has(msg.id)) return;
			seen.add(msg.id);
			if (seen.size > 200) seen.delete(seen.values().next().value!);
			const reason = denial(msg, runtime.ctx);
			if (reason || active || queued.size) {
				respond(runtime, msg, false, "not-created", reason ?? "目标已有会话切换请求，不排队重置");
				return;
			}
			queued.set(msg.id, msg);
			const expires = setTimeout(
				() => {
					if (queued.delete(msg.id)) {
						try {
							respond(runtime, msg, false, "not-created", "请求已过期，未新建会话");
						} catch {
							/* 不可确认时由调用方超时报告未知，目标不执行过期请求。 */
						}
					}
				},
				Math.max(0, control.expiresAt - Date.now()),
			);
			expires.unref?.();
			try {
				pi.sendUserMessage(`/${COMMAND} ${msg.id}`, { deliverAs: "followUp", expandPromptTemplates: true });
			} catch {
				queued.delete(msg.id);
				respond(runtime, msg, false, "not-created", "目标命令入口不可用");
			}
		},
	};
}
