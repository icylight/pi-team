/**
 * 台账的 HTML 视图。纯函数：不碰库、不碰网络，可单测。
 *
 * 服务端渲染 + 内联样式，不引前端依赖：本机看板不值得为它养一条构建链，
 * 关掉 JS 也能读；交互只有浏览器自带的折叠。
 */

import { formatAgo } from "../core/format.ts";
import type { ListedOrder, OrderEvent, OrderView, Requirement, StateRole, Waiting } from "../core/types.ts";

/** 一个库的只读快照；读不出来时只填 slug/name/dir/error */
export interface LedgerSnapshot {
	slug: string;
	name: string;
	dir: string;
	dbPath: string;
	ok: boolean;
	error?: string;
	states?: Record<StateRole, string>;
	requirement?: Requirement;
	orders?: ListedOrder[];
	waiting?: Waiting[];
	stale?: Waiting[];
}

export interface OrderPageData {
	slug: string;
	project: string;
	states: Record<StateRole, string>;
	view: OrderView;
	events: OrderEvent[];
}

export function renderIndex(ledgers: readonly LedgerSnapshot[], now: number): string {
	const total = ledgers.reduce((n, l) => n + (l.orders?.length ?? 0), 0);
	const open = ledgers.reduce((n, l) => n + openOrders(l).length, 0);
	const stale = ledgers.reduce((n, l) => n + (l.stale?.length ?? 0), 0);
	const meta = [
		`${ledgers.length} 个项目`,
		`未收口 ${open} / 共 ${total}`,
		stale ? `停滞 ${stale}` : "",
		`数据截至 ${clock(now)}`,
	]
		.filter(Boolean)
		.join(" · ");

	const sections = ledgers.map((ledger) => projectSection(ledger, now)).join("\n");
	return page(
		"工单总览",
		`<header><h1>工单总览</h1><p class="meta">${esc(meta)}</p></header>
<main>${sections || '<p class="empty">没找到工单库。用 <code>--root</code> 指到项目所在的目录。</p>'}</main>`,
	);
}

function projectSection(ledger: LedgerSnapshot, now: number): string {
	if (!ledger.ok) {
		return `<section>
<h2>${esc(ledger.name)}</h2>
<p class="path">${esc(ledger.dir)}</p>
<p class="error">读不出来：${esc(ledger.error ?? "未知原因")}</p>
</section>`;
	}
	const orders = ledger.orders ?? [];
	const states = ledger.states ?? ({} as Record<StateRole, string>);
	const open = openOrders(ledger);
	const closed = orders.filter((o) => !open.includes(o));
	const head = `<h2>${esc(ledger.name)}<span class="count">未收口 ${open.length} / 共 ${orders.length}</span></h2>
<p class="path">${esc(ledger.dir)}</p>${requirementLine(ledger.requirement)}`;

	return `<section id="${esc(ledger.slug)}">
${head}
${open.length ? table(open, states, ledger, now) : '<p class="empty">没有在办的单</p>'}
${
	closed.length
		? `<details><summary>已收口 / 已取消 ${closed.length}</summary>${table(closed, states, ledger, now)}</details>`
		: ""
}
</section>`;
}

function table(
	orders: readonly ListedOrder[],
	states: Record<StateRole, string>,
	ledger: LedgerSnapshot,
	now: number,
): string {
	const waiting = new Map((ledger.waiting ?? []).map((w) => [w.order.id, w]));
	const rows = orders
		.map((o) => {
			const w = waiting.get(o.id);
			const waited =
				w && w.kind !== "dependency"
					? `<span class="waited">等了 ${formatAgo(minutesSince(w.since, now))}</span>`
					: "";
			const deps = o.dependsOn.length
				? o.dependsOn
						.map((id) => {
							const up = orders.find((x) => x.id === id);
							const done = up && up.state === states.done;
							return `<a class="dep${done ? " dep-done" : ""}" href="/p/${esc(ledger.slug)}/o/${encodeURIComponent(id)}">${esc(id)}</a>`;
						})
						.join(" ")
				: '<span class="dim">-</span>';
			const actors = o.nextActors.length
				? `${esc(o.nextActors[0])}${o.nextActors.length > 1 ? `<span class="dim">（备选 ${esc(o.nextActors.slice(1).join("、"))}）</span>` : ""}`
				: '<span class="dim">（未指定）</span>';
			return `<tr>
<td class="id"><a href="/p/${esc(ledger.slug)}/o/${encodeURIComponent(o.id)}">${esc(o.id)}</a></td>
<td>${stateBadge(o.state, states)}</td>
<td>${actors}</td>
<td>${deps}</td>
<td class="title"><a href="/p/${esc(ledger.slug)}/o/${encodeURIComponent(o.id)}">${esc(o.title)}</a>${waited}</td>
<td class="when" title="${esc(o.updatedAt)}">${formatAgo(minutesSince(o.updatedAt, now))}</td>
</tr>`;
		})
		.join("\n");
	return `<table>
<thead><tr><th>id</th><th>状态</th><th>下一步</th><th>依赖</th><th>标题</th><th>改动</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

export function renderOrderPage(data: OrderPageData, now: number): string {
	const { view, states } = data;
	const fields = [
		stateBadge(view.state, states),
		`下一步找谁：${view.nextActors.length ? esc(view.nextActors.join("、")) : '<span class="dim">（未指定）</span>'}`,
		`rev ${view.revision}`,
		`建于 ${esc(view.createdAt.slice(0, 16).replace("T", " "))}`,
		`改于 ${esc(view.updatedAt.slice(0, 16).replace("T", " "))}（${formatAgo(minutesSince(view.updatedAt, now))} 前）`,
	];
	if (view.closingBasis) fields.push(`终止依据：${esc(view.closingBasis)}`);

	const parts: string[] = [];
	parts.push(`<header>
<p class="crumb"><a href="/#${esc(data.slug)}">← ${esc(data.project)}</a></p>
<h1>${esc(view.id)} · ${esc(view.title)}</h1>
<p class="meta">${fields.join(" · ")}</p>
</header>`);

	if (view.staleDeps.length) {
		parts.push(`<p class="error">上游已取消，这条的依赖失效，需要裁定：${view.staleDeps.map(esc).join("、")}</p>`);
	}

	const links: string[] = [];
	if (view.dependsOn.length)
		links.push(`<dt>依赖</dt><dd>${view.dependsOn.map((id) => orderLink(data.slug, id)).join(" ")}</dd>`);
	if (view.blocks.length)
		links.push(`<dt>下游</dt><dd>${view.blocks.map((id) => orderLink(data.slug, id)).join(" ")}</dd>`);
	if (view.contents.length) {
		links.push(
			`<dt>内容入口</dt><dd>${view.contents
				.map(
					(c) =>
						`<a href="/p/${esc(data.slug)}/f/${encodePath(c.path)}">${esc(c.name)}</a> <span class="dim">${esc(c.path)}</span>`,
				)
				.join("<br>")}</dd>`,
		);
	}
	if (links.length) parts.push(`<dl class="links">${links.join("")}</dl>`);

	if (view.body.trim()) parts.push(`<article class="body">${renderMarkdown(view.body)}</article>`);

	if (data.events.length) {
		const rows = data.events
			.slice()
			.reverse()
			.map((e) => {
				const move =
					e.fromState && e.toState ? `${esc(e.fromState)} → ${esc(e.toState)}` : esc(e.toState ?? e.kind);
				return `<tr><td class="when" title="${esc(e.at)}">${esc(e.at.slice(5, 16).replace("T", " "))}</td><td>${esc(e.actor)}</td><td>${move}</td><td class="note">${esc(e.note)}</td></tr>`;
			})
			.join("\n");
		parts.push(`<section><h2>动作记录</h2><table class="events">
<thead><tr><th>时间</th><th>谁</th><th>变化</th><th>为什么</th></tr></thead>
<tbody>${rows}</tbody></table></section>`);
	}

	return page(`${view.id} ${view.title}`, parts.join("\n"));
}

export function renderFilePage(name: string, relPath: string, content: string, slug: string): string {
	return page(
		relPath,
		`<header>
<p class="crumb"><a href="/#${esc(slug)}">← ${esc(name)}</a></p>
<h1>${esc(relPath)}</h1>
</header>
<article class="body">${renderMarkdown(content)}</article>`,
	);
}

export function renderMessagePage(title: string, message: string): string {
	return page(
		title,
		`<header><h1>${esc(title)}</h1><p class="error">${esc(message)}</p><p class="crumb"><a href="/">← 回到总览</a></p></header>`,
	);
}

// ── 内容渲染 ────────────────────────────────────────

function requirementLine(req?: Requirement): string {
	if (!req) return "";
	const bits = [req.goal, req.baseline ? `基线 ${req.baseline}` : ""].filter(Boolean);
	if (!bits.length) return "";
	return `<p class="goal">${esc(bits.join(" · "))}</p>`;
}

function openOrders(ledger: LedgerSnapshot): ListedOrder[] {
	const states = ledger.states;
	if (!states) return [];
	return (ledger.orders ?? []).filter((o) => o.state !== states.done && o.state !== states.cancelled);
}

/** 状态名是项目自己声明的，颜色得先反查角色 */
export function roleOfState(states: Record<StateRole, string>, state: string): StateRole | undefined {
	return (Object.keys(states) as StateRole[]).find((role) => states[role] === state);
}

function stateBadge(state: string, states: Record<StateRole, string>): string {
	const role = roleOfState(states, state);
	return `<span class="state s-${role ?? "unknown"}">${esc(state)}</span>`;
}

function orderLink(slug: string, id: string): string {
	return `<a href="/p/${esc(slug)}/o/${encodeURIComponent(id)}">${esc(id)}</a>`;
}

function encodePath(relPath: string): string {
	return relPath.split("/").map(encodeURIComponent).join("/");
}

function minutesSince(iso: string, now: number): number {
	const at = Date.parse(iso);
	return Number.isFinite(at) ? Math.max(0, (now - at) / 60_000) : 0;
}

function clock(now: number): string {
	const d = new Date(now);
	return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

export function esc(text: string): string {
	return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

/**
 * 极简 markdown：工单正文实际就用到标题、列表、引用、代码、粗体、链接这几种。
 * 先整行转义再做行内替换，替换出的标签才不会把原文里的尖括号带进来。
 */
export function renderMarkdown(text: string): string {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let inCode = false;
	let list: "ul" | "ol" | null = null;
	let para: string[] = [];

	const flushPara = () => {
		if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
		para = [];
	};
	const flushList = () => {
		if (list) out.push(`</${list}>`);
		list = null;
	};
	const openList = (kind: "ul" | "ol") => {
		if (list !== kind) {
			flushList();
			out.push(`<${kind}>`);
			list = kind;
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const line = raw.replace(/\s+$/, "");
		if (/^\s*```/.test(line)) {
			flushPara();
			flushList();
			out.push(inCode ? "</code></pre>" : "<pre><code>");
			inCode = !inCode;
			continue;
		}
		if (inCode) {
			out.push(esc(raw));
			continue;
		}
		if (!line.trim()) {
			flushPara();
			flushList();
			continue;
		}
		if (isTableRow(line) && isTableDivider(lines[i + 1] ?? "")) {
			flushPara();
			flushList();
			const head = splitCells(line);
			const rows: string[][] = [];
			for (i += 2; i < lines.length && isTableRow(lines[i]); i++) rows.push(splitCells(lines[i]));
			i--; // 外层循环还要再加一次
			out.push(tableHtml(head, rows));
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			flushPara();
			flushList();
			// 正文里的 # 比页面自己的 h1 低一级，别抢标题层级
			out.push(
				`<h${Math.min(6, heading[1].length + 1)}>${inline(heading[2])}</h${Math.min(6, heading[1].length + 1)}>`,
			);
			continue;
		}
		if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			flushPara();
			flushList();
			out.push("<hr>");
			continue;
		}
		const quote = /^>\s?(.*)$/.exec(line);
		if (quote) {
			flushPara();
			flushList();
			out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
			continue;
		}
		const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
		if (bullet) {
			flushPara();
			openList("ul");
			out.push(`<li>${inline(bullet[1])}</li>`);
			continue;
		}
		const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
		if (numbered) {
			flushPara();
			openList("ol");
			out.push(`<li>${inline(numbered[1])}</li>`);
			continue;
		}
		para.push(inline(line));
	}
	if (inCode) out.push("</code></pre>"); // 围栏没闭合：把已吞的关掉，别影响后面的段落
	flushPara();
	flushList();
	return out.join("\n");
}

function inline(text: string): string {
	return (
		esc(text)
			.replace(/`([^`]+)`/g, "<code>$1</code>")
			// 非贪婪：粗体里套行内代码时，代码里的单星号（data-* 之类）不该截断匹配
			.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
			.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) =>
				// 只认绝对 http(s)：相对路径指不到东西，其它协议（javascript: 之类）更不该进 href
				/^https?:\/\//i.test(href)
					? `<a href="${href}" rel="noreferrer noopener" target="_blank">${label}</a>`
					: `${label} (${href})`,
			)
	);
}

// ── 页面骨架 ────────────────────────────────────────

const STYLE = `
:root { color-scheme: light dark; --fg:#1c1c1e; --muted:#6b7280; --bg:#ffffff; --card:#f8f9fa; --line:#e5e7eb; --accent:#2563eb; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e5e7eb; --muted:#9aa0a6; --bg:#16181c; --card:#1d2026; --line:#2c313a; --accent:#7aa2f7; }
}
* { box-sizing: border-box; }
body { margin:0 auto; padding:32px 24px 64px; max-width:1080px; background:var(--bg); color:var(--fg);
  font:15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
h1 { font-size:22px; margin:0 0 8px; }
h2 { font-size:17px; margin:32px 0 6px; border-bottom:1px solid var(--line); padding-bottom:6px; }
h3,h4,h5 { font-size:15px; margin:20px 0 6px; }
a { color:var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }
.meta, .path, .goal, .dim { color:var(--muted); font-size:13px; }
.meta { margin:0 0 4px; }
.path, .goal { margin:0 0 8px; font-family:ui-monospace, Menlo, Consolas, monospace; font-size:12px; }
.goal { font-family:inherit; }
.crumb { margin:0 0 8px; font-size:13px; }
.count { float:right; color:var(--muted); font-size:13px; font-weight:400; }
.empty { color:var(--muted); }
.error { color:#c2410c; }
table { border-collapse:collapse; width:100%; margin:10px 0 4px; font-size:14px; }
th { text-align:left; font-weight:600; font-size:12px; color:var(--muted); border-bottom:1px solid var(--line); padding:6px 8px; white-space:nowrap; }
td { padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
td.id, td.when, td.note { white-space:nowrap; color:var(--muted); font-size:12px; }
td.id a { font-family:ui-monospace, Menlo, Consolas, monospace; }
td.title { width:100%; }
td.note { white-space:normal; }
td.when { font-family:ui-monospace, Menlo, Consolas, monospace; }
tr:last-child td { border-bottom:none; }
.state { display:inline-block; padding:1px 8px; border-radius:10px; font-size:12px; white-space:nowrap; border:1px solid transparent; }
.s-claimable { background:#e5e7eb; color:#374151; }
.s-active    { background:#dbeafe; color:#1e40af; }
.s-review    { background:#ede9fe; color:#5b21b6; }
.s-rework    { background:#fee2e2; color:#991b1b; }
.s-paused    { background:#ffedd5; color:#9a3412; }
.s-done      { background:#dcfce7; color:#166534; }
.s-cancelled { background:#e5e7eb; color:#4b5563; }
.s-unknown   { background:transparent; border-color:var(--line); color:var(--muted); }
@media (prefers-color-scheme: dark) {
  .state { filter:saturate(.9) brightness(.95); }
}
.waited { color:#b45309; font-size:12px; margin-left:8px; }
.dep-done { color:var(--muted); }
dl.links { display:grid; grid-template-columns:88px 1fr; gap:4px 12px; margin:16px 0; padding:12px 14px; background:var(--card); border-radius:8px; font-size:13px; }
dl.links dt { color:var(--muted); }
dl.links dd { margin:0; }
article.body { margin:18px 0; }
article.body p { margin:0 0 12px; }
article.body ul, article.body ol { margin:0 0 12px; padding-left:24px; }
article.body li { margin:0 0 4px; }
article.body code { background:var(--card); padding:1px 5px; border-radius:4px; font-family:ui-monospace, Menlo, Consolas, monospace; font-size:13px; }
article.body pre { background:var(--card); padding:12px 14px; border-radius:8px; overflow-x:auto; }
article.body pre code { background:none; padding:0; }
article.body table.md { font-size:13px; margin:0 0 14px; }
article.body table.md th, article.body table.md td { border:1px solid var(--line); padding:4px 9px; }
article.body table.md th { background:var(--card); font-weight:600; }
article.body blockquote { margin:0 0 12px; padding:2px 0 2px 12px; border-left:3px solid var(--line); color:var(--muted); }
article.body hr { border:none; border-top:1px solid var(--line); margin:20px 0; }
details { margin:14px 0; }
summary { cursor:pointer; color:var(--muted); font-size:13px; }
`;

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function isTableRow(line: string): boolean {
	return /^\s*\|.*\|\s*$/.test(line);
}

/** 分隔行必须带竖线：否则正文里的 --- 会被当成表格头 */
function isTableDivider(line: string): boolean {
	if (!line.includes("|")) return false;
	const cells = splitCells(line);
	return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function splitCells(line: string): string[] {
	return line
		.trim()
		.replace(/^\||\|$/g, "")
		.split("|")
		.map((c) => c.trim());
}

function tableHtml(head: readonly string[], rows: readonly (readonly string[])[]): string {
	const th = head.map((c) => `<th>${inline(c)}</th>`).join("");
	const body = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("\n");
	return `<table class="md"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}
