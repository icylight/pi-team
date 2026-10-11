/**
 * 工单看板的本地服务。
 *
 * 独立进程，不挂在 pi 会话上：会话开开关关，看板还在；扫的是全机，换项目也不用重启。
 * 只绑 127.0.0.1，库一律只读打开——看板只负责看，改台账仍归工具和命令。
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { eventsOf, openLedger, statesOf } from "../core/schema.ts";
import { getOrder, listOrders, requirementOf, staleWaiting, waitingOrders } from "../core/store.ts";
import { STALE_MINUTES } from "../core/types.ts";
import { type LedgerSnapshot, renderFilePage, renderIndex, renderMessagePage, renderOrderPage } from "./render.ts";
import { discoverLedgers, type LedgerRef } from "./scan.ts";

const SERVICE = "pi-work-orders-web";
const DEFAULT_PORT = 8787;

interface Options {
	port: number;
	roots: string[];
	open: boolean;
	stop: boolean;
	help: boolean;
}

const HELP = `工单看板：在一个页面里看本机所有项目的工单库（只读）。

用法：node serve.ts [选项]

选项：
  --port <n>     监听端口，默认 ${DEFAULT_PORT}（环境变量 PI_WORK_ORDERS_WEB_PORT 同效）
  --root <dir>   扫描根，可重复；默认取当前目录与 $CODE_ROOT（缺省 ~/code）
  --open         就绪后打开浏览器
  --stop         停掉该端口上已在跑的看板
  -h, --help     显示这段
`;

function parseArgs(argv: readonly string[]): Options {
	const options: Options = { port: portFromEnv(), roots: [], open: false, stop: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--port") {
			const value = Number(argv[++i]);
			if (!Number.isInteger(value) || value <= 0 || value > 65535)
				fail(`--port 要给 1-65535 的整数，收到：${argv[i]}`);
			options.port = value;
		} else if (arg === "--root") {
			const value = argv[++i];
			if (!value) fail("--root 后面要跟目录");
			options.roots.push(path.resolve(value));
		} else if (arg === "--open") {
			options.open = true;
		} else if (arg === "--stop") {
			options.stop = true;
		} else if (arg === "-h" || arg === "--help") {
			options.help = true;
		} else {
			fail(`不认识这个参数：${arg}（-h 看用法）`);
		}
	}
	return options;
}

function portFromEnv(): number {
	const value = Number(process.env.PI_WORK_ORDERS_WEB_PORT?.trim());
	return Number.isInteger(value) && value > 0 && value <= 65535 ? value : DEFAULT_PORT;
}

function staleMinutes(): number {
	const value = Number(process.env.PI_WORK_ORDERS_STALE_MINUTES?.trim());
	return Number.isFinite(value) && value > 0 ? value : STALE_MINUTES;
}

function fail(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

/** 扫描根：显式给的优先，否则当前目录加上代码根目录 */
function scanRoots(explicit: readonly string[]): string[] {
	if (explicit.length) return [...explicit];
	const codeRoot = process.env.CODE_ROOT?.trim() || path.join(os.homedir(), "code");
	const roots = [process.cwd(), codeRoot];
	const fromEnv = process.env.PI_WORK_ORDERS_WEB_ROOTS;
	if (fromEnv) roots.push(...fromEnv.split(path.delimiter));
	return roots.map((r) => path.resolve(r.trim())).filter(Boolean);
}

// ── 取数 ────────────────────────────────────────────

function snapshot(ref: LedgerRef): LedgerSnapshot {
	const base: LedgerSnapshot = { slug: ref.slug, name: ref.name, dir: ref.dir, dbPath: ref.dbPath, ok: false };
	let db: DatabaseSync | undefined;
	try {
		// 只读打开，不迁移：看板不动库文件（schema 落后的库也因此读不了，提示里去项目里升）
		db = openLedger(ref.dbPath, true);
		return {
			...base,
			ok: true,
			states: statesOf(db),
			requirement: requirementOf(db),
			orders: listOrders(db, { history: true }),
			waiting: waitingOrders(db),
			stale: staleWaiting(db, staleMinutes()),
		};
	} catch (error) {
		return { ...base, error: readableError(message(error), ref.dir) };
	} finally {
		db?.close();
	}
}

/** 库版本旧时补上怎么升：光看「只读打开」这句，不知道下一步该干什么 */
function readableError(text: string, dir: string): string {
	if (!/库版本|库需要从/.test(text)) return text;
	return `${text}。在 ${dir} 里跑一次 /orders（或让 pi 打开这个项目）就会自动升级`;
}

function withLedger<T>(ref: LedgerRef, fn: (db: DatabaseSync) => T): T {
	const db = openLedger(ref.dbPath, true);
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ── 路由 ────────────────────────────────────────────

function handle(req: http.IncomingMessage, res: http.ServerResponse, options: Options): void {
	// 只认本机名：浏览器里的恶意页面可能把请求指到 localhost，别给它读到台账
	const host = (req.headers.host ?? "").split(":")[0].replace(/^\[|\]$/g, "");
	if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
		send(res, 403, renderMessagePage("拒绝访问", "只接受来自本机 localhost 的请求"));
		return;
	}

	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const pathname = url.pathname;

	if (pathname === "/healthz") {
		const refs = discoverLedgers(scanRoots(options.roots));
		sendJson(res, { service: SERVICE, version: 1, port: options.port, projects: refs.length });
		return;
	}

	if (pathname === "/shutdown") {
		if (req.method !== "POST") {
			send(res, 405, renderMessagePage("拒绝访问", "停止服务要用 POST"));
			return;
		}
		// 响应一写完就收摊。保持连接不能等它自然断：浏览器和探测端都留着 keep-alive，
		// 等下去 server.close() 的回调永远不来，stop 就成了「慢慢退出」。
		res.on("finish", () => {
			server.closeAllConnections();
			server.close(() => process.exit(0));
			setTimeout(() => process.exit(0), 200).unref();
		});
		sendJson(res, { stopped: true });
		return;
	}

	const refs = discoverLedgers(scanRoots(options.roots));

	if (pathname === "/") {
		send(res, 200, renderIndex(refs.map(snapshot), Date.now()));
		return;
	}

	const order = /^\/p\/([^/]+)\/o\/([^/]+)\/?$/.exec(pathname);
	if (order) {
		const ref = refs.find((r) => r.slug === decode(order[1]));
		const id = decode(order[2]);
		if (!ref) {
			send(res, 404, renderMessagePage("没有这个项目", `找不到 ${order[1]}；刷新总览页看看有哪些项目`));
			return;
		}
		try {
			const [view, events, states] = withLedger(
				ref,
				(db) => [getOrder(db, id), eventsOf(db, id, 20), statesOf(db)] as const,
			);
			send(res, 200, renderOrderPage({ slug: ref.slug, project: ref.name, states, view, events }, Date.now()));
		} catch (error) {
			send(res, 404, renderMessagePage("读不到这条工单", message(error)));
		}
		return;
	}

	const file = /^\/p\/([^/]+)\/f\/(.+)$/.exec(pathname);
	if (file) {
		const ref = refs.find((r) => r.slug === decode(file[1]));
		if (!ref) {
			send(res, 404, renderMessagePage("没有这个项目", `找不到 ${file[1]}`));
			return;
		}
		const rel = decode(file[2]);
		const abs = path.resolve(ref.dir, rel);
		const inside = path.relative(ref.dir, abs);
		// 内容入口的路径来自库，库可能被改脏：读出项目目录之外的文件或非 md，一律拒绝
		if (inside.startsWith("..") || path.isAbsolute(inside) || !/\.(md|markdown|txt)$/i.test(abs)) {
			send(res, 403, renderMessagePage("拒绝访问", `只读项目内的 markdown：${rel}`));
			return;
		}
		try {
			send(res, 200, renderFilePage(ref.name, rel, fs.readFileSync(abs, "utf8"), ref.slug));
		} catch (error) {
			send(res, 404, renderMessagePage("读不到这份文件", `${rel}：${message(error)}`));
		}
		return;
	}

	send(res, 404, renderMessagePage("没有这个地址", pathname));
}

function decode(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

function send(res: http.ServerResponse, status: number, html: string): void {
	res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	res.end(html);
}

function sendJson(res: http.ServerResponse, body: unknown): void {
	res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

// ── 启动 / 停止 ─────────────────────────────────────

function openBrowser(url: string): void {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		spawn(command, args, { detached: true, stdio: "ignore" }).unref();
	} catch {
		// 打不开不算失败：地址已经打出来了，手动点一样
	}
}

async function requestStop(port: number): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const req = http.request({ host: "127.0.0.1", port, path: "/shutdown", method: "POST", timeout: 1000 }, (res) => {
			res.resume();
			resolve(res.statusCode === 200);
		});
		req.on("error", () => resolve(false));
		req.on("timeout", () => {
			req.destroy();
			resolve(false);
		});
		req.end();
	});
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
	process.stdout.write(HELP);
	process.exit(0);
}

if (options.stop) {
	const stopped = await requestStop(options.port);
	if (!stopped) {
		process.stderr.write(`端口 ${options.port} 上没有在跑的看板\n`);
		process.exit(1);
	}
	process.stdout.write(`已停止 ${options.port} 上的看板\n`);
	process.exit(0);
}

const server = http.createServer((req, res) => {
	try {
		handle(req, res, options);
	} catch (error) {
		send(res, 500, renderMessagePage("看板出错", message(error)));
	}
});

server.on("error", (error: NodeJS.ErrnoException) => {
	if (error.code === "EADDRINUSE") {
		process.stderr.write(`端口 ${options.port} 已被占用：先 --stop 停掉，或用 --port 换一个\n`);
		process.exit(1);
	}
	fail(`服务起不来：${error.message}`);
});

server.listen(options.port, "127.0.0.1", () => {
	const url = `http://127.0.0.1:${options.port}/`;
	const roots = scanRoots(options.roots);
	process.stdout.write(`${SERVICE} 已在 ${url} 上跑\n扫描根：${roots.join("、")}\n`);
	if (options.open) openBrowser(url);
});
