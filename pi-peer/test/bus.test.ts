import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import extension from "../index.ts";
import { cwdKey, PeerStore } from "../store.ts";

/**
 * 跨包协议：别的扩展（pi-work-orders）通过事件总线叫人、问身份。
 *
 * 这里把一个假 pi 挂上真扩展，验四个频道的往返语义。协议两边同时改，这边会红。
 */
function mountPeer(cwd: string, peerRoot: string) {
	const handlers = new Map();
	const channels = new Map();
	const tools = new Map();
	const commands = new Map();
	const renderers = new Map();
	const notes: string[] = [];
	const entries: { type: string; customType: string; data: unknown }[] = [];
	const sent: { message: { customType: string; content: unknown }; options: unknown }[] = [];
	const modelCalls: string[] = [];
	const thinkingCalls: string[] = [];
	const pi = {
		setModel: async (model: { provider: string; id: string }) => {
			modelCalls.push(`${model.provider}/${model.id}`);
			return true;
		},
		setThinkingLevel: (level: string) => thinkingCalls.push(level),
		registerTool: (def: { name: string }) => tools.set(def.name, def),
		registerCommand: (name: string, options: unknown) => commands.set(name, options),
		registerMessageRenderer: (name: string, renderer: unknown) => renderers.set(name, renderer),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message: { customType: string; content: unknown }, options: unknown) =>
			sent.push({ message, options }),
		on: (name: string, fn: unknown) => handlers.set(name, fn),
		getSessionName: () => "sender",
		events: {
			emit: (channel: string, data: unknown) => {
				for (const fn of channels.get(channel) ?? []) (fn as (d: unknown) => void)(data);
			},
			on: (channel: string, fn: (data: unknown) => void) => {
				channels.set(channel, [...(channels.get(channel) ?? []), fn]);
				return () => {};
			},
		},
	};

	const previousCwd = process.cwd();
	const previousRoot = process.env.PI_PEER_ROOT;
	process.env.PI_PEER_ROOT = peerRoot;
	process.chdir(cwd);
	extension(pi);
	return {
		handlers,
		channels,
		tools,
		commands,
		renderers,
		notes,
		entries,
		sent,
		modelCalls,
		thinkingCalls,
		restore() {
			// 先让扩展自己收尾：session_start 开了 fs.watch 与定时器，不关掉测试进程不退出
			(handlers.get("session_shutdown") as (() => Promise<void> | void) | undefined)?.();
			process.chdir(previousCwd);
			if (previousRoot === undefined) delete process.env.PI_PEER_ROOT;
			else process.env.PI_PEER_ROOT = previousRoot;
		},
	};
}

test("peer 渲染器提取文本块并跳过图片", () => {
	const { cwd, peerRoot } = tmpPair();
	const peer = mountPeer(cwd, peerRoot);
	try {
		const render = peer.renderers.get("peer");
		const component = render(
			{
				content: [
					{ type: "text", text: "[peer] from dev\n\n第一段" },
					{ type: "image", data: "synthetic", mimeType: "image/png" },
					{ type: "text", text: "第二段" },
				],
				details: { fromName: "dev", fromModel: "test/model" },
			},
			{ outputPad: 0 },
			{ fg: (_color: string, text: string) => text },
		);
		assert.deepEqual(
			component.render(80).map((line: string) => line.trimEnd()),
			["⇄ dev · test/model", "第一段", "第二段"],
		);
	} finally {
		peer.restore();
	}
});

test("收到消息：类型名用来源名，标注行压到一行", async () => {
	const { cwd, peerRoot, store } = tmpPair();
	const peer = mountPeer(cwd, peerRoot);
	try {
		await (peer.handlers.get("session_start") as (e: unknown, c: unknown) => Promise<void>)?.({}, ctxFor(cwd));
		const selfKey = fs.readdirSync(store.membersDir).map((file) => file.replace(/\.json$/, ""))[0];
		store.send({
			id: "msg-1",
			from: "9000-aaaa",
			fromName: "dev",
			fromModel: "test/model",
			to: selfKey,
			thread: "msg-1",
			text: "T188 已由 qa 收口",
			ts: Date.now(),
		});
		// 收信靠轮询兜底（watch 只装在启动时已存在的目录上），等一个轮询周期
		await new Promise((resolve) => setTimeout(resolve, 2500));
		assert.equal(peer.sent.length, 1);
		assert.equal(peer.sent[0].message.customType, "dev", "tree 与气泡都拿类型名当来源标签");
		assert.match(String(peer.sent[0].message.content), /^\[peer dev\]\n\nT188 已由 qa 收口/);
		assert.ok(peer.renderers.has("dev"), "来源类型要当场注册，否则气泡落到默认样式");
	} finally {
		peer.restore();
	}
});

test("重启后按历史条目补注册来源类型", async () => {
	const { cwd, peerRoot } = tmpPair();
	const peer = mountPeer(cwd, peerRoot);
	try {
		const history = [
			{ type: "custom_message", customType: "dev", details: { from: "9000-aaaa", fromName: "dev" } },
			{ type: "custom_message", customType: "peer", details: { from: "9000-aaaa", fromName: "qa" } },
			{ type: "custom_message", customType: "other-ext" },
		];
		await (peer.handlers.get("session_start") as (e: unknown, c: unknown) => Promise<void>)?.(
			{},
			ctxFor(cwd, [], history),
		);
		assert.ok(peer.renderers.has("dev"), "历史消息重放前要认出来源");
		assert.ok(!peer.renderers.has("other-ext"), "别的扩展的自定义消息不该被 peer 接管");
	} finally {
		peer.restore();
	}
});

for (const [name, content, expected] of [
	["字符串保留正文并去掉 peer 头", "[peer] from dev\n\n正文", ["⇄ peer · ?", "正文"]],
	["空字符串", "", ["⇄ peer · ?", ""]],
	["空数组", [], ["⇄ peer · ?", ""]],
	["仅图片", [{ type: "image", data: "synthetic", mimeType: "image/png" }], ["⇄ peer · ?", ""]],
] as const) {
	test(`peer 渲染器：${name}`, () => {
		const { cwd, peerRoot } = tmpPair();
		const peer = mountPeer(cwd, peerRoot);
		try {
			const component = peer.renderers.get("peer")(
				{ content },
				{ outputPad: 0 },
				{ fg: (_color: string, text: string) => text },
			);
			assert.deepEqual(
				component.render(80).map((line: string) => line.trimEnd()),
				expected,
			);
		} finally {
			peer.restore();
		}
	});
}

/** 造一个在线的角色会话成员，pid 用当前进程（必活） */
function liveMember(peerRoot: string, cwd: string, key: string, name: string, extra: Record<string, unknown> = {}) {
	const store = new PeerStore(peerRoot, cwd);
	fs.mkdirSync(store.membersDir, { recursive: true });
	fs.writeFileSync(
		path.join(store.membersDir, `${key}.json`),
		JSON.stringify({
			key,
			name,
			role: name,
			roleSlot: name,
			model: "test/model",
			pid: process.pid,
			cwd,
			lastSeen: Date.now(),
			startedAt: Date.now(),
			...extra,
		}),
	);
	return store;
}

/** peer 的 session_start 要读 cwd / 模型 / 会话文件，给个够用的壳 */
function ctxFor(cwd: string, notes: string[] = [], history: unknown[] = []) {
	return {
		cwd,
		hasUI: true,
		model: { provider: "test", id: "model" },
		sessionManager: {
			getSessionFile: () => path.join(cwd, "session.jsonl"),
			getEntries: () => history,
		},
		ui: {
			notify: (message: string) => notes.push(message),
			setStatus: () => {},
			theme: { fg: (_c: string, t: string) => t },
		},
	};
}

function tmpPair() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "peer-bus-"));
	const cwd = path.join(base, "project");
	const peerRoot = path.join(base, "peers");
	fs.mkdirSync(cwd, { recursive: true });
	return { cwd, peerRoot, store: new PeerStore(peerRoot, cwd) };
}

test("peer:deliver 投给第一个在线的候选，并写进对方收件箱", async () => {
	const { cwd, peerRoot, store } = tmpPair();
	const peer = mountPeer(cwd, peerRoot);
	try {
		const results: Record<string, unknown>[] = [];
		peer.channels.set("peer:deliver:result", [(data) => results.push(data as Record<string, unknown>)]);
		await (peer.handlers.get("session_start") as (e: unknown, c: unknown) => Promise<void>)?.({}, ctxFor(cwd));
		liveMember(peerRoot, cwd, "9000-aaaa", "dev");

		for (const fn of (peer.channels.get("peer:deliver") ?? []) as ((d: unknown) => void)[]) {
			fn({ id: "req-1", targets: ["owner", "dev"], text: "T01 交到你手上" });
		}
		assert.equal(results.length, 1);
		assert.equal(results[0].ok, true);
		assert.equal(results[0].to, "dev");

		const inbox = store.drain("9000-aaaa");
		assert.equal(inbox.length, 1);
		assert.match(inbox[0].text, /T01 交到你手上/);
	} finally {
		peer.restore();
	}
});

test("候选都不在线：回失败，且不写进任何收件箱", async () => {
	const { cwd, peerRoot, store } = tmpPair();
	const peer = mountPeer(cwd, peerRoot);
	try {
		const results: Record<string, unknown>[] = [];
		peer.channels.set("peer:deliver:result", [(data) => results.push(data as Record<string, unknown>)]);
		await (peer.handlers.get("session_start") as (e: unknown, c: unknown) => Promise<void>)?.({}, ctxFor(cwd));

		for (const fn of (peer.channels.get("peer:deliver") ?? []) as ((d: unknown) => void)[]) {
			fn({ id: "req-2", targets: ["dev", "qa"], text: "没人接" });
		}
		assert.equal(results.length, 1, "失败也必须回，否则调用方等超时");
		assert.equal(results[0].ok, false);
		assert.match(String(results[0].detail), /都不在线/);
		assert.equal(fs.existsSync(path.join(store.dir, "pending", "9000-aaaa")), false);
	} finally {
		peer.restore();
	}
});

test("peer:whoami 回当前会话的名字", async () => {
	const { cwd, peerRoot } = tmpPair();
	const peer = mountPeer(cwd, peerRoot);
	try {
		await (peer.handlers.get("session_start") as (e: unknown, c: unknown) => Promise<void>)?.({}, ctxFor(cwd));
		const replies: Record<string, unknown>[] = [];
		peer.channels.set("peer:whoami:result", [(data) => replies.push(data as Record<string, unknown>)]);

		for (const fn of (peer.channels.get("peer:whoami") ?? []) as ((d: unknown) => void)[]) {
			fn({ id: "ask-1" });
		}
		assert.equal(replies.length, 1);
		assert.equal(replies[0].id, "ask-1");
		assert.ok(typeof replies[0].name === "string");
	} finally {
		peer.restore();
	}
});

test("requireIdle：对方在忙时不投，回忙的原因", async () => {
	const { cwd, peerRoot, store } = tmpPair();
	const peer = mountPeer(cwd, peerRoot);
	try {
		const results: Record<string, unknown>[] = [];
		peer.channels.set("peer:deliver:result", [(data) => results.push(data as Record<string, unknown>)]);
		await (peer.handlers.get("session_start") as (e: unknown, c: unknown) => Promise<void>)?.({}, ctxFor(cwd));
		// 在线的 dev，但正在跑一轮
		liveMember(peerRoot, cwd, "9100-bbbb", "dev", { busy: true, busySince: Date.now() });

		for (const fn of (peer.channels.get("peer:deliver") ?? []) as ((d: unknown) => void)[]) {
			fn({ id: "req-idle", targets: ["dev"], text: "该你了", requireIdle: true });
		}
		assert.equal(results.length, 1);
		assert.equal(results[0].ok, false);
		assert.match(String(results[0].detail), /在忙/);
		assert.equal(store.drain("9100-bbbb").length, 0, "忙就不该落进收件箱");
	} finally {
		peer.restore();
	}
});

test("requireIdle：空闲的照常投", async () => {
	const { cwd, peerRoot, store } = tmpPair();
	const peer = mountPeer(cwd, peerRoot);
	try {
		const results: Record<string, unknown>[] = [];
		peer.channels.set("peer:deliver:result", [(data) => results.push(data as Record<string, unknown>)]);
		await (peer.handlers.get("session_start") as (e: unknown, c: unknown) => Promise<void>)?.({}, ctxFor(cwd));
		liveMember(peerRoot, cwd, "9200-cccc", "dev", { busy: false });

		for (const fn of (peer.channels.get("peer:deliver") ?? []) as ((d: unknown) => void)[]) {
			fn({ id: "req-free", targets: ["dev"], text: "该你了", requireIdle: true });
		}
		assert.equal(results[0].ok, true);
		assert.equal(store.drain("9200-cccc").length, 1);
	} finally {
		peer.restore();
	}
});

test("不传 requireIdle 时照常投给在忙的（手动消息不受限）", async () => {
	const { cwd, peerRoot } = tmpPair();
	const peer = mountPeer(cwd, peerRoot);
	try {
		const results: Record<string, unknown>[] = [];
		peer.channels.set("peer:deliver:result", [(data) => results.push(data as Record<string, unknown>)]);
		await (peer.handlers.get("session_start") as (e: unknown, c: unknown) => Promise<void>)?.({}, ctxFor(cwd));
		liveMember(peerRoot, cwd, "9300-dddd", "dev", { busy: true, busySince: Date.now() });

		for (const fn of (peer.channels.get("peer:deliver") ?? []) as ((d: unknown) => void)[]) {
			fn({ id: "req-plain", targets: ["dev"], text: "插一句" });
		}
		assert.equal(results[0].ok, true);
	} finally {
		peer.restore();
	}
});

test("桶名由 cwd 决定：同一目录的会话落在同一个桶", () => {
	const { cwd } = tmpPair();
	assert.equal(new PeerStore("/tmp/peers", cwd).dir, path.join("/tmp/peers", cwdKey(cwd)));
});

/** 调一个注册进来的工具，拿回文本 */
async function callTool(
	tools: Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }>,
	name: string,
	params: Record<string, unknown>,
	cwd: string,
) {
	const tool = tools.get(name);
	assert.ok(tool, `工具未注册：${name}`);
	const out = await tool.execute("call-1", params, undefined, undefined, ctxFor(cwd));
	return out.content.map((c) => c.text).join("\n");
}

test("peer_list 列得出同项目与跨项目的会话，忙闲看着对", async () => {
	const { cwd, peerRoot } = tmpPair();
	const otherCwd = path.join(path.dirname(cwd), "other-project");
	fs.mkdirSync(otherCwd, { recursive: true });
	const peer = mountPeer(cwd, peerRoot);
	try {
		await (peer.handlers.get("session_start") as (e: unknown, c: unknown) => Promise<void>)?.({}, ctxFor(cwd));
		liveMember(peerRoot, cwd, "9400-eeee", "dev", { busy: true, busySince: Date.now() });
		liveMember(peerRoot, otherCwd, "9500-ffff", "qa", { busy: false });

		const own = await callTool(peer.tools, "peer_list", {}, cwd);
		assert.match(own, /sender（我）/, "自己要列出来，否则不知道本会话叫什么");
		assert.ok(own.indexOf("sender") < own.indexOf("dev"), "自己排第一行");
		assert.match(own, /dev/);
		assert.match(own, /在线·在忙/, "忙闲要渲染出来，不是只列名字");

		const all = await callTool(peer.tools, "peer_list", { scope: "all" }, cwd);
		assert.match(all, /sender（我）/);
		assert.match(all, /dev/);
		assert.match(all, /other-project\/qa/, "跨项目要带项目前缀");
		assert.match(all, /在线·空闲/);
	} finally {
		peer.restore();
	}
});

test("只有自己时 peer_list 也列自己，并提示怎么拉人", async () => {
	const { cwd, peerRoot } = tmpPair();
	const peer = mountPeer(cwd, peerRoot);
	try {
		await (peer.handlers.get("session_start") as (e: unknown, c: unknown) => Promise<void>)?.({}, ctxFor(cwd));
		const only = await callTool(peer.tools, "peer_list", {}, cwd);
		assert.match(only, /sender（我）/);
		assert.match(only, /同目录暂无其他会话/);
	} finally {
		peer.restore();
	}
});

/** 造一个只有角色卡、没有配置文件的项目（同事 clone 下来的样子） */
function cloneWithoutConfig(roles: string[] = ["owner"]) {
	const { cwd, peerRoot } = tmpPair();
	for (const role of roles) {
		const card = path.join(cwd, ".pi", "characters", `${role}.md`);
		fs.mkdirSync(path.dirname(card), { recursive: true });
		fs.writeFileSync(card, `我是 ${role}`, "utf8");
	}
	return { cwd, peerRoot };
}

test("配置缺失但角色卡按兜底命中：启动就说出来，并指向 /peer-config", async () => {
	const { cwd, peerRoot } = cloneWithoutConfig();
	const previousRole = process.env.PI_PEER_ROLE;
	process.env.PI_PEER_ROLE = "owner";
	const peer = mountPeer(cwd, peerRoot);
	try {
		await (peer.handlers.get("session_start") as (e: unknown, c: unknown) => Promise<void>)?.(
			{},
			ctxFor(cwd, peer.notes),
		);
		const said = peer.notes.join("\n");
		assert.match(said, /按兜底生效/);
		assert.match(said, /角色卡（owner）/);
		assert.match(said, /\/peer-config/);
	} finally {
		peer.restore();
		if (previousRole === undefined) delete process.env.PI_PEER_ROLE;
		else process.env.PI_PEER_ROLE = previousRole;
	}
});

test("没有配置文件、也没有角色：不吵（项目标签兜底是常态）", async () => {
	const { cwd, peerRoot } = tmpPair();
	const peer = mountPeer(cwd, peerRoot);
	try {
		await (peer.handlers.get("session_start") as (e: unknown, c: unknown) => Promise<void>)?.(
			{},
			ctxFor(cwd, peer.notes),
		);
		assert.deepEqual(peer.notes, []);
	} finally {
		peer.restore();
	}
});

test("/peer-config 把生效配置逐项摊开", async () => {
	const { cwd, peerRoot } = cloneWithoutConfig(["owner", "qa"]);
	const peer = mountPeer(cwd, peerRoot);
	try {
		const command = peer.commands.get("peer-config") as { handler: (a: string, c: unknown) => Promise<void> };
		assert.ok(command, "命令未注册");
		const before = peer.notes.length;
		await command.handler("", ctxFor(cwd, peer.notes));
		const text = peer.notes.slice(before).join("\n");
		assert.match(text, /项目配置：.*\.pi\/peer\.json（不存在（全部按兜底））/);
		assert.match(text, /项目标签：project ｜ 兜底：group\.name 没写，按目录名/);
		assert.match(text, /可用角色：owner、qa ｜ 兜底：roles 没写，扫 \.pi\/characters\//);
		assert.match(text, /流程文档：.*｜ 缺：/);
	} finally {
		peer.restore();
	}
});
