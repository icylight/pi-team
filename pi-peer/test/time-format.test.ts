/**
 * 消息时刻的显示口径：正文、列表、提示共用这一套。
 *
 * 用固定日期构造时间戳，跨日与跨年两条分支才跑得到。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { messageStamp, relativeAge } from "../index.ts";

test("同一天只写时:分，跨日补月-日", () => {
	const now = new Date();
	const earlierToday = new Date(now);
	earlierToday.setHours(9, 5, 0, 0);
	assert.equal(messageStamp(earlierToday.getTime()), "09:05");

	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	yesterday.setHours(23, 40, 0, 0);
	const pad = (n: number) => String(n).padStart(2, "0");
	assert.equal(
		messageStamp(yesterday.getTime()),
		`${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())} 23:40`,
	);
});

test("跨年带上年份", () => {
	const old = new Date();
	old.setFullYear(old.getFullYear() - 1);
	old.setMonth(11, 31);
	old.setHours(22, 30, 0, 0);
	assert.match(messageStamp(old.getTime()), /^\d{4}-12-31 22:30$/);
});

test("多久以前分档：秒、分钟、小时、天", () => {
	const now = Date.now();
	assert.equal(relativeAge(now - 30_000), "30 秒前");
	assert.equal(relativeAge(now - 5 * 60_000), "5 分钟前");
	assert.equal(relativeAge(now - 3 * 3_600_000), "3 小时前");
	assert.equal(relativeAge(now - 2 * 86_400_000), "2 天前");
});
