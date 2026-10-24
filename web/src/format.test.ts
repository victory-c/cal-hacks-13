import assert from "node:assert/strict";
import { test } from "node:test";

import { clientLabel, fmtCost, fmtMs, fmtTokens, folderSub, folderTop, pct, relativeTime, truncate } from "./format.ts";

test("fmtMs: ms under a second, seconds above, dash for nothing", () => {
  assert.equal(fmtMs(0), "0 ms");
  assert.equal(fmtMs(412.4), "412 ms");
  assert.equal(fmtMs(1400), "1.4 s");
  assert.equal(fmtMs(2000), "2 s");
  assert.equal(fmtMs(12_345), "12 s");
  assert.equal(fmtMs(undefined), "—");
  assert.equal(fmtMs(-1), "—");
  assert.equal(fmtMs(Number.NaN), "—");
});

test("fmtTokens: 1.4K style", () => {
  assert.equal(fmtTokens(0), "0");
  assert.equal(fmtTokens(842), "842");
  assert.equal(fmtTokens(1000), "1K");
  assert.equal(fmtTokens(1400), "1.4K");
  assert.equal(fmtTokens(9940), "9.9K");
  assert.equal(fmtTokens(9960), "10K");
  assert.equal(fmtTokens(12_300), "12K");
  assert.equal(fmtTokens(1_250_000), "1.3M");
  assert.equal(fmtTokens(null), "—");
});

test("pct clamps and rounds", () => {
  assert.equal(pct(0.91), "91%");
  assert.equal(pct(0.005), "1%");
  assert.equal(pct(1.4), "100%");
  assert.equal(pct(-2), "0%");
  assert.equal(pct(undefined), "—");
});

test("fmtCost only when a rate is set", () => {
  assert.equal(fmtCost(1500, null), "—");
  assert.equal(fmtCost(1500, 0), "—");
  assert.equal(fmtCost(0, 3), "$0");
  assert.equal(fmtCost(1500, 3), "$0.0045");
  assert.equal(fmtCost(50_000, 3), "$0.15");
});

test("relativeTime buckets", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  assert.equal(relativeTime(ago(3), now), "just now");
  assert.equal(relativeTime(ago(42), now), "42 s ago");
  assert.equal(relativeTime(ago(5 * 60 + 20), now), "5 min ago");
  assert.equal(relativeTime(ago(3 * 3600), now), "3 h ago");
  assert.equal(relativeTime(ago(2 * 86_400), now), "2 d ago");
  assert.equal(relativeTime(ago(-30), now), "just now", "clock skew is not negative time");
  assert.equal(relativeTime("not a date", now), "—");
  assert.equal(relativeTime(undefined, now), "—");
});

test("clientLabel knows every client and passes unknown ones through", () => {
  assert.equal(clientLabel("claude-code"), "Claude Code");
  assert.equal(clientLabel("chatgpt"), "ChatGPT");
  assert.equal(clientLabel("teammate-cursor"), "Teammate · Cursor");
  assert.equal(clientLabel("some-new-client"), "some-new-client");
});

test("folderTop / folderSub", () => {
  assert.equal(folderTop("career/projects"), "career");
  assert.equal(folderTop("career"), "career");
  assert.equal(folderTop("inbox"), "inbox");
  assert.equal(folderSub("career/projects"), "projects");
  assert.equal(folderSub("career/skills/typescript"), "skills/typescript");
  assert.equal(folderSub("career"), "");
});

test("truncate adds an ellipsis only when needed", () => {
  assert.equal(truncate("short", 10), "short");
  assert.equal(truncate("a fairly long task string", 10), "a fairly…");
});
