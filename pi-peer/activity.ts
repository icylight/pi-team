// AI(TAG): [会话观察] 从会话 transcript 尾部读出「当前正在跑什么」，供切换角色前判断对方是活着在干活还是卡住。
// 只读，不写任何文件；解析失败一律返回 unknown，不猜。
import * as fs from "node:fs";

export interface ToolCallFact {
	/** 调用 ID，用来与 toolResult 的 toolCallId 配对 */
	id: string;
	name: string;
	/** 参数里最有信息量的一项（bash 取 command，其余取首个键），已截断 */
	detail: string;
	/** 发出时刻（毫秒） */
	at: number;
	/** 已经有结果返回；false 表示这条调用仍在执行 */
	settled: boolean;
}

export type ActivityKind =
	/** 一条工具调用还没有结果，且时长已超阈值 */
	| "running-long"
	/** 一条工具调用还没有结果，时长还在正常范围 */
	| "running"
	/** 最后一条调用已返回，正在等模型下一步 */
	| "thinking"
	/** transcript 长时间没有新事件 */
	| "quiet"
	/** 读不到 transcript */
	| "unknown";

export interface Activity {
	kind: ActivityKind;
	/** 一句话结论，可直接放进列表 */
	summary: string;
	/** 正在跑或刚跑完的那条调用 */
	last?: ToolCallFact;
	/** 距最后一条 transcript 事件的毫秒数 */
	silentMs: number;
	/** 解析出的事件条数，0 表示没读到 */
	events: number;
}

/** 「跑一条命令超过这个时长还没返回」就值得在列表里点名，不等于判定卡死。 */
export const LONG_CALL_MS = 90_000;
/** transcript 超过这个时长没有任何新事件，且仍在 busy，才是真的可疑。 */
export const QUIET_MS = 180_000;

/** 命令里出现这些词，说明它本身就慢，不是异常。仅用于把结论说得准一点，不改变 kind。 */
const SLOW_HINTS = [
	"install",
	"build",
	"test",
	"playwright",
	"docker",
	"pull",
	"clone",
	"yt-dlp",
	"npm ",
	"uv ",
	"make ",
];

function clip(value: string, max = 120): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function detailOf(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	const key = typeof record.command === "string" ? "command" : Object.keys(record)[0];
	if (!key) return "";
	const value = record[key];
	return typeof value === "string" ? clip(value) : clip(JSON.stringify(value));
}

/** 倒着读文件尾部若干行；大文件也不整读。 */
function tailLines(file: string, maxLines: number): string[] {
	const CHUNK = 256 * 1024;
	const opened = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(opened).size;
		let data = "";
		let pos = size;
		while (pos > 0) {
			const step = Math.min(CHUNK, pos);
			pos -= step;
			const buffer = Buffer.alloc(step);
			fs.readSync(opened, buffer, 0, step, pos);
			data = buffer.toString("utf8") + data;
			if (data.split("\n").length > maxLines * 2) break;
		}
		return data.split("\n").filter((line) => line.trim().startsWith("{"));
	} finally {
		fs.closeSync(opened);
	}
}

interface ParsedEvent {
	type: string;
	at: number;
	calls?: ToolCallFact[];
	/** 工具结果事件：带 toolCallId，用它与调用配对 */
	resultOf?: string;
}

function parseLine(line: string): ParsedEvent | null {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const event = raw as Record<string, unknown>;
	const at = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : Number.NaN;
	if (!Number.isFinite(at)) return null;
	if (event.type !== "message") return { type: String(event.type ?? ""), at };
	const message = event.message as Record<string, unknown> | undefined;
	if (!message) return { type: "message", at };
	// 工具结果是单独的 message，role=toolResult，凭 toolCallId 与调用配对。
	// 之前找 content 里的 toolResult 类型是错的：那样永远配不上，所有会话都会被判成「在跑」。
	if (message.role === "toolResult" && typeof message.toolCallId === "string") {
		return { type: "message", at, resultOf: message.toolCallId };
	}
	if (!Array.isArray(message.content)) return { type: "message", at };
	const calls: ToolCallFact[] = [];
	for (const part of message.content) {
		if (!part || typeof part !== "object") continue;
		const item = part as Record<string, unknown>;
		if (item.type === "toolCall" && typeof item.name === "string" && typeof item.id === "string") {
			calls.push({ id: item.id, name: item.name, detail: detailOf(item.arguments), at, settled: false });
		}
	}
	return { type: "message", at, calls: calls.length ? calls : undefined };
}

/**
 * 读会话当前在做什么。
 *
 * 判据只有两条：**最后一条工具调用有没有返回**，以及**transcript 多久没有新事件**。
 * 有未返回的调用就算「在跑」——时长只用来决定要不要点名，不单独判卡死：
 * 长命令与卡住的命令在时长上没有区别，硬断必然误判。
 */
export function readActivity(sessionFile: string | undefined, now = Date.now()): Activity {
	if (!sessionFile || sessionFile.startsWith("pid:"))
		return { kind: "unknown", summary: "会话文件未知", silentMs: 0, events: 0 };
	let lines: string[];
	try {
		lines = tailLines(sessionFile, 80);
	} catch {
		return { kind: "unknown", summary: "读不到会话文件", silentMs: 0, events: 0 };
	}
	if (lines.length === 0) return { kind: "unknown", summary: "会话文件没有可解析的事件", silentMs: 0, events: 0 };

	const events: ParsedEvent[] = [];
	for (const line of lines) {
		const parsed = parseLine(line);
		if (parsed) events.push(parsed);
	}
	if (events.length === 0) return { kind: "unknown", summary: "会话文件没有可解析的事件", silentMs: 0, events: 0 };

	const last = events[events.length - 1];
	const silentMs = Math.max(0, now - last.at);

	// 配对：收集所有已返回的 toolCallId，再从尾部找最近一条没返回的调用。
	const settled = new Set<string>();
	for (const event of events) if (event.resultOf) settled.add(event.resultOf);
	let pending: ToolCallFact | undefined;
	let latest: ToolCallFact | undefined;
	for (let i = events.length - 1; i >= 0; i--) {
		const calls = events[i].calls;
		if (!calls) continue;
		for (let j = calls.length - 1; j >= 0; j--) {
			const call = calls[j];
			if (!latest) latest = call;
			if (!pending && !settled.has(call.id)) pending = call;
		}
		if (pending) break;
	}
	if (!pending) {
		const quiet = silentMs >= QUIET_MS;
		return {
			kind: quiet ? "quiet" : "thinking",
			summary: quiet
				? `${formatSpan(silentMs)}没有任何会话事件（上一条调用已返回）`
				: latest
					? `刚跑完 ${latest.name}，正在思考下一步`
					: "正在思考下一步",
			last: latest,
			silentMs,
			events: events.length,
		};
	}

	const elapsed = Math.max(0, now - pending.at);
	const tailOf = `${pending.name} ${pending.detail}`.trim();
	const slowHint = SLOW_HINTS.some((hint) => pending.detail.toLowerCase().includes(hint.trim()))
		? "（这类命令本来就慢）"
		: "";
	if (elapsed >= LONG_CALL_MS) {
		return {
			kind: "running-long",
			summary: `在跑 ${tailOf}，已 ${formatSpan(elapsed)}${slowHint}`,
			last: pending,
			silentMs,
			events: events.length,
		};
	}
	return {
		kind: "running",
		summary: `在跑 ${tailOf}，已 ${formatSpan(elapsed)}`,
		last: pending,
		silentMs,
		events: events.length,
	};
}

export function formatSpan(ms: number): string {
	if (ms < 1000) return "0s";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ""}`;
	return `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}

/**
 * 切换角色前的判断：这个会话能不能被打断。
 *
 * 返回值只是**建议**，最终由人决定。`safeToSwitch=false` 时附理由，
 * 让 owner 在消息里说清「它正在做什么、要不要等」。
 */
export function switchAdvice(activity: Activity): { safeToSwitch: boolean; reason: string } {
	switch (activity.kind) {
		case "running":
			return { safeToSwitch: false, reason: `${activity.summary}，打断会让这条命令白跑` };
		case "running-long":
			return { safeToSwitch: false, reason: `${activity.summary}，先问它能不能停，别直接切` };
		case "quiet":
			return { safeToSwitch: true, reason: `${activity.summary}，可能已卡住或已结束未收尾` };
		case "thinking":
			return { safeToSwitch: false, reason: `${activity.summary}，再等一会儿` };
		default:
			return { safeToSwitch: false, reason: activity.summary };
	}
}
