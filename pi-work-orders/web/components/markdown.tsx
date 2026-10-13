import type { ReactNode } from "react";

/**
 * 极简 markdown：工单正文实际就用到标题、列表、引用、代码、粗体、链接、表格这几种。
 *
 * 与旧 SSR 版同行为，改成返回 React 节点后由 React 负责转义——不再手拼 HTML 字符串。
 * 支持：标题、列表、引用、围栏代码、粗体、行内代码、链接（只认 http(s)）、分隔线、表格。
 */
export function Markdown({ text }: { text: string }) {
	return <>{renderBlocks(text)}</>;
}

function renderBlocks(text: string): ReactNode[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const out: ReactNode[] = [];
	let inCode = false;
	let code: string[] = [];
	let list: { kind: "ul" | "ol"; items: ReactNode[][]; key: number } | null = null;
	let para: ReactNode[][] = [];
	let key = 0;

	const flushPara = () => {
		if (para.length) {
			out.push(
				<p key={`p${key++}`}>
					{para.map((chunk, i) => (
						<span key={`s${i}`}>
							{i > 0 ? <br /> : null}
							{chunk}
						</span>
					))}
				</p>,
			);
		}
		para = [];
	};
	const flushList = () => {
		if (list) {
			const Tag = list.kind;
			out.push(
				<Tag key={`l${key++}`} className={list.kind === "ul" ? "my-2 list-disc pl-5" : "my-2 list-decimal pl-5"}>
					{list.items.map((item, i) => (
						<li key={`li${i}`}>{item}</li>
					))}
				</Tag>,
			);
		}
		list = null;
	};
	const openList = (kind: "ul" | "ol") => {
		if (!list || list.kind !== kind) {
			flushList();
			list = { kind, items: [], key: key++ };
		}
		return list;
	};

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const line = raw.replace(/\s+$/, "");
		if (/^\s*```/.test(line)) {
			flushPara();
			flushList();
			if (inCode) {
				out.push(
					<pre key={`c${key++}`} className="my-2 overflow-x-auto rounded-lg bg-muted p-3">
						<code>{code.join("\n")}</code>
					</pre>,
				);
				code = [];
			}
			inCode = !inCode;
			continue;
		}
		if (inCode) {
			code.push(raw);
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
			i--;
			out.push(<MarkdownTable key={`t${key++}`} head={head} rows={rows} />);
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			flushPara();
			flushList();
			const level = Math.min(6, heading[1].length + 1);
			const Tag = `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
			out.push(
				<Tag key={`h${key++}`} className={headingClass(level)}>
					{inline(heading[2])}
				</Tag>,
			);
			continue;
		}
		if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			flushPara();
			flushList();
			out.push(<hr key={`hr${key++}`} />);
			continue;
		}
		const quote = /^>\s?(.*)$/.exec(line);
		if (quote) {
			flushPara();
			flushList();
			out.push(
				<blockquote key={`q${key++}`} className="my-2 border-l-2 pl-3 text-muted-foreground">
					{inline(quote[1])}
				</blockquote>,
			);
			continue;
		}
		const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
		if (bullet) {
			flushPara();
			openList("ul").items.push(inline(bullet[1]));
			continue;
		}
		const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
		if (numbered) {
			flushPara();
			openList("ol").items.push(inline(numbered[1]));
			continue;
		}
		para.push(inline(line));
	}
	if (inCode) {
		out.push(
			<pre key={`c${key++}`} className="my-2 overflow-x-auto rounded-lg bg-muted p-3">
				<code>{code.join("\n")}</code>
			</pre>,
		);
	}
	flushPara();
	flushList();
	return out;
}

function headingClass(level: number): string {
	if (level <= 2) return "mt-6 mb-2 text-lg font-semibold";
	if (level === 3) return "mt-5 mb-1.5 text-base font-semibold";
	return "mt-4 mb-1 text-sm font-semibold";
}

function MarkdownTable({ head, rows }: { head: string[]; rows: string[][] }) {
	return (
		<table className="my-3 w-full border-collapse text-sm">
			<thead>
				<tr>
					{head.map((c, i) => (
						<th key={`th${i}`} className="border bg-muted/50 px-2.5 py-1 text-left font-semibold">
							{inline(c)}
						</th>
					))}
				</tr>
			</thead>
			<tbody>
				{rows.map((r, ri) => (
					<tr key={`tr${ri}`}>
						{r.map((c, ci) => (
							<td key={`td${ci}`} className="border px-2.5 py-1">
								{inline(c)}
							</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	);
}

/** 行内：行内代码、粗体、链接。React 自动转义文本，不用手抄旧版的 esc()。 */
function inline(text: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	// 逐段匹配行内语法；未匹配的原文原样输出
	const re = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
	let last = 0;
	let m: RegExpExecArray | null;
	let key = 0;
	while ((m = re.exec(text)) !== null) {
		if (m.index > last) nodes.push(text.slice(last, m.index));
		if (m[1] !== undefined) {
			nodes.push(
				<code key={`c${key++}`} className="rounded bg-muted px-1 py-0.5 font-mono text-[13px]">
					{m[1]}
				</code>,
			);
		} else if (m[2] !== undefined) {
			nodes.push(<strong key={`b${key++}`}>{m[2]}</strong>);
		} else if (m[3] !== undefined && m[4] !== undefined) {
			// 只认绝对 http(s)：相对路径指不到东西，其它协议更不该进 href
			if (/^https?:\/\//i.test(m[4])) {
				nodes.push(
					<a
						key={`a${key++}`}
						href={m[4]}
						rel="noreferrer noopener"
						target="_blank"
						className="text-primary hover:underline"
					>
						{m[3]}
					</a>,
				);
			} else {
				nodes.push(`${m[3]} (${m[4]})`);
			}
		}
		last = re.lastIndex;
	}
	if (last < text.length) nodes.push(text.slice(last));
	return nodes;
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