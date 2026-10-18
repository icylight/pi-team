/**
 * pi-peer 的项目配置：读取、来源标注、体检报告（纯 Node，不依赖 pi API）
 *
 * 一份 `<项目>/.pi/peer.json` 里的字段有三类：pi-peer 读的（enabled / group / roles / flow）、
 * 别的扩展读的（如 workOrders）、以及写错的。三类在文件里长得一样，读起来都是「没有」，
 * 所以这里把「生效值从哪来」显式记下来：
 *
 *   declared —— 配置文件里显式写的
 *   fallback —— 没写，按兜底规则算出来的（目录名当项目标签、扫 characters/ 当角色名单）
 *   absent   —— 既没写，兜底也没命中（角色卡不存在 → 角色不加载）
 *
 * 兜底一律标注，不静默：同事 clone 下来只有 characters/*.md 时，会话照样按兜底跑得起来，
 * 但跑的是哪套规则必须看得出来；字段写错也要说，否则「配了没生效」只能靠猜。
 *
 * AI(TAG): [配置来源] 判据是「每个生效项都带来源」，不是「给每个字段写一句提示」——
 * 以后新增字段走同一个模型，报告与会话提示都不用改。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { projectLabel } from "./store.ts";

/** 项目配置目录名，与 pi 的 CONFIG_DIR_NAME 一致；纯模块不 import pi，所以默认值写在这里 */
export const DEFAULT_CONFIG_DIR = ".pi";
export const CONFIG_FILE = "peer.json";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface RoleConfig {
	card?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	canAssignRoles?: boolean;
	canStartSessions?: boolean;
	/** 项目内可见范围：非空时该角色隐身，只有名单里的基础角色看得见它、能给它发消息 */
	visibleTo?: string[];
}

export interface ProjectConfig {
	enabled?: boolean;
	/** 收到工单交接时主动叫醒目标会话：默认关，显式写 true 才发那条唤醒消息 */
	wakeOnHandoff?: boolean;
	group?: {
		name?: string;
		roles?: Record<string, RoleConfig>;
		flow?: string;
	};
	/** 兼容不包在 group 下的简写配置。 */
	roles?: Record<string, RoleConfig>;
	flow?: string;
}

/** pi-peer 读的顶层键；其余顶层键原样列出来，标明不由它读取 */
const OWN_KEYS = new Set(["enabled", "wakeOnHandoff", "group", "roles", "flow"]);

export interface LoadedConfig {
	file: string;
	/** loaded=读到了；missing=文件不在（正常情况）；broken=文件在但整份解析不了 */
	state: "loaded" | "missing" | "broken";
	/** 一处一条地列：整份解析不了的原因，或写错的字段 */
	problems: string[];
	config: ProjectConfig;
	/** 配置里写了、但不由 pi-peer 读取的顶层键 */
	foreignKeys: string[];
}

export function loadProjectConfig(file: string): LoadedConfig {
	const empty: LoadedConfig = { file, state: "missing", problems: [], config: {}, foreignKeys: [] };
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return empty;
	}

	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch (error) {
		return { ...empty, state: "broken", problems: [`JSON 解析失败（${(error as Error).message}）`] };
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return { ...empty, state: "broken", problems: ["顶层要写成一个 JSON 对象"] };
	}

	const record = data as Record<string, unknown>;
	const problems: string[] = [];
	const config: ProjectConfig = {};

	// enabled 只认字面 false：写错了不改开关（仍然启用），但要说出来
	if (record.enabled !== undefined) {
		if (typeof record.enabled === "boolean") config.enabled = record.enabled;
		else problems.push("enabled 要写 true 或 false，这一项被忽略（仍按启用处理）");
	}

	// 交接唤醒只认字面 true：写错了不叫醒（安静的默认不变）
	if (record.wakeOnHandoff !== undefined) {
		if (typeof record.wakeOnHandoff === "boolean") config.wakeOnHandoff = record.wakeOnHandoff;
		else problems.push("wakeOnHandoff 要写 true 或 false，这一项被忽略（仍按不叫醒处理）");
	}

	// group 与简写 roles/flow 合并：group 优先，简写兜底（沿用原行为）
	const group = record.group;
	if (group !== undefined && !isRecord(group)) {
		problems.push("group 要写成一个对象，这一项被忽略");
	}
	const groupRecord = isRecord(group) ? group : {};

	if (groupRecord.name !== undefined) {
		if (typeof groupRecord.name === "string" && groupRecord.name.trim()) config.group = { name: groupRecord.name };
		else if (typeof groupRecord.name !== "string") problems.push("group.name 要写字符串，这一项被忽略");
	}
	if (groupRecord.flow !== undefined) {
		if (typeof groupRecord.flow === "string" && groupRecord.flow.trim()) {
			config.group = { ...config.group, flow: groupRecord.flow };
		} else if (typeof groupRecord.flow !== "string") problems.push("group.flow 要写字符串，这一项被忽略");
	}

	const roles = parseRoles(groupRecord.roles, "group.roles", problems);
	if (roles) config.group = { ...config.group, roles };
	const shorthandRoles = parseRoles(record.roles, "roles", problems);
	if (shorthandRoles) config.roles = shorthandRoles;

	if (typeof record.flow === "string" && record.flow.trim()) config.flow = record.flow;
	else if (record.flow !== undefined) problems.push("flow 要写字符串，这一项被忽略");

	const foreignKeys = Object.keys(record).filter((key) => !OWN_KEYS.has(key));
	return { file, state: "loaded", problems, config, foreignKeys };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 角色表两种写法都收：字符串（角色卡路径）或 { card: 路径 }；写错的一项一条 */
function parseRoles(raw: unknown, field: string, problems: string[]): Record<string, RoleConfig> | undefined {
	if (raw === undefined) return undefined;
	if (!isRecord(raw)) {
		problems.push(`${field} 要写成一个对象，这一项被忽略`);
		return undefined;
	}
	const roles: Record<string, RoleConfig> = {};
	for (const [role, value] of Object.entries(raw)) {
		if (typeof value === "string") roles[role] = { card: value };
		else if (isRecord(value)) {
			const parsed: RoleConfig = {};
			if (value.card !== undefined) {
				if (typeof value.card === "string") parsed.card = value.card;
				else problems.push(`${field}.${role}.card 要写路径字符串，这一项被忽略`);
			}
			if (value.model !== undefined) {
				if (typeof value.model === "string" && /^[^\s/]+\/\S+$/.test(value.model.trim())) {
					parsed.model = value.model.trim();
				} else problems.push(`${field}.${role}.model 要写 provider/model-id，这一项被忽略`);
			}
			if (value.thinkingLevel !== undefined) {
				if (THINKING_LEVELS.includes(value.thinkingLevel as RoleConfig["thinkingLevel"] & string)) {
					parsed.thinkingLevel = value.thinkingLevel as RoleConfig["thinkingLevel"];
				} else problems.push(`${field}.${role}.thinkingLevel 要写 ${THINKING_LEVELS.join(" / ")}，这一项被忽略`);
			}
			for (const key of ["canAssignRoles", "canStartSessions"] as const) {
				if (value[key] !== undefined) {
					if (typeof value[key] === "boolean") parsed[key] = value[key];
					else problems.push(`${field}.${role}.${key} 要写 true 或 false，这一项被忽略`);
				}
			}
			if (value.visibleTo !== undefined) {
				if (Array.isArray(value.visibleTo)) {
					const names = value.visibleTo.filter((v): v is string => typeof v === "string").map((v) => v.trim());
					if (names.every(Boolean) && names.length === value.visibleTo.length) {
						if (names.length) parsed.visibleTo = [...new Set(names)];
					} else problems.push(`${field}.${role}.visibleTo 要写角色名数组，写错的项被忽略`);
				} else problems.push(`${field}.${role}.visibleTo 要写角色名数组，这一项被忽略`);
			}
			roles[role] = parsed;
		} else {
			problems.push(`${field}.${role} 要写角色卡路径字符串或 { card: 路径 }，这一项被忽略`);
		}
	}
	// 一项没收下的空表等于没声明：让调用方只判 undefined，不用再判空
	return Object.keys(roles).length ? roles : undefined;
}

// ── 生效值与来源 ────────────────────────────────────

export type Origin =
	| { kind: "declared"; detail: string }
	| { kind: "fallback"; detail: string }
	| { kind: "absent"; detail: string };

export interface ConfigItem {
	/** identity=项目标签，role=本次生效的角色卡，roles=可用角色名单，flow=流程文档 */
	key:
		| "identity"
		| "role"
		| "roles"
		| "flow"
		| "model"
		| "thinkingLevel"
		| "canAssignRoles"
		| "canStartSessions"
		| "wakeOnHandoff"
		| "visibleTo";
	label: string;
	value: string;
	origin: Origin;
}

export interface ConfigReport {
	file: string;
	state: LoadedConfig["state"];
	problems: string[];
	foreignKeys: string[];
	items: ConfigItem[];
}

export function describeConfig(
	loaded: LoadedConfig,
	options: { cwd: string; role?: string; dirName?: string },
): ConfigReport {
	const dirName = options.dirName ?? DEFAULT_CONFIG_DIR;
	const items: ConfigItem[] = [];

	const label = projectLabel(loaded.config.group?.name, options.cwd);
	items.push({
		key: "identity",
		label: "项目标签",
		value: label,
		origin: loaded.config.group?.name?.trim()
			? { kind: "declared", detail: "group.name" }
			: { kind: "fallback", detail: "group.name 没写，按目录名" },
	});

	const declaredRoles = declaredRoleNames(loaded.config);
	const discovered = discoverRoles(options.cwd, dirName);
	const names = [...new Set([...declaredRoles, ...discovered])]
		.filter((role) => resolveRoleCard(options.cwd, loaded.config, role, dirName).path)
		.sort();
	items.push({
		key: "roles",
		label: "可用角色",
		value: names.length ? names.join("、") : "（没有角色卡）",
		// 一个角色都没有不算兜底，就是没配：兜底是「没声明但扫到了」
		origin: declaredRoles.length
			? { kind: "declared", detail: "roles 里声明" }
			: names.length
				? { kind: "fallback", detail: `roles 没写，扫 ${dirName}/characters/` }
				: { kind: "absent", detail: `roles 没写，${dirName}/characters/ 下也没有` },
	});

	if (options.role) {
		const card = resolveRoleCard(options.cwd, loaded.config, options.role, dirName);
		items.push({
			key: "role",
			label: `角色卡（${options.role}）`,
			value: card.path ? path.relative(options.cwd, card.path) || card.path : "（没找到，角色不加载）",
			origin: card.origin,
		});
		for (const key of ["canAssignRoles", "canStartSessions"] as const) {
			const groupPermission = loaded.config.group?.roles?.[options.role]?.[key];
			const permission = groupPermission ?? loaded.config.roles?.[options.role]?.[key];
			items.push({
				key,
				label: key === "canAssignRoles" ? "分配同项目角色权限" : "为同项目其他空闲会话新建会话权限",
				value: permission === true ? "允许" : "不允许",
				origin:
					permission !== undefined
						? {
								kind: "declared",
								detail: `${groupPermission !== undefined ? "group.roles" : "roles"}.${options.role}.${key}`,
							}
						: { kind: "absent", detail: "未配置，默认不允许" },
			});
		}
		for (const key of ["model", "thinkingLevel"] as const) {
			const groupValue = loaded.config.group?.roles?.[options.role]?.[key];
			const value = groupValue ?? loaded.config.roles?.[options.role]?.[key];
			items.push({
				key,
				label: key === "model" ? "角色默认模型" : "角色默认思考强度",
				value: value ?? "（保留会话设置）",
				origin: value
					? {
							kind: "declared",
							detail: `${groupValue !== undefined ? "group.roles" : "roles"}.${options.role}.${key}`,
						}
					: { kind: "absent", detail: "未配置，保留会话设置" },
			});
		}
		const groupVisible = loaded.config.group?.roles?.[options.role]?.visibleTo;
		const visibleTo = groupVisible ?? loaded.config.roles?.[options.role]?.visibleTo;
		items.push({
			key: "visibleTo",
			label: "项目内可见范围",
			value: visibleTo?.length ? `${visibleTo.join("、")}（对其他角色隐身）` : "不隐身",
			origin: visibleTo?.length
				? {
						kind: "declared",
						detail: `${groupVisible !== undefined ? "group.roles" : "roles"}.${options.role}.visibleTo`,
					}
				: { kind: "absent", detail: "未配置，项目内所有人都看得见" },
		});
	}

	items.push({
		key: "wakeOnHandoff",
		label: "交接唤醒",
		value: loaded.config.wakeOnHandoff === true ? "叫醒目标会话" : "只落消息，不叫醒",
		origin:
			loaded.config.wakeOnHandoff !== undefined
				? { kind: "declared", detail: "wakeOnHandoff" }
				: { kind: "absent", detail: "未配置，默认不叫醒" },
	});

	const flow = resolveFlow(options.cwd, loaded.config, dirName);
	const flowLoaded = Boolean(readOptionalFile(flow.path));
	items.push({
		key: "flow",
		label: "流程文档",
		value: path.relative(options.cwd, flow.path) || flow.path,
		origin: flowLoaded ? flow.origin : { kind: "absent", detail: `${flow.origin.detail}，文件不在或为空` },
	});

	return {
		file: loaded.file,
		state: loaded.state,
		problems: loaded.problems,
		foreignKeys: loaded.foreignKeys,
		items,
	};
}

const STATE_TEXT: Record<LoadedConfig["state"], string> = {
	loaded: "读到",
	missing: "不存在（全部按兜底）",
	broken: "读不了（全部按兜底）",
};

const ORIGIN_PREFIX: Record<Origin["kind"], string> = {
	declared: "配置",
	fallback: "兜底",
	absent: "缺",
};

export function renderConfigReport(report: ConfigReport): string {
	const lines = [`项目配置：${report.file}（${STATE_TEXT[report.state]}）`];
	for (const item of report.items) {
		lines.push(`${item.label}：${item.value} ｜ ${ORIGIN_PREFIX[item.origin.kind]}：${item.origin.detail}`);
	}
	for (const problem of report.problems) lines.push(`⚠ ${problem}`);
	if (report.foreignKeys.length) {
		lines.push(`写了但不由 pi-peer 读取的键：${report.foreignKeys.join("、")}（别的扩展读，或写错了）`);
	}
	return lines.join("\n");
}

/**
 * 会话启动时该提的几句。判据：配置文件本身有问题就说；按兜底取到值的项也说，
 * 但只提「除项目标签之外还有别的」（项目标签总在兜底，单独为它每次都响等于噪声）。
 */
export function configWarnings(report: ConfigReport): string[] {
	const lines: string[] = [];
	lines.push(...report.problems.map((problem) => `${report.file}：${problem}`));

	const material = report.items.filter((item) => item.key !== "identity" && item.origin.kind === "fallback");
	const shown = material.length
		? material
		: report.state === "loaded"
			? report.items.filter((item) => item.key === "identity" && item.origin.kind === "fallback")
			: [];
	if (shown.length) {
		const detail = shown.map((item) => `${item.label} ${item.value}（${item.origin.detail}）`).join("；");
		lines.push(`按兜底生效：${detail}。用 /peer-config 看全`);
	}
	return lines;
}

// ── 解析单个路径 ────────────────────────────────────

export function declaredRoleNames(config: ProjectConfig): string[] {
	return [...new Set([...Object.keys(config.group?.roles ?? {}), ...Object.keys(config.roles ?? {})])].sort();
}

/** 扫目录得到的角色名：只认配置文件的兜底来源，报告里要跟「声明」分开说 */
export function discoverRoles(cwd: string, dirName = DEFAULT_CONFIG_DIR): string[] {
	try {
		return fs
			.readdirSync(path.join(cwd, dirName, "characters"))
			.filter((file) => file.endsWith(".md"))
			.map((file) => file.slice(0, -3))
			.filter(isValidRoleName);
	} catch {
		return [];
	}
}

/**
 * 角色卡：配置里声明了就用它，没声明才按 `<dir>/characters/<角色>.md` 找。
 * 两种来源分开记，因为它们对用户是两件事：「我配的生效了」和「它自己撞上的」。
 */
export function resolveRoleCard(
	cwd: string,
	config: ProjectConfig,
	role: string,
	dirName = DEFAULT_CONFIG_DIR,
): { path?: string; origin: Origin } {
	if (!isValidRoleName(role)) {
		return { origin: { kind: "absent", detail: `角色名非法：${JSON.stringify(role)}` } };
	}
	const configured = config.group?.roles?.[role]?.card ?? config.roles?.[role]?.card;
	const candidate = configured ?? path.join(dirName, "characters", `${role}.md`);
	const resolved = path.resolve(cwd, candidate);
	if (!isFile(resolved)) {
		return {
			origin: {
				kind: "absent",
				detail: configured
					? `配置指定 ${configured}，文件不在`
					: `${path.join(dirName, "characters")} 下没有 ${role}.md`,
			},
		};
	}
	return {
		path: resolved,
		origin: configured
			? { kind: "declared", detail: `roles.${role}.card` }
			: {
					kind: "fallback",
					detail: `roles 里没声明 ${role}，按 ${path.join(dirName, "characters", `${role}.md`)} 命中`,
				},
	};
}

export function resolveFlow(
	cwd: string,
	config: ProjectConfig,
	dirName = DEFAULT_CONFIG_DIR,
): { path: string; origin: Origin } {
	const configured = config.group?.flow ?? config.flow;
	if (configured) {
		return {
			path: path.resolve(cwd, configured),
			origin: { kind: "declared", detail: config.group?.flow ? "group.flow" : "flow" },
		};
	}
	const name = config.group?.name;
	const relative = name ? path.join(dirName, "flows", `${name}.md`) : path.join(dirName, "flow.md");
	return {
		path: path.resolve(cwd, relative),
		origin: {
			kind: "fallback",
			detail: name
				? `flow 没写，按 group.name 找 ${relative}`
				: `flow 没写、group.name 也没写，按 ${path.join(dirName, "flow.md")} 找`,
		},
	};
}

function isValidRoleName(role: string): boolean {
	return /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(role);
}

function isFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function readOptionalFile(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}
