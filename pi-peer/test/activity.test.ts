/**
 * activity 自测：判定「一个会话在跑什么」。
 * 关键是区分「命令还在跑」与「已经跑完在思考」，误判会让切换前的判断失效。
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { formatSpan, LONG_CALL_MS, QUIET_MS, readActivity, switchAdvice } from "../activity.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peer-activity-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let counter = 0;
function writeTranscript(events: Record<string, unknown>[]): string {
	const file = path.join(tmp, `t${counter++}.jsonl`);
	fs.writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
	return file;
}
function message(atMs: number, message: Record<string, unknown>): Record<string, unknown> {
	return { type: "message", timestamp: new Date(atMs).toISOString(), message };
}
function toolCall(atMs: number, id: string, name: string, args: Record<string, unknown> = {}) {
	return message(atMs, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
}
function toolResult(atMs: number, toolCallId: string, name: string) {
	return message(atMs, { role: "toolResult", toolCallId, toolName: name, content: [{ type: "text", text: "ok" }] });
}
function assistantText(atMs: number, text: string) {
	return message(atMs, { role: "assistant", content: [{ type: "text", text }] });
}

const NOW = 1_800_000_000_000;

describe("readActivity", () => {
	it("调用已返回、随后没有新事件 → thinking，不是「在跑」", () => {
		const file = writeTranscript([
			toolCall(NOW - 5_000, "c1", "bash", { command: "ls" }),
			toolResult(NOW - 4_000, "c1", "bash"),
		]);
		const activity = readActivity(file, NOW);
		assert.equal(activity.kind, "thinking");
		assert.equal(activity.last?.name, "bash");
	});

	it("调用未返回且时长在阈值内 → running", () => {
		const file = writeTranscript([toolCall(NOW - 3_000, "c1", "bash", { command: "npm test" })]);
		const activity = readActivity(file, NOW);
		assert.equal(activity.kind, "running");
		assert.match(activity.summary, /npm test/);
	});

	it("调用未返回且超过阈值 → running-long，用来在列表里点名", () => {
		const file = writeTranscript([toolCall(NOW - LONG_CALL_MS - 60_000, "c1", "bash", { command: "npm install" })]);
		const activity = readActivity(file, NOW);
		assert.equal(activity.kind, "running-long");
		assert.match(activity.summary, /这类命令本来就慢/);
	});

	it("调用已返回但 transcript 长时间无事件 → quiet（可疑，可切）", () => {
		const file = writeTranscript([
			toolCall(NOW - QUIET_MS - 60_000, "c1", "peer_send", {}),
			toolResult(NOW - QUIET_MS - 59_000, "c1", "peer_send"),
		]);
		const activity = readActivity(file, NOW);
		assert.equal(activity.kind, "quiet");
		assert.equal(switchAdvice(activity).safeToSwitch, true);
	});

	it("多条调用交错时按 toolCallId 配对，不看先后", () => {
		// c2 先发后回，c1 后发仍挂着：最后的未返回调用是 c1
		const file = writeTranscript([
			toolCall(NOW - 9_000, "c1", "bash", { command: "sleep 60" }),
			toolCall(NOW - 8_000, "c2", "read", { path: "/a" }),
			toolResult(NOW - 7_000, "c2", "read"),
		]);
		const activity = readActivity(file, NOW);
		assert.equal(activity.kind, "running");
		assert.equal(activity.last?.id, "c1");
		assert.match(activity.summary, /sleep 60/);
	});

	it("读不到文件 → unknown，不猜", () => {
		assert.equal(readActivity(path.join(tmp, "missing.jsonl"), NOW).kind, "unknown");
		assert.equal(readActivity(undefined, NOW).kind, "unknown");
		assert.equal(readActivity("pid:1234", NOW).kind, "unknown");
	});

	it("空文件 → unknown", () => {
		const file = path.join(tmp, "empty.jsonl");
		fs.writeFileSync(file, "");
		assert.equal(readActivity(file, NOW).kind, "unknown");
	});

	it("坏行不影响判定，跳过继续读", () => {
		const file = path.join(tmp, "broken.jsonl");
		fs.writeFileSync(
			file,
			`${[`{"broken":`, JSON.stringify(toolCall(NOW - 2_000, "c1", "bash", { command: "make check" }))].join("\n")}\n`,
		);
		const activity = readActivity(file, NOW);
		assert.equal(activity.kind, "running");
		assert.match(activity.summary, /make check/);
	});
});

describe("switchAdvice", () => {
	it("在跑命令时不建议切", () => {
		const file = writeTranscript([toolCall(NOW - 5_000, "c1", "bash", { command: "npm run check" })]);
		assert.equal(switchAdvice(readActivity(file, NOW)).safeToSwitch, false);
	});

	it("quiet 时建议切，理由里带「可能已卡住」", () => {
		const file = writeTranscript([assistantText(NOW - QUIET_MS - 1_000, "done")]);
		const advice = switchAdvice(readActivity(file, NOW));
		assert.equal(advice.safeToSwitch, true);
		assert.match(advice.reason, /卡住|结束/);
	});
});

describe("formatSpan", () => {
	it("按秒/分/小时给出可读时长", () => {
		assert.equal(formatSpan(500), "0s");
		assert.equal(formatSpan(9_000), "9s");
		assert.equal(formatSpan(90_000), "1m30s");
		assert.equal(formatSpan(3_600_000), "1h");
		assert.equal(formatSpan(5_400_000), "1h30m");
	});
});
