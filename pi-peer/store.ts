/**
 * pi-peer 传输层（纯 Node，不依赖 pi API，可单独测试）
 *
 * 目录布局（root 默认 ~/.pi/peers，按工作目录分桶）：
 *
 *   <root>/<cwdKey>/
 *     members/<sessionKey>.json        会话注册表（含心跳，用于发现与存活判断）
 *     pending/<sessionKey>/*.json      未投递消息（收件箱）
 *     delivered/<sessionKey>/*.json    已投递存档（供回看，且有界修剪）
 *     outbox/<sessionKey>/*.json       自己发出的消息（回复链追踪）
 *
 * 设计要点：
 * - 原子写：先写临时文件再 rename，避免读到半截 JSON
 * - 先搬再读：投递时先把文件 rename 到 delivered，杜绝重复投递
 * - 无守护进程：每个会话只写自己的收件箱和注册表，崩溃自愈靠 pid + lastSeen
 *
 * AI(TAG): [跨项目寻址与投递] 桶是唯一真相：跨项目发现靠扫 root 下所有桶，投递写目标的桶。
 * 不维护全局注册表（会多一处会和桶不同步的状态），也不改接收侧的收件箱监听。
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionControl } from "./session-control.ts";

/** 目录权限：消息正文可能带着项目内容，收口给本人可见 */
const DIR_MODE = 0o700;

/** 心跳超时（毫秒）：超过即视为离线 */
export const STALE_MS = 30_000;
/** 单条消息正文上限（字符） */
export const MAX_TEXT = 32_000;
/** 单次投递最多处理的消息数，避免积压时一次性灌爆上下文 */
export const MAX_BATCH = 20;
/** delivered 目录保留条数 */
export const HISTORY_KEEP = 200;

/** 会话 key 合法字符集：用于路径拼接，防目录穿越 */
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ROLE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const ROLE_SLOT_LIMIT = 10_000;

interface RoleClaim {
	role: string;
	name: string;
	key: string;
	pid: number;
	claimedAt: number;
}

export interface Member {
	/** 会话唯一标识（进程内生成，形如 38412-a1b2） */
	key: string;
	/** 展示名，可被 /peer-name 修改 */
	name: string;
	/** 项目标签，跨项目寻址用；注册时算好写进来，发现方不必读对方配置 */
	project?: string;
	/** 基础角色，例如 dev；同角色实例共享这一个角色值 */
	role?: string;
	/** 角色实例名，例如 dev、dev-2；用于释放认领槽位 */
	roleSlot?: string;
	/** 支持带确认的远程角色分配协议；缺失表示旧版。 */
	roleAssignmentVersion?: 1;
	newSessionVersion?: 1;
	newSessionEpoch?: string;
	/** 支持普通/紧急消息及有效交接消费协议。 */
	messageProtocol?: 1;
	/** 本会话已加载支持有效交接消费的台账扩展。 */
	handoffConsumer?: 1;
	/** 模型标识，形如 deepseek/deepseek-flash */
	model: string;
	pid: number;
	cwd: string;
	sessionFile?: string;
	startedAt: number;
	lastSeen: number;
	/** 正在跑一轮（agent_start 到 agent_end 之间）。派工方据此避开，不打断进行中的工作 */
	busy?: boolean;
	/** 这一轮什么时候开始的：busy 卡住（中断没触发 agent_end）时按超时兜底 */
	busySince?: number;
	/** 专注模式（/peer-focus）：对其他会话隐身。别的会话在列表、解析与投递里都看不到它 */
	hidden?: boolean;
	/**
	 * 项目内可见范围：非空时该角色隐身，只有名单里的基础角色看得见它、能给它发消息。
	 * 注册时从项目配置算好写进来，发现方不必读对方的配置文件。
	 */
	visibleTo?: string[];
	/** 已受理、等这一轮结束才切换的角色分配；在跑一轮时写这里，agent_end 里执行后摘掉 */
	pendingRole?: { role: string; from: string };
}

/** 忙超过这个时长就当它卡住了：不再信任 busy，避免一次异常让该会话永远收不到消息 */
export const BUSY_STALE_MS = 30 * 60_000;

// AI(TAG): [角色调度] 控制消息由接收进程校验并执行，不把消息正文当授权。
// 目标在跑一轮时默认打断（abort 这一轮），受理后在 agent_end 里立刻切换，用同一个 requestId 回第二次结果。
export type RoleControl =
	| {
			kind: "assign-role";
			role: string;
			expiresAt: number;
			expectedRole?: string;
			expectedName: string;
			/** 目标在跑一轮时是否打断；不写按打断处理。旧版目标只认排队 */
			interrupt?: boolean;
	  }
	| {
			kind: "assign-role-result";
			requestId: string;
			ok: boolean;
			detail: string;
			/** queued=受理待切；applied=已切换；dropped=未执行也不排队。缺省按立即结果处理 */
			state?: "queued" | "applied" | "dropped";
	  };

export interface PeerMessage {
	id: string;
	/** 发送方 key */
	from: string;
	fromName: string;
	fromModel?: string;
	/** 接收方 key */
	to: string;
	/** 会话线索：回复时继承 */
	thread?: string;
	/** 回复目标消息 id */
	replyTo?: string;
	text: string;
	control?: RoleControl | SessionControl;
	priority?: "normal" | "urgent";
	handoff?: { id: string; lease: string };
	ts: number;
}

/** 成员 + 它所在的桶：跨项目投递要知道往哪个目录写 */
export interface ScopedMember {
	member: Member;
	/** 桶的绝对路径；扫描时拿到，不由 cwd 反算（目录删除或改名后反算会对不上） */
	bucket: string;
	project: string;
	/** 进程还在且心跳新鲜 */
	live: boolean;
}

export type ResolveResult =
	| { ok: true; member: Member; bucket: string; live: boolean }
	| {
			ok: false;
			reason: "self" | "none" | "ambiguous" | "offline" | "busy" | "hidden";
			candidates: Member[];
			/** 仅跨项目解析失败时给：本机在线的项目标签，用于「没有这个项目」的提示 */
			projects?: string[];
	  };

/**
 * 项目标签：跨项目寻址的前缀。
 *
 * 斜杠、空白、控制字符换成 - —— 寻址靠首个斜杠分词，标签里不能带斜杠。
 * 没给 group.name 就用目录名；清完为空则退为 session。
 */
export function projectLabel(raw: string | undefined, cwd: string): string {
	const source = raw?.trim() || path.basename(cwd);
	const cleaned = source.replace(/[/\s\u0000-\u001f]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned.slice(0, 32) || "session";
}

/** 把工作目录映射成稳定的分桶名：可读前缀 + 路径哈希 */
export function cwdKey(cwd: string): string {
	let real = cwd;
	try {
		real = fs.realpathSync(cwd);
	} catch {
		// 目录不存在时退回原值
	}
	const base =
		path
			.basename(real)
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.slice(0, 24) || "root";
	const hash = createHash("sha1").update(real).digest("hex").slice(0, 8);
	return `${base}-${hash}`;
}

/** 生成本次会话的 key（进程号 + 随机短串，避免 reload 后与旧记录撞车） */
/**
 * 会话标识：`<pid>-<4 hex>`。
 *
 * 给了 stableSeed（通常是会话文件路径）就由它派生后缀：同一会话在同一进程里
 * reload、切分支、重建扩展运行时都不换 key，收件箱目录也就不会一份历史散成几个。
 * 没有 seed 时退回随机——还没落盘的空白会话属于这种情况。
 *
 * 跨进程仍然会变（pid 变了），所以「同一个会话的历史」不能只靠 key 找，
 * 见 identity 账与 historyBySession。
 */
export function newSessionKey(pid = process.pid, stableSeed?: string): string {
	const suffix = stableSeed
		? createHash("sha256").update(stableSeed).digest("hex").slice(0, 4)
		: randomBytes(2).toString("hex");
	return `${pid}-${suffix}`;
}

/** 生成消息 id */
export function newMessageId(): string {
	return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function writeAtomic(file: string, data: unknown): void {
	const tmp = `${file}.tmp-${randomBytes(3).toString("hex")}`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, "\t"), "utf8");
	fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function pidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM 说明进程存在但属于别的用户
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** 文件名时间戳前缀，保证字典序 = 时间序；同毫秒内用进程内自增序号消歧 */
let stampSeq = 0;
function stamp(ts: number): string {
	stampSeq = (stampSeq + 1) % 1000;
	return `${String(ts).padStart(16, "0")}-${String(stampSeq).padStart(3, "0")}`;
}

/**
 * 按 pid 归组一个桶里的老 key，补出 `identities.json`。
 *
 * 独立成函数是因为桶目录名由 `cwdKey(cwd)` 生成、反推不出 cwd：
 * 要批量处理全部桶时，只有目录没有 cwd。
 */
export function backfillBucketIdentities(bucketDir: string): { key: string; group: string }[] {
	const identityFile = path.join(bucketDir, "identities.json");
	let all: Record<string, { sessionFile?: string; name: string; at: number }> = {};
	try {
		const parsed = JSON.parse(fs.readFileSync(identityFile, "utf8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			all = parsed as typeof all;
		}
	} catch {
		// 没有账或读不动：从空账开始
	}

	let keys: string[] = [];
	try {
		keys = fs.readdirSync(path.join(bucketDir, "delivered"));
	} catch {
		return [];
	}
	const byPid = new Map<string, string[]>();
	for (const key of keys) {
		if (!KEY_RE.test(key)) continue;
		const pid = key.split("-")[0];
		if (!pid) continue;
		const list = byPid.get(pid) ?? [];
		list.push(key);
		byPid.set(pid, list);
	}

	const changed: { key: string; group: string }[] = [];
	for (const [pid, group] of byPid) {
		if (group.length < 2) continue;
		const groupTag = `pid:${pid}`;
		for (const key of group) {
			const known = all[key];
			// 已登记真实会话文件的保持原样：那是更可靠的归属
			if (known?.sessionFile && !known.sessionFile.startsWith("pid:")) continue;
			all[key] = { sessionFile: groupTag, name: known?.name ?? `会话 ${pid}`, at: known?.at ?? Date.now() };
			changed.push({ key, group: groupTag });
		}
	}
	if (changed.length) {
		fs.mkdirSync(bucketDir, { recursive: true, mode: DIR_MODE });
		writeAtomic(identityFile, all);
	}
	return changed;
}

export class PeerStore {
	/** 共享根目录：跨项目扫描要遍历它下面的桶 */
	readonly root: string;
	/** 当前工作目录对应的桶 */
	readonly dir: string;

	constructor(root: string, cwd: string) {
		this.root = root;
		this.dir = path.join(root, cwdKey(cwd));
	}

	get membersDir(): string {
		return path.join(this.dir, "members");
	}

	get roleClaimsDir(): string {
		return path.join(this.dir, "role-claims");
	}

	pendingDir(key: string): string {
		assertKey(key);
		return path.join(this.dir, "pending", key);
	}

	deliveredDir(key: string): string {
		assertKey(key);
		return path.join(this.dir, "delivered", key);
	}

	outboxDir(key: string): string {
		assertKey(key);
		return path.join(this.dir, "outbox", key);
	}

	/** 建立本次会话需要的目录 */
	ensure(key: string): void {
		for (const d of [this.membersDir, this.pendingDir(key), this.deliveredDir(key), this.outboxDir(key)]) {
			fs.mkdirSync(d, { recursive: true, mode: DIR_MODE });
		}
	}

	/**
	 * key → 会话身份的账：`identities.json`，形如 `{ "<key>": { sessionFile, name, at } }`。
	 *
	 * 为什么需要它：key 含 pid，进程重启就换，而 `delivered/` 是按 key 建目录的。
	 * 同一段对话的历史会散在几个目录里，只按当前 key 查就只剩最后一段。
	 * 记下 sessionFile 之后，就能把同一会话的多个 key 聚合起来。
	 */
	private identityFile(): string {
		return path.join(this.dir, "identities.json");
	}

	/** 记一次 key 与它的会话身份。同一 key 重复注册只刷新 name 与时间。 */
	recordIdentity(key: string, info: { sessionFile?: string; name: string }): void {
		assertKey(key);
		const all = this.readIdentities();
		all[key] = { sessionFile: info.sessionFile, name: info.name, at: Date.now() };
		this.writeIdentities(all);
	}

	private readIdentities(): Record<string, { sessionFile?: string; name: string; at: number }> {
		const file = this.identityFile();
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
			return parsed as Record<string, { sessionFile?: string; name: string; at: number }>;
		} catch {
			return {};
		}
	}

	private writeIdentities(all: Record<string, { sessionFile?: string; name: string; at: number }>): void {
		fs.mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
		// writeAtomic 自己会序列化：这里传对象，传字符串会被双重编码成 ""{...}""
		writeAtomic(this.identityFile(), all);
	}

	/**
	 * 同一段对话用过的所有 key：sessionFile 相同的就是同一会话。
	 * 没给 sessionFile 时退回 `[key]`——不知道归属，只能查当前这一份。
	 */
	keysOfSession(key: string, sessionFile?: string): string[] {
		const all = this.readIdentities();
		const keys = new Set<string>([key]);
		if (sessionFile) {
			for (const [k, info] of Object.entries(all)) {
				if (info.sessionFile === sessionFile) keys.add(k);
			}
		}
		return [...keys].filter((k) => KEY_RE.test(k));
	}

	/**
	 * 跨 key 的已投递历史（新→旧）：把同一会话散在多个目录里的消息合起来。
	 * since / until 是毫秒时间戳，给收件箱被单条内容淹掉之后留一条按时间翻的路。
	 */
	historyBySession(
		key: string,
		options: { sessionFile?: string; limit?: number; since?: number; until?: number } = {},
	): PeerMessage[] {
		const limit = Math.max(1, options.limit ?? 20);
		const seen = new Set<string>();
		const out: PeerMessage[] = [];
		for (const k of this.keysOfSession(key, options.sessionFile)) {
			let files: string[];
			try {
				files = fs.readdirSync(this.deliveredDir(k)).filter((f) => f.endsWith(".json"));
			} catch {
				continue;
			}
			for (const f of files) {
				const msg = readJson<PeerMessage>(path.join(this.deliveredDir(k), f));
				if (!msg || typeof msg.id !== "string" || seen.has(msg.id)) continue;
				if (options.since != null && msg.ts < options.since) continue;
				if (options.until != null && msg.ts > options.until) continue;
				seen.add(msg.id);
				out.push(msg);
			}
		}
		return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
	}

	/**
	 * 回填老 key 的身份：同一个 pid 出现多个 key，说明同一进程反复重建会话运行时。
	 * 这些 key 属于同一段对话，但早期版本没记 sessionFile，只能按 pid 归组。
	 *
	 * 归组后的 sessionFile 写成 `pid:<pid>` 这种标记，只为让 `keysOfSession` 能把它们聚到一起，
	 * 不代表真实文件。已有 sessionFile 的 key 不动。
	 *
	 * 返回改了哪些 key，空数组表示没有可回填的。
	 */
	backfillIdentities(): { key: string; group: string }[] {
		return backfillBucketIdentities(this.dir);
	}

	/** 认领角色实例名：第一个用基础角色，后续追加 -2、-3…… */
	claimRoleName(role: string, key: string, pid: number, preferred?: string): string {
		assertRole(role);
		assertKey(key);
		fs.mkdirSync(this.roleClaimsDir, { recursive: true, mode: DIR_MODE });

		const candidates: string[] = [];
		if (preferred && isRoleSlot(role, preferred)) candidates.push(preferred);
		for (let index = 1; index <= ROLE_SLOT_LIMIT; index++) {
			const name = roleSlotName(role, index);
			if (!candidates.includes(name)) candidates.push(name);
		}

		for (const name of candidates) {
			const file = this.roleClaimFile(name);
			const temp = path.join(this.roleClaimsDir, `.${name}.${key}-${randomBytes(3).toString("hex")}.tmp`);
			try {
				const claim: RoleClaim = { role, name, key, pid, claimedAt: Date.now() };
				writeAtomic(temp, claim);
				fs.linkSync(temp, file);
				try {
					fs.unlinkSync(temp);
				} catch {
					// 认领已完成，临时文件清理失败不影响槽位归属。
				}
				return name;
			} catch (err) {
				try {
					fs.unlinkSync(temp);
				} catch {
					// 临时文件可能已被上面的清理步骤移除。
				}
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
				const claim = readJson<RoleClaim>(file);
				if (
					!claim ||
					claim.role !== role ||
					claim.name !== name ||
					(!isLiveRoleClaim(claim) && !this.isLiveRoleMember(claim))
				) {
					try {
						fs.unlinkSync(file);
					} catch {
						// 另一个进程可能刚好完成了清理，继续尝试下一个槽位。
					}
				}
			}
		}

		throw new Error(`角色 ${role} 的实例名已达到上限 ${ROLE_SLOT_LIMIT}`);
	}

	/** 释放本会话认领的角色实例名，避免下次启动一直从更大序号开始。 */
	releaseRoleName(role: string, name: string, key: string): void {
		assertRole(role);
		if (!isRoleSlot(role, name)) return;
		const file = this.roleClaimFile(name);
		const claim = readJson<RoleClaim>(file);
		if (claim?.key !== key) return;
		try {
			fs.unlinkSync(file);
		} catch {
			// 进程退出时槽位可能已被清理。
		}
	}

	/** 注册（或刷新）成员 */
	register(member: Member): void {
		assertKey(member.key);
		fs.mkdirSync(this.membersDir, { recursive: true, mode: DIR_MODE });
		writeAtomic(path.join(this.membersDir, `${member.key}.json`), member);
	}

	/** 心跳：只更新时间戳 */
	heartbeat(member: Member): void {
		member.lastSeen = Date.now();
		this.register(member);
		if (member.role && member.roleSlot) this.touchRoleClaim(member.role, member.roleSlot, member.key);
	}

	unregister(key: string): void {
		try {
			fs.unlinkSync(path.join(this.membersDir, `${key}.json`));
		} catch {
			// 已经被清理过
		}
	}

	/** 读一个桶的成员表，顺带清死成员（pid 死或心跳过期） */
	private readBucket(bucket: string): ScopedMember[] {
		const membersDir = path.join(bucket, "members");
		let files: string[];
		try {
			files = fs.readdirSync(membersDir);
		} catch {
			return [];
		}

		const now = Date.now();
		const live: ScopedMember[] = [];
		const stale: ScopedMember[] = [];

		for (const f of files) {
			if (!f.endsWith(".json")) continue;
			const m = readJson<Member>(path.join(membersDir, f));
			if (!m || typeof m.key !== "string" || !KEY_RE.test(m.key)) {
				stale.push({
					member: m ?? ({ key: f.replace(/\.json$/, "") } as Member),
					bucket,
					project: projectLabel(undefined, m?.cwd ?? bucket),
					live: false,
				});
				continue;
			}
			const fresh = pidAlive(m.pid) && now - (m.lastSeen ?? 0) < STALE_MS;
			(fresh ? live : stale).push({
				member: m,
				bucket,
				// 老成员文件没有 project（加字段之前注册的）→ 回退目录名
				project: m.project ?? projectLabel(undefined, m.cwd),
				live: fresh,
			});
		}

		for (const s of stale) {
			// 修掉读到的坏数据；删不掉就算了（可能已被别的会话清掉）
			if (s.member.key && KEY_RE.test(s.member.key)) {
				try {
					fs.unlinkSync(path.join(membersDir, `${s.member.key}.json`));
				} catch {
					// ignore
				}
			}
		}

		return [...live, ...stale].sort((a, b) => (a.member.startedAt ?? 0) - (b.member.startedAt ?? 0));
	}

	/** 本项目桶的成员，带存活标记。专注与可见范围的过滤都在 visibleToViewer 里 */
	listScoped(opts: { includeStale?: boolean; selfKey?: string } = {}): ScopedMember[] {
		return visibleToViewer(this.readBucket(this.dir), opts.selfKey).filter((s) => opts.includeStale || s.live);
	}

	/** 列出存活成员（顺带清理过期注册表） */
	listMembers(opts: { includeStale?: boolean; selfKey?: string } = {}): Member[] {
		return this.listScoped(opts).map((s) => s.member);
	}

	/** 扫全部桶：有谁在、在哪个桶、属于哪个项目。可见性按浏览方一次判完（浏览方可能不在同一个桶） */
	listAllMembers(opts: { includeStale?: boolean; selfKey?: string } = {}): ScopedMember[] {
		return visibleToViewer(this.scanBuckets(), opts.selfKey).filter((s) => s.live || opts.includeStale);
	}

	/** 扫全部桶且不做可见性过滤：仅用于分辨「没这个人」与「它对你隐身」 */
	private scanBuckets(): ScopedMember[] {
		let names: string[];
		try {
			names = fs.readdirSync(this.root);
		} catch {
			return [];
		}

		const out: ScopedMember[] = [];
		for (const name of names) {
			const bucket = path.join(this.root, name);
			try {
				if (!fs.statSync(bucket).isDirectory()) continue;
			} catch {
				continue;
			}
			out.push(...this.readBucket(bucket));
		}
		return out;
	}

	/** 从候选中挑唯一目标：key / 名字 / name#pid / pid / 前缀 */
	private pick(candidates: ScopedMember[], query: string, selfKey: string): ResolveResult {
		const others = candidates.filter((s) => s.member.key !== selfKey);
		const hit = (s: ScopedMember): ResolveResult => ({ ok: true, member: s.member, bucket: s.bucket, live: s.live });

		const exactKey = others.find((s) => s.member.key === query);
		if (exactKey) return hit(exactKey);

		const lower = query.toLowerCase();
		const exactName = others.filter((s) => s.member.name.toLowerCase() === lower);
		if (exactName.length === 1) return hit(exactName[0]);

		// name#pid
		const hash = /^(.+)#(\d+)$/.exec(query);
		if (hash) {
			const byHash = others.find(
				(s) => s.member.name.toLowerCase() === hash[1].toLowerCase() && String(s.member.pid) === hash[2],
			);
			if (byHash) return hit(byHash);
		}

		// pid
		if (/^\d+$/.test(query)) {
			const byPid = others.filter((s) => String(s.member.pid) === query);
			if (byPid.length === 1) return hit(byPid[0]);
		}

		// 前缀（key 或 name）
		const prefixed = others.filter(
			(s) => s.member.key.toLowerCase().startsWith(lower) || s.member.name.toLowerCase().startsWith(lower),
		);
		if (prefixed.length === 1) return hit(prefixed[0]);
		if (prefixed.length > 1) return { ok: false, reason: "ambiguous", candidates: prefixed.map((s) => s.member) };

		return { ok: false, reason: "none", candidates: others.map((s) => s.member) };
	}

	/**
	 * 解析目标：只在本项目桶里找。支持 name / name#pid / key / key 前缀 / pid
	 *
	 * 只认在线的：写进一个已经死掉的会话 key，信会永远躺在那里没人取，
	 * 发件人却以为投出去了。名字能对上但人不在线时报 offline，由调用方决定怎么处理。
	 */
	resolve(query: string, selfKey: string): ResolveResult {
		const q = query.trim().replace(/^@/, "");
		if (!q) return { ok: false, reason: "none", candidates: [] };

		const bucket = this.readBucket(this.dir);
		const members = visibleToViewer(bucket, selfKey);
		if (members.some((s) => s.member.key === selfKey && matchesQuery(s.member, q))) {
			return { ok: false, reason: "self", candidates: [] };
		}
		return this.withHiddenBucket(this.pickLive(members, q, selfKey), bucket, q, selfKey);
	}

	/** 只在空闲的在线成员里解析：派工走它，避免 steer 插进别人正在做的事 */
	resolveIdle(query: string, selfKey: string): ResolveResult {
		const q = query.trim().replace(/^@/, "");
		if (!q) return { ok: false, reason: "none", candidates: [] };
		const bucket = this.readBucket(this.dir);
		const members = visibleToViewer(bucket, selfKey);
		if (members.some((s) => s.member.key === selfKey && matchesQuery(s.member, q))) {
			return { ok: false, reason: "self", candidates: [] };
		}
		return this.withHiddenBucket(this.pickLive(members, q, selfKey, true), bucket, q, selfKey);
	}

	/**
	 * 解析跨项目目标：按 (项目标签, 名字) 在全机范围找。
	 *
	 * 项目标签不存在与名字不存在是两种错，提示不同，所以失败时把在线项目也带回去。
	 */
	resolveScoped(project: string, name: string, selfKey: string): ResolveResult {
		const q = name.trim().replace(/^@/, "");
		const scanned = this.scanBuckets();
		const all = visibleToViewer(scanned, selfKey);

		const self = all.find((s) => s.member.key === selfKey);
		if (self && self.project === project && matchesQuery(self.member, q)) {
			return { ok: false, reason: "self", candidates: [] };
		}

		const inProject = all.filter((s) => s.project === project);
		const blockedIn = () =>
			this.blockedMatch(
				scanned.filter((s) => s.project === project),
				q,
				selfKey,
			);
		if (!inProject.length) {
			const blocked = blockedIn();
			if (blocked) return { ok: false, reason: "hidden", candidates: [blocked] };
			const projects = [...new Set(all.filter((s) => s.live).map((s) => s.project))].sort();
			return { ok: false, reason: "none", candidates: [], projects };
		}
		const hit = this.pickLive(inProject, q, selfKey);
		if (hit.ok || hit.reason !== "none") return hit;
		const blocked = blockedIn();
		return blocked ? { ok: false, reason: "hidden", candidates: [blocked] } : hit;
	}

	/**
	 * 本项目解析失败时再查一次：名字对得上、但被可见性筛掉的成员算「对你隐身」，
	 * 不归成「没有这个人」——后者会让人换名字重试，而实际得让名单里的角色来。
	 */
	private withHiddenBucket(hit: ResolveResult, bucket: ScopedMember[], q: string, selfKey: string): ResolveResult {
		if (hit.ok || hit.reason !== "none") return hit;
		const blocked = this.blockedMatch(bucket, q, selfKey);
		return blocked ? { ok: false, reason: "hidden", candidates: [blocked] } : hit;
	}

	/** 只算被 visibleTo 挡掉的（专注模式的隐身仍按「找不到」处理） */
	private blockedMatch(members: ScopedMember[], q: string, selfKey: string): Member | undefined {
		const viewer = members.find((s) => s.member.key === selfKey);
		const blocked = members.filter(
			(s) => s.member.key !== selfKey && s.live && !s.member.hidden && !canSee(viewer, s),
		);
		const hit = this.pick(blocked, q, selfKey);
		return hit.ok ? hit.member : undefined;
	}

	/**
	 * 只在在线的成员里选：名字能对上但人不在线时报 offline，不把信写进死信箱。
	 * skipBusy=true 时，正在跑一轮的会话也当不可投（派工用；手动发消息不受限）。
	 */
	private pickLive(candidates: ScopedMember[], query: string, selfKey: string, skipBusy = false): ResolveResult {
		const usable = candidates.filter((s) => s.live && !(skipBusy && isBusy(s.member)));
		const hit = this.pick(usable, query, selfKey);
		if (!hit.ok && hit.reason === "none" && skipBusy) {
			// 人在线但在忙：与「离线」分开报，调用方好区分是等一等还是换人
			const busyOnly = this.pick(
				candidates.filter((s) => s.live && isBusy(s.member)),
				query,
				selfKey,
			);
			if (busyOnly.ok) return { ok: false, reason: "busy", candidates: [busyOnly.member] };
			if (busyOnly.reason === "ambiguous") return { ok: false, reason: "busy", candidates: busyOnly.candidates };
		}
		if (hit.ok || hit.reason !== "none") return hit;

		const offline = this.pick(
			candidates.filter((s) => !s.live),
			query,
			selfKey,
		);
		if (offline.ok) return { ok: false, reason: "offline", candidates: [offline.member] };
		if (offline.reason === "ambiguous") return { ok: false, reason: "offline", candidates: offline.candidates };
		return hit;
	}

	/** 投递：写入目标收件箱（原子落盘）。targetBucket 缺省写本项目桶 */
	send(msg: PeerMessage, targetBucket: string = this.dir): void {
		assertKey(msg.to);
		const dir = path.join(targetBucket, "pending", msg.to);
		fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
		const text = msg.text.slice(0, MAX_TEXT);
		const payload: PeerMessage = { ...msg, text };
		writeAtomic(path.join(dir, `${stamp(payload.ts)}-${payload.id}.json`), payload);
	}

	/**
	 * 代外部调用方（工单台账的扫描器、其他扩展）投一条给某个名字。
	 *
	 * 只投在线的：离线就如实回报，不写进没人取的收件箱——信躺在死 key 里没人知道，
	 * 发件方却以为已经送达。这是与「会话自己发消息」的关键区别。
	 */
	deliverTo(
		target: string,
		message: { from: string; fromName: string; text: string },
		options: { idleOnly?: boolean } = {},
	): { ok: true; to: string; id: string } | { ok: false; reason: string; detail: string } {
		const resolved = options.idleOnly ? this.resolveIdle(target, "") : this.resolve(target, "");
		if (!resolved.ok) {
			const who = resolved.candidates.map((m) => m.name).join("、");
			const detail =
				resolved.reason === "offline"
					? `${who || target} 不在线`
					: resolved.reason === "busy"
						? `${who || target} 正在跑一轮，跳过`
						: resolved.reason === "ambiguous"
							? `名字不唯一：${who}`
							: `找不到「${target}」`;
			return { ok: false, reason: resolved.reason, detail };
		}
		const id = newMessageId();
		this.send(
			{
				id,
				from: message.from,
				fromName: message.fromName,
				to: resolved.member.key,
				thread: id,
				text: message.text,
				ts: Date.now(),
			},
			resolved.bucket,
		);
		return { ok: true, to: resolved.member.name, id };
	}

	/** 取走收件箱：先 rename 再读，保证同一条消息只会被投递一次 */
	drain(key: string): PeerMessage[] {
		const dir = this.pendingDir(key);
		let files: string[];
		try {
			files = fs
				.readdirSync(dir)
				.filter((f) => f.endsWith(".json"))
				.sort();
		} catch {
			return [];
		}

		const delivered = this.deliveredDir(key);
		fs.mkdirSync(delivered, { recursive: true, mode: DIR_MODE });

		const out: PeerMessage[] = [];
		for (const f of files.slice(0, MAX_BATCH)) {
			const from = path.join(dir, f);
			const to = path.join(delivered, f);
			try {
				fs.renameSync(from, to);
			} catch {
				// 已被另一次 drain 取走
				continue;
			}
			const msg = readJson<PeerMessage>(to);
			if (msg && typeof msg.text === "string" && typeof msg.from === "string") out.push(msg);
		}
		return out;
	}

	/**
	 * 收件箱里是否已有同一份交接。
	 *
	 * 台账那边按 15 秒租约重投，每次会写一条新消息；目标在忙时这些消息都堆在 pending 里
	 * 等着注入，同一份交接就会重复注入多次。按 handoff.id 去重，只留一条。
	 */
	hasPendingHandoff(key: string, handoffId: string): boolean {
		assertKey(key);
		let files: string[];
		try {
			files = fs.readdirSync(this.pendingDir(key)).filter((f) => f.endsWith(".json"));
		} catch {
			return false;
		}
		for (const f of files) {
			const msg = readJson<PeerMessage>(path.join(this.pendingDir(key), f));
			if (msg?.handoff?.id === handoffId) return true;
		}
		return false;
	}

	/**
	 * 把一条已取走的消息放回收件箱：drain 是 rename，文件已经不在 pending 里。
	 *
	 * 用途是「取走了但没送出去」：目标在忙时不能注入，但也不该把这条消息留在 delivered
	 * ——那等于既没送到，又看不见，而且下一轮重投会再生成一条新的。
	 *
	 * 找文件靠 id 反查：drain 返回的 PeerMessage 不带文件名。
	 */
	requeue(key: string, msg: PeerMessage): boolean {
		assertKey(key);
		const delivered = this.deliveredDir(key);
		const pending = this.pendingDir(key);
		let files: string[];
		try {
			files = fs.readdirSync(delivered).filter((f) => f.endsWith(`-${msg.id}.json`));
		} catch {
			return false;
		}
		if (files.length === 0) return false;
		fs.mkdirSync(pending, { recursive: true, mode: DIR_MODE });
		try {
			fs.renameSync(path.join(delivered, files[0]!), path.join(pending, files[0]!));
			return true;
		} catch {
			return false;
		}
	}

	/** 已投递历史（新→旧），用于回看与回复链追踪 */
	history(key: string, limit = 20): PeerMessage[] {
		let files: string[];
		try {
			files = fs.readdirSync(this.deliveredDir(key)).filter((f) => f.endsWith(".json"));
		} catch {
			return [];
		}
		files.sort().reverse();
		const out: PeerMessage[] = [];
		for (const f of files.slice(0, Math.max(1, limit))) {
			const msg = readJson<PeerMessage>(path.join(this.deliveredDir(key), f));
			if (msg) out.push(msg);
		}
		return out;
	}

	/** 记录自己发出的消息，便于追踪会话线索与回复链 */
	logSent(key: string, msg: PeerMessage): void {
		assertKey(key);
		const dir = this.outboxDir(key);
		fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
		writeAtomic(path.join(dir, `${stamp(msg.ts)}-${msg.id}.json`), msg);
	}

	/** 查找某条（自己收到或发出的）消息，用于继承 thread */
	findMessage(key: string, id: string): PeerMessage | undefined {
		if (!id) return undefined;
		for (const dir of [this.deliveredDir(key), this.outboxDir(key)]) {
			let files: string[];
			try {
				files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
			} catch {
				continue;
			}
			files.sort().reverse();
			for (const f of files) {
				if (f.includes(id)) {
					const msg = readJson<PeerMessage>(path.join(dir, f));
					if (msg) return msg;
				}
			}
		}
		return undefined;
	}

	/** 有界修剪：收件箱与发件箱各保留最近 keep 条 */
	prune(key: string, keep = HISTORY_KEEP): void {
		for (const dir of [this.deliveredDir(key), this.outboxDir(key)]) {
			let files: string[];
			try {
				files = fs
					.readdirSync(dir)
					.filter((f) => f.endsWith(".json"))
					.sort();
			} catch {
				continue;
			}
			for (const f of files.slice(0, Math.max(0, files.length - keep))) {
				try {
					fs.unlinkSync(path.join(dir, f));
				} catch {
					// ignore
				}
			}
		}
	}

	private roleClaimFile(name: string): string {
		return path.join(this.roleClaimsDir, `${name}.json`);
	}

	private isLiveRoleMember(claim: RoleClaim): boolean {
		const member = readJson<Member>(path.join(this.membersDir, `${claim.key}.json`));
		return Boolean(
			member &&
				member.pid === claim.pid &&
				member.role === claim.role &&
				member.roleSlot === claim.name &&
				Date.now() - member.lastSeen < STALE_MS &&
				pidAlive(member.pid),
		);
	}

	private touchRoleClaim(role: string, name: string, key: string): void {
		const file = this.roleClaimFile(name);
		const claim = readJson<RoleClaim>(file);
		if (!claim || claim.role !== role || claim.name !== name || claim.key !== key) return;
		writeAtomic(file, { ...claim, claimedAt: Date.now() });
	}
}

/** 忙：声明了 busy 且在超时窗口内；卡住的 busy 不算，否则一次异常就永远收不到派工 */
export function isBusy(member: Member): boolean {
	return Boolean(member.busy) && Date.now() - (member.busySince ?? 0) < BUSY_STALE_MS;
}

/**
 * 隐身判据：两条规则在同一个函数里判，列表、解析、投递不再各写一遍。
 *
 * - 专注模式（hidden）：只对本人可见。不是另报一个「专注中」状态——隐身的用处就是让派工方
 *   根本选不中它，而不是看到一个要额外判断的强提示。
 * - 可见范围（visibleTo）：设了名单的角色只对**同一个桶里**名单中的基础角色可见，其余会话看不到、
 *   也解析不到。跨项目不因为同名角色而被当成名单里的人；浏览方没角色时一律看不见。
 */
function canSee(viewer: ScopedMember | undefined, target: ScopedMember): boolean {
	if (target.member.hidden) return false;
	const allow = target.member.visibleTo;
	if (!allow?.length) return true;
	const viewerRole = viewer?.member.role?.trim();
	return Boolean(viewerRole && allow.includes(viewerRole) && viewer?.bucket === target.bucket);
}

function visibleToViewer(scoped: ScopedMember[], selfKey?: string): ScopedMember[] {
	const viewer = selfKey ? scoped.find((s) => s.member.key === selfKey) : undefined;
	return scoped.filter((s) => s.member.key === selfKey || canSee(viewer, s));
}

function assertKey(key: string): void {
	if (!KEY_RE.test(key)) throw new Error(`非法会话 key: ${JSON.stringify(key)}`);
}

/** 这个标识是不是就指这个成员：用于认「目标是自己」 */
function matchesQuery(member: Member, query: string): boolean {
	return member.key === query || member.name.toLowerCase() === query.toLowerCase();
}

function assertRole(role: string): void {
	if (!ROLE_RE.test(role)) throw new Error(`非法角色名: ${JSON.stringify(role)}`);
}

function roleSlotName(role: string, index: number): string {
	return index === 1 ? role : `${role}-${index}`;
}

function isRoleSlot(role: string, name: string): boolean {
	if (name === role) return true;
	const suffix = name.slice(role.length + 1);
	return name.startsWith(`${role}-`) && /^\d+$/.test(suffix) && Number(suffix) >= 2;
}

function isLiveRoleClaim(claim: RoleClaim): boolean {
	return (
		ROLE_RE.test(claim.role) &&
		isRoleSlot(claim.role, claim.name) &&
		KEY_RE.test(claim.key) &&
		Number.isSafeInteger(claim.pid) &&
		claim.pid > 0 &&
		Date.now() - claim.claimedAt < STALE_MS &&
		pidAlive(claim.pid)
	);
}
