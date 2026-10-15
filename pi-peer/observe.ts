// AI(TAG): [会话观察] 只读注册表与进程存活信息，保留过期记录，不使用带清理副作用的成员查询。
import * as fs from "node:fs";
import * as path from "node:path";
import { BUSY_STALE_MS, cwdKey, STALE_MS } from "./store.ts";

export interface ObservedSession {
	key: string;
	name: string;
	role?: string;
	roleSlot?: string;
	pid?: number;
	lastSeen?: number;
	status: "idle" | "busy" | "stale" | "offline" | "unknown";
	reason: string;
}
export interface PeerObservation {
	state: "ok" | "missing" | "partial" | "error";
	sessions: ObservedSession[];
	issues: string[];
}
type Probe = (pid: number) => "alive" | "dead" | "unknown";
function probePid(pid: number): ReturnType<Probe> {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
	}
}
function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}
function observe(data: Record<string, unknown>, at: number, probe: Probe): ObservedSession {
	const session: ObservedSession = {
		key: String(data.key),
		name: String(data.name),
		role: text(data.role),
		roleSlot: text(data.roleSlot),
		pid: Number.isSafeInteger(data.pid) && Number(data.pid) > 0 ? Number(data.pid) : undefined,
		lastSeen:
			typeof data.lastSeen === "number" && Number.isFinite(data.lastSeen) && data.lastSeen > 0 && data.lastSeen <= at
				? data.lastSeen
				: undefined,
		status: "unknown",
		reason: "未报告完整的会话状态",
	};
	const processState = session.pid ? probe(session.pid) : "unknown";
	if (processState === "dead") return { ...session, status: "offline", reason: "进程已退出" };
	if (processState === "unknown") return { ...session, reason: "进程存活情况未知" };
	if (session.lastSeen === undefined || session.lastSeen <= 0 || session.lastSeen > at)
		return { ...session, reason: "心跳时间缺失或无效" };
	if (at - session.lastSeen >= STALE_MS) return { ...session, status: "stale", reason: "心跳已过期" };
	if (data.busy === false) return { ...session, status: "idle", reason: "心跳新鲜，明确报告空闲" };
	if (data.busy !== true) return { ...session, reason: "未报告忙闲" };
	if (
		typeof data.busySince !== "number" ||
		!Number.isFinite(data.busySince) ||
		data.busySince <= 0 ||
		data.busySince > at ||
		at - data.busySince >= BUSY_STALE_MS
	)
		return { ...session, reason: "忙碌时间缺失、无效或已过期" };
	return { ...session, status: "busy", reason: "正在运行一轮任务" };
}

export function observePeers(root: string, cwd: string, at = Date.now(), probe: Probe = probePid): PeerObservation {
	const bucket = cwdKey(cwd);
	const dir = path.join(root, bucket, "members");
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch (error) {
		const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
		return {
			state: missing ? "missing" : "error",
			sessions: [],
			issues: [missing ? "未发现会话注册表，在线情况未知" : "无法读取会话注册表"],
		};
	}
	const sessions: ObservedSession[] = [];
	const issues: string[] = [];
	for (const file of files.sort()) {
		if (!file.endsWith(".json")) continue;
		try {
			const full = path.join(dir, file);
			if (!fs.lstatSync(full).isFile()) throw new Error("不是普通文件");
			const data = JSON.parse(fs.readFileSync(full, "utf8")) as Record<string, unknown>;
			if (
				!data ||
				Array.isArray(data) ||
				typeof data.key !== "string" ||
				!/^[A-Za-z0-9_-]{1,64}$/.test(data.key) ||
				file !== `${data.key}.json` ||
				!text(data.name) ||
				typeof data.cwd !== "string" ||
				!path.isAbsolute(data.cwd) ||
				cwdKey(data.cwd) !== bucket
			)
				throw new Error("记录无效");
			sessions.push(observe(data, at, probe));
		} catch {
			issues.push(`会话记录不可读取或不属于本项目：${file}`);
		}
	}
	return { state: issues.length ? "partial" : "ok", sessions, issues };
}
