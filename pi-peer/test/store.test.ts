/**
 * pi-peer 传输层自测（不依赖 pi，直接跑 node --test）
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	BUSY_STALE_MS,
	cwdKey,
	isBusy,
	MAX_TEXT,
	newMessageId,
	newSessionKey,
	PeerStore,
	projectLabel,
	STALE_MS,
} from "../store.ts";

/** 每次调用给出独立工作目录，保证用例之间互不干扰 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-peer-test-"));
let caseSeq = 0;
function freshStore(): PeerStore {
	const dir = path.join(root, `case-${++caseSeq}`);
	fs.mkdirSync(dir, { recursive: true });
	return new PeerStore(root, dir);
}
after(() => {
	fs.rmSync(root, { recursive: true, force: true });
	for (const dir of isolatedRoots) fs.rmSync(dir, { recursive: true, force: true });
});

function member(
	store: PeerStore,
	key: string,
	name: string,
	overrides: Partial<{
		model: string;
		pid: number;
		lastSeen: number;
		startedAt: number;
		project: string;
		cwd: string;
		busy: boolean;
		busySince: number;
		hidden: boolean;
	}> = {},
) {
	const m = {
		key,
		name,
		model: "test/model",
		pid: process.pid,
		cwd: store.dir,
		startedAt: Date.now(),
		lastSeen: Date.now(),
		...overrides,
	};
	store.ensure(key);
	store.register(m);
	return m;
}

/** 跨项目用例要独占一个 root：共享 root 上别的用例留下的成员会混进全桶扫描 */
const isolatedRoots: string[] = [];
function crossPair(): { a: PeerStore; b: PeerStore; cwdA: string } {
	const shared = fs.mkdtempSync(path.join(os.tmpdir(), "pi-peer-cross-"));
	isolatedRoots.push(shared);
	const cwdA = path.join(shared, "proj-a");
	const cwdB = path.join(shared, "proj-b");
	fs.mkdirSync(cwdA, { recursive: true });
	fs.mkdirSync(cwdB, { recursive: true });
	return { a: new PeerStore(shared, cwdA), b: new PeerStore(shared, cwdB), cwdA };
}

function msg(from: string, fromName: string, to: string, text: string) {
	const ts = Date.now();
	return {
		id: newMessageId(),
		from,
		fromName,
		to,
		text,
		ts,
		thread: undefined as string | undefined,
		replyTo: undefined as string | undefined,
	};
}

describe("cwdKey", () => {
	it("同一路径稳定，不同路径不同", () => {
		assert.equal(cwdKey(root), cwdKey(root));
		assert.notEqual(cwdKey(root), cwdKey(path.join(root, "sub")));
	});

	it("不含路径分隔符（可安全拼目录）", () => {
		assert.ok(!cwdKey(root).includes("/"));
	});
});

describe("角色实例认领", () => {
	it("同一角色依次分配基础名和带序号名称", () => {
		const store = freshStore();
		const first = store.claimRoleName("dev", "8000-aaaa", process.pid);
		const second = store.claimRoleName("dev", "8001-bbbb", process.pid);

		assert.equal(first, "dev");
		assert.equal(second, "dev-2");
	});

	it("释放实例名后可被下一个会话复用", () => {
		const store = freshStore();
		const first = store.claimRoleName("qa", "8100-aaaa", process.pid);
		store.claimRoleName("qa", "8101-bbbb", process.pid);
		store.releaseRoleName("qa", first, "8100-aaaa");

		assert.equal(store.claimRoleName("qa", "8102-cccc", process.pid), "qa");
	});

	it("拒绝非法角色名", () => {
		const store = freshStore();
		assert.throws(() => store.claimRoleName("../dev", "8200-aaaa", process.pid));
	});
});

describe("projectLabel", () => {
	it("默认取目录名；斜杠与空白换成连字符", () => {
		assert.equal(projectLabel(undefined, "/path/to/example-project"), "example-project");
		assert.equal(projectLabel("my project", "/tmp/x"), "my-project");
		assert.equal(projectLabel("a/b", "/tmp/x"), "a-b", "标签不能带斜杠，否则寻址分词会坏");
	});

	it("清完为空时退为 session，超长截断", () => {
		assert.equal(projectLabel("   ", "/"), "session");
		assert.equal(projectLabel("x".repeat(50), "/tmp/x").length, 32);
	});
});

describe("跨项目发现与寻址", () => {
	it("扫全部桶：两条都能看到，带正确的桶与项目", () => {
		const { a, b } = crossPair();
		member(a, "2000-aaaa", "alpha", { project: "proj-a" });
		member(b, "2001-bbbb", "beta", { project: "proj-b" });

		const all = a.listAllMembers();
		assert.deepEqual(all.map((s) => `${s.project}/${s.member.name}`).sort(), ["proj-a/alpha", "proj-b/beta"]);
		assert.equal(all.find((s) => s.member.name === "beta")?.bucket, b.dir);
	});

	it("扫别人的桶时也清死成员", () => {
		const { a, b } = crossPair();
		member(b, "2100-aaaa", "dead", { lastSeen: Date.now() - STALE_MS - 1000 });
		const file = path.join(b.membersDir, "2100-aaaa.json");
		assert.ok(fs.existsSync(file));

		a.listAllMembers();
		assert.ok(!fs.existsSync(file), "死成员应被清掉，不分是不是自己的桶");
	});

	it("老成员文件没有 project 字段时退回目录名", () => {
		// 真正的 cwd 是项目目录，不是桶目录（桶名带哈希后缀）
		const { a, cwdA } = crossPair();
		member(a, "2200-aaaa", "legacy", { cwd: cwdA });
		assert.equal(a.listAllMembers().find((s) => s.member.name === "legacy")?.project, "proj-a");
	});

	it("按 项目/名字 命中唯一目标，并带出它的桶", () => {
		const { a, b } = crossPair();
		member(a, "2300-aaaa", "me", { project: "proj-a" });
		member(b, "2301-bbbb", "owner", { project: "proj-b" });

		const res = a.resolveScoped("proj-b", "owner", "2300-aaaa");
		assert.ok(res.ok);
		assert.equal(res.member.key, "2301-bbbb");
		assert.equal(res.bucket, b.dir);
	});

	it("名字不在该项目时，候选列的是该项目的成员", () => {
		const { a, b } = crossPair();
		member(a, "2400-aaaa", "me", { project: "proj-a" });
		member(b, "2401-bbbb", "owner", { project: "proj-b" });

		const res = a.resolveScoped("proj-b", "nope", "2400-aaaa");
		assert.ok(!res.ok);
		assert.equal(res.reason, "none");
		assert.deepEqual(
			res.candidates.map((m) => m.name),
			["owner"],
		);
		assert.equal(res.projects, undefined, "项目在的时候不该报项目清单");
	});

	it("项目不存在时，带出在线的项目标签", () => {
		const { a, b } = crossPair();
		member(a, "2500-aaaa", "me", { project: "proj-a" });
		member(b, "2501-bbbb", "owner", { project: "proj-b" });

		const res = a.resolveScoped("proj-nope", "owner", "2500-aaaa");
		assert.ok(!res.ok);
		assert.equal(res.reason, "none");
		assert.deepEqual(res.projects, ["proj-a", "proj-b"]);
	});

	it("同项目内重名返回 ambiguous", () => {
		const { a, b } = crossPair();
		member(a, "2600-aaaa", "me", { project: "proj-a" });
		member(b, "2601-bbbb", "dup", { project: "proj-b" });
		member(b, "2602-cccc", "dup", { project: "proj-b" });

		const res = a.resolveScoped("proj-b", "dup", "2600-aaaa");
		assert.ok(!res.ok);
		assert.equal(res.reason, "ambiguous");
		assert.equal(res.candidates.length, 2);
	});

	it("命中自己时给 self", () => {
		const { a } = crossPair();
		member(a, "2700-aaaa", "me", { project: "proj-a" });

		const res = a.resolveScoped("proj-a", "me", "2700-aaaa");
		assert.ok(!res.ok);
		assert.equal(res.reason, "self");
	});

	it("投递写目标桶，桶还没建也会自动建", () => {
		const { a, b } = crossPair();
		// 对方从未注册：目标桶的 pending/ 完全不存在，靠 send 自己建
		assert.ok(!fs.existsSync(path.join(b.dir, "pending")));

		const m = msg("2800-aaaa", "proj-a/me", "2801-bbbb", "跨项目消息");
		a.send(m, b.dir);

		assert.equal(b.drain("2801-bbbb").length, 1, "对方应该收得到");
		assert.equal(a.drain("2801-bbbb").length, 0, "不该落在自己的桶里");
	});
});

describe("注册与发现", () => {
	it("注册后能互相看到，且排除自身", () => {
		const store = freshStore();
		const a = member(store, "1000-aaaa", "alpha");
		member(store, "1001-bbbb", "beta");

		const others = store.listMembers().filter((m) => m.key !== a.key);
		assert.deepEqual(
			others.map((m) => m.name),
			["beta"],
		);
		assert.equal(store.listMembers().length, 2);
	});

	it("心跳过期的成员被判定离线并清理", () => {
		const store = freshStore();
		member(store, "1002-cccc", "stale", { lastSeen: Date.now() - STALE_MS - 1000 });
		assert.equal(store.listMembers().length, 0);
		assert.equal(store.listMembers({ includeStale: true }).length, 0, "清理后连 stale 也不该再出现");
	});

	it("unregister 后立即消失", () => {
		const store = freshStore();
		member(store, "1003-dddd", "gone");
		store.unregister("1003-dddd");
		assert.equal(store.listMembers({ includeStale: true }).length, 0);
	});
});

describe("目标解析", () => {
	it("支持名称 / id 前缀 / pid / name#pid", () => {
		const store = freshStore();
		const me = member(store, "2000-1111", "me");
		const other = member(store, "2001-2222", "reviewer");

		assert.equal(store.resolve("reviewer", me.key).ok, true);
		assert.equal(store.resolve("2001", me.key).ok, true);
		assert.equal(store.resolve(String(other.pid), me.key).ok, true);
		assert.equal(store.resolve(`reviewer#${other.pid}`, me.key).ok, true);
	});

	it("名称大小写不敏感", () => {
		const store = freshStore();
		const me = member(store, "3000-1111", "me2");
		member(store, "3001-2222", "Reviewer2");
		assert.equal(store.resolve("reviewer2", me.key).ok, true);
	});

	it("拒绝发给自己", () => {
		const store = freshStore();
		const me = member(store, "4000-1111", "selfy");
		const r = store.resolve("selfy", me.key);
		assert.equal(r.ok, false);
		assert.equal(r.ok === false && r.reason, "self");
	});

	it("重名时返回 ambiguous 而不是猜", () => {
		const store = freshStore();
		const me = member(store, "5000-1111", "me3");
		// 两个都活着且同名：必须靠名称消歧失败
		member(store, "5001-2222", "dup", { pid: process.pid });
		member(store, "5002-3333", "dup", { pid: process.pid });
		const r = store.resolve("dup", me.key);
		assert.equal(r.ok, false);
		assert.equal(r.ok === false && r.reason, "ambiguous");
		assert.equal(r.ok === false && r.candidates.length, 2);
	});

	it("同名但只有一个在线：投给在线的那个，不因为离线的重名而卡住", () => {
		const store = freshStore();
		const me = member(store, "5100-1111", "me5");
		member(store, "5101-2222", "dup2", { pid: process.pid });
		member(store, "5102-3333", "dup2", { pid: process.pid, lastSeen: Date.now() - STALE_MS - 1000 });
		const r = store.resolve("dup2", me.key);
		assert.equal(r.ok, true);
		assert.equal(r.ok === true && r.member.key, "5101-2222");
	});

	it("人不在线时报 offline，不把信写进没人取的收件箱", () => {
		const store = freshStore();
		const me = member(store, "5200-1111", "me6");
		member(store, "5201-2222", "sleepy", { pid: process.pid, lastSeen: Date.now() - STALE_MS - 1000 });
		const r = store.resolve("sleepy", me.key);
		assert.equal(r.ok, false);
		assert.equal(r.ok === false && r.reason, "offline");
	});

	it("找不到目标时返回 none", () => {
		const store = freshStore();
		const me = member(store, "6000-1111", "me4");
		const r = store.resolve("nobody", me.key);
		assert.equal(r.ok, false);
		assert.equal(r.ok === false && r.reason, "none");
	});
});

describe("消息投递", () => {
	it("send → drain 按时间序送达一次，第二次为空", () => {
		const store = freshStore();
		const a = member(store, "7000-1111", "sender");
		const b = member(store, "7001-2222", "receiver");

		store.send(msg(a.key, a.name, b.key, "第一条"));
		store.send(msg(a.key, a.name, b.key, "第二条"));

		assert.deepEqual(
			store.drain(b.key).map((m) => m.text),
			["第一条", "第二条"],
		);
		assert.equal(store.drain(b.key).length, 0);
		assert.equal(store.drain(a.key).length, 0, "发件人收件箱应为空");
	});

	it("先搬走再读：连续 drain 不会重复投递", () => {
		const store = freshStore();
		const a = member(store, "7100-1111", "s2");
		const b = member(store, "7101-2222", "r2");
		store.send(msg(a.key, a.name, b.key, "唯一一条"));

		const first = store.drain(b.key).length;
		const second = store.drain(b.key).length;
		assert.equal(first + second, 1);
	});

	it("超长正文被截断", () => {
		const store = freshStore();
		const a = member(store, "7200-1111", "s3");
		const b = member(store, "7201-2222", "r3");
		store.send(msg(a.key, a.name, b.key, "x".repeat(MAX_TEXT + 500)));
		assert.equal(store.drain(b.key)[0].text.length, MAX_TEXT);
	});

	it("历史与查找：收件箱、发件箱分开", () => {
		const store = freshStore();
		const a = member(store, "7300-1111", "s4");
		const b = member(store, "7301-2222", "r4");

		const m1 = msg(a.key, a.name, b.key, "你好");
		store.send(m1);
		store.logSent(a.key, m1);
		store.drain(b.key);

		assert.equal(store.history(b.key, 10).length, 1);
		assert.equal(store.history(a.key, 10).length, 0, "自己的收件箱不该有自己发的");
		assert.equal(store.findMessage(a.key, m1.id)?.text, "你好");
		assert.equal(store.findMessage(b.key, m1.id)?.text, "你好");
	});

	it("修剪只保留最近 N 条", () => {
		const store = freshStore();
		const a = member(store, "7400-1111", "s5");
		const b = member(store, "7401-2222", "r5");
		for (let i = 0; i < 10; i++) store.send(msg(a.key, a.name, b.key, `第${i}条`));
		store.drain(b.key);
		store.prune(b.key, 3);
		assert.equal(store.history(b.key, 50).length, 3);
	});

	it("非法 key 不会写出目录之外", () => {
		const store = freshStore();
		assert.throws(() => store.send(msg("a", "a", "../../etc", "x", 0)));
	});
});

describe("会话 key", () => {
	it("没有稳定种子时每次生成都不同且格式合法", () => {
		const a = newSessionKey();
		const b = newSessionKey();
		assert.notEqual(a, b);
		assert.ok(/^\d+-[0-9a-f]{4}$/.test(a));
	});

	it("给了稳定种子就稳定：同一会话 reload 不换 key，收件箱不分裂", () => {
		const a = newSessionKey(9001, "session-id-abc");
		const b = newSessionKey(9001, "session-id-abc");
		assert.equal(a, b);
		assert.ok(/^9001-[0-9a-f]{4}$/.test(a));
		// 不同会话不同 key，不同进程同一会话也会变（pid 参与了）
		assert.notEqual(a, newSessionKey(9001, "session-id-xyz"));
		assert.notEqual(a, newSessionKey(9002, "session-id-abc"));
	});
});

describe("收件箱跨 key 聚合", () => {
	/** 造一条已投递消息：直接写进 delivered/<key>/ 下 */
	function deliver(store: PeerStore, to: string, msg: PeerMessage, at: number): void {
		const dir = store.deliveredDir(to);
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${String(at).padStart(16, "0")}-000-${msg.id}.json`);
		fs.writeFileSync(file, JSON.stringify({ ...msg, to, ts: at }));
	}

	it("同一会话换了 key 之后，历史仍然查得到", () => {
		const store = freshStore();
		const oldKey = "7001-aaaa";
		const newKey = "8002-bbbb";
		store.ensure(oldKey);
		store.ensure(newKey);
		store.recordIdentity(oldKey, { sessionFile: "/s/x.jsonl", name: "dev" });
		store.recordIdentity(newKey, { sessionFile: "/s/x.jsonl", name: "dev" });

		deliver(
			store,
			oldKey,
			{ id: "m1", from: "1-1", fromName: "owner", to: oldKey, text: "旧会话收到", ts: 1000 },
			1000,
		);
		deliver(
			store,
			newKey,
			{ id: "m2", from: "1-1", fromName: "owner", to: newKey, text: "新会话收到", ts: 2000 },
			2000,
		);

		const all = store.historyBySession(newKey, { sessionFile: "/s/x.jsonl", limit: 10 });
		assert.deepEqual(
			all.map((m) => m.id),
			["m2", "m1"],
			"两个 key 的消息都要在，新→旧",
		);

		// 只看当前 key 时只剩一条
		assert.deepEqual(
			store.historyBySession(newKey, { limit: 10, sessionFile: undefined }).map((m) => m.id),
			["m2"],
		);
	});

	it("别的会话不会混进来", () => {
		const store = freshStore();
		store.ensure("7001-aaaa");
		store.ensure("9003-cccc");
		store.recordIdentity("7001-aaaa", { sessionFile: "/s/mine.jsonl", name: "dev" });
		store.recordIdentity("9003-cccc", { sessionFile: "/s/other.jsonl", name: "qa" });
		deliver(store, "7001-aaaa", { id: "mine", from: "1-1", fromName: "owner", to: "7001-aaaa", text: "a", ts: 1 }, 1);
		deliver(
			store,
			"9003-cccc",
			{ id: "other", from: "1-1", fromName: "owner", to: "9003-cccc", text: "b", ts: 2 },
			2,
		);

		const mine = store.historyBySession("7001-aaaa", { sessionFile: "/s/mine.jsonl", limit: 10 });
		assert.deepEqual(
			mine.map((m) => m.id),
			["mine"],
		);
	});

	it("since / until 按时间过滤：收件箱被单条淹掉时还能翻到", () => {
		const store = freshStore();
		store.ensure("7001-dddd");
		store.recordIdentity("7001-dddd", { sessionFile: "/s/y.jsonl", name: "dev" });
		for (let i = 0; i < 5; i += 1) {
			deliver(
				store,
				"7001-dddd",
				{ id: `m${i}`, from: "1-1", fromName: "owner", to: "7001-dddd", text: `第 ${i} 条`, ts: 1000 + i * 100 },
				1000 + i * 100,
			);
		}
		const window = store.historyBySession("7001-dddd", {
			sessionFile: "/s/y.jsonl",
			limit: 10,
			since: 1200,
			until: 1300,
		});
		assert.deepEqual(
			window.map((m) => m.id),
			["m3", "m2"],
			"闭区间内两条",
		);
	});
});

describe("忙闲：派工只找空闲的会话", () => {
	it("忙的成员在 idleOnly 解析里被跳过，报 busy 而不是 none", () => {
		const store = freshStore();
		const me = member(store, "8000-1111", "asker");
		member(store, "8001-2222", "worker", { busy: true, busySince: Date.now() });

		assert.equal(store.resolve("worker", me.key).ok, true, "手动发消息不受忙闲限制");
		const idle = store.resolveIdle("worker", me.key);
		assert.equal(idle.ok, false);
		assert.equal(idle.ok === false && idle.reason, "busy");
	});

	it("空闲的成员可以被派工", () => {
		const store = freshStore();
		const me = member(store, "8100-1111", "asker2");
		member(store, "8101-2222", "idler", { busy: false });
		assert.equal(store.resolveIdle("idler", me.key).ok, true);
	});

	it("busy 卡住（agent_end 没触发）超过阈值后当作可投，一次异常不该让人永远收不到派工", () => {
		const store = freshStore();
		const me = member(store, "8200-1111", "asker3");
		const stuck = member(store, "8201-2222", "stuck", {
			busy: true,
			busySince: Date.now() - BUSY_STALE_MS - 1000,
		});
		assert.equal(isBusy(stuck), false);
		assert.equal(store.resolveIdle("stuck", me.key).ok, true);
	});

	it("deliverTo 的 idleOnly：忙的不投，也不写进收件箱", () => {
		const store = freshStore();
		member(store, "8300-1111", "sender2");
		member(store, "8301-2222", "busy-one", { busy: true, busySince: Date.now() });

		const result = store.deliverTo(
			"busy-one",
			{ from: "sweep", fromName: "扫描器", text: "该你了" },
			{ idleOnly: true },
		);
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.reason, "busy");
		assert.match(result.ok === false ? result.detail : "", /正在跑一轮/);
		assert.equal(store.drain("8301-2222").length, 0, "忙就不该落进收件箱");
	});

	it("deliverTo 默认不看忙闲：手动发的消息照样送到", () => {
		const store = freshStore();
		member(store, "8400-1111", "sender3");
		member(store, "8401-2222", "busy-two", { busy: true, busySince: Date.now() });

		const result = store.deliverTo("busy-two", { from: "s", fromName: "人", text: "插一句" });
		assert.equal(result.ok, true);
		assert.equal(store.drain("8401-2222").length, 1);
	});
});

describe("专注模式：隐身的会话不让别人选到", () => {
	it("隐身成员不出现在别人的列表里，自己的列表里带 selfKey 还看得到", () => {
		const store = freshStore();
		member(store, "9000-1111", "watcher");
		member(store, "9001-2222", "focused", { hidden: true });

		const others = store.listScoped().map((s) => s.member.name);
		assert.deepEqual(others, ["watcher"], "别人看不到隐身的会话");
		const mine = store.listScoped({ selfKey: "9001-2222" }).map((s) => s.member.name);
		assert.deepEqual(mine.sort(), ["focused", "watcher"], "本人仍然看得到自己");
	});

	it("resolve 找不到隐身成员，报 none 而不是 offline：它确实在跑，只是不接", () => {
		const store = freshStore();
		const me = member(store, "9100-1111", "sender");
		member(store, "9101-2222", "focused", { hidden: true });

		const res = store.resolve("focused", me.key);
		assert.equal(res.ok, false);
		assert.equal(res.ok === false && res.reason, "none");
		assert.equal(store.resolveIdle("focused", me.key).ok, false, "派工路径同样选不中");
	});

	it("隐身成员自己给自己发也照样报 self", () => {
		const store = freshStore();
		member(store, "9200-1111", "focused", { hidden: true });
		const res = store.resolve("focused", "9200-1111");
		assert.equal(res.ok === false && res.reason, "self");
	});

	it("deliverTo 投不进隐身会话的收件箱", () => {
		const store = freshStore();
		member(store, "9300-1111", "focused", { hidden: true });

		const result = store.deliverTo("focused", { from: "s", fromName: "扫描器", text: "该你了" });
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.reason, "none");
		assert.equal(store.drain("9300-1111").length, 0);
	});

	it("跨项目寻址一样看不到隐身的会话", () => {
		const { a, b } = crossPair();
		member(a, "9400-1111", "me");
		member(b, "9401-2222", "hidden-owner", { hidden: true, project: "proj-b" });

		assert.equal(a.resolveScoped("proj-b", "hidden-owner", "9400-1111").ok, false);
		assert.equal(a.resolveScoped("proj-b", "hidden-owner", "9400-1111").candidates.length, 0);
	});
});

describe("回填老 key 的身份", () => {
	it("同一 pid 的多个 key 归成一组，聚合后能读全历史", () => {
		const store = freshStore();
		// 模拟老数据：同 pid 三个 key，每个目录各有消息，全部没有 identity 记录
		for (const key of ["5001-aaaa", "5001-bbbb", "5001-cccc", "5002-dddd"]) {
			store.ensure(key);
			const dir = store.deliveredDir(key);
			fs.writeFileSync(
				path.join(dir, `${String(1).padStart(16, "0")}-000-m-${key}.json`),
				JSON.stringify({ id: `m-${key}`, from: "1-1", fromName: "owner", to: key, text: key, ts: 1 }),
			);
		}

		const changed = store.backfillIdentities();
		assert.deepEqual(
			changed.map((c) => c.key).sort(),
			["5001-aaaa", "5001-bbbb", "5001-cccc"],
			"只有一个 key 的 pid 不动",
		);

		const all = store.historyBySession("5001-cccc", { sessionFile: "pid:5001", limit: 10 });
		assert.equal(all.length, 3, "同一会话的三个 key 要合起来");
	});

	it("已登记真实会话文件的不被覆盖", () => {
		const store = freshStore();
		store.ensure("6001-aaaa");
		store.ensure("6001-bbbb");
		store.recordIdentity("6001-aaaa", { sessionFile: "/s/real.jsonl", name: "dev" });

		store.backfillIdentities();
		const keys = store.keysOfSession("6001-bbbb", "/s/real.jsonl");
		assert.ok(keys.includes("6001-aaaa"), "真实记录仍然可用");
	});
});
