import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { hasPersistedHandoff } from "../handoff-persistence.ts";

function fixture() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-native-persistence-"));
	return SessionManager.create(cwd, path.join(cwd, "sessions"));
}

test("真实 SDK: 首次 custom entry 未建文件，用户消息才使交接落盘", () => {
	const manager = fixture();
	manager.appendCustomMessageEntry("peer", "synthetic task", true, { handoff: { id: "synthetic-notification" } });
	assert.equal(fs.existsSync(manager.getSessionFile()!), false);
	assert.equal(hasPersistedHandoff(manager.getSessionFile(), manager.getBranch(), "synthetic-notification"), false);
	manager.appendMessage({ role: "user", content: "synthetic wake", timestamp: Date.now() });
	assert.equal(fs.existsSync(manager.getSessionFile()!), true);
	assert.equal(hasPersistedHandoff(manager.getSessionFile(), manager.getBranch(), "synthetic-notification"), true);
	assert.equal(hasPersistedHandoff(manager.getSessionFile(), manager.getBranch(), "other-notification"), false);
});

test("真实 SDK: 废弃分支记录、仅同阶段但 entry id 不同，不冒充当前消息持久化", () => {
	const manager = fixture();
	const root = manager.appendMessage({ role: "user", content: "synthetic root", timestamp: Date.now() });
	manager.appendCustomMessageEntry("peer", "synthetic abandoned task", true, {
		handoff: { id: "synthetic-notification" },
	});
	assert.equal(hasPersistedHandoff(manager.getSessionFile(), manager.getBranch(), "synthetic-notification"), true);
	manager.branch(root);
	assert.equal(hasPersistedHandoff(manager.getSessionFile(), manager.getBranch(), "synthetic-notification"), false);
	assert.equal(
		hasPersistedHandoff(
			manager.getSessionFile(),
			[{ id: "not-on-disk", type: "custom_message", details: { handoff: { id: "synthetic-notification" } } }],
			"synthetic-notification",
		),
		false,
	);
});

test("无持久路径、文件不存在及不完整 JSONL 均不确认", () => {
	const branch = [
		{ type: "custom_message", id: "synthetic-entry", details: { handoff: { id: "synthetic-notification" } } },
	];
	assert.equal(hasPersistedHandoff(undefined, branch, "synthetic-notification"), false);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-malformed-"));
	const file = path.join(dir, "synthetic.jsonl");
	assert.equal(hasPersistedHandoff(file, branch, "synthetic-notification"), false);
	fs.writeFileSync(file, '{"type":"custom_message","id":"synthetic-entry"');
	assert.equal(hasPersistedHandoff(file, branch, "synthetic-notification"), false);
});
