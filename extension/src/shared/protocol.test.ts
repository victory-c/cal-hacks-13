import assert from "node:assert/strict";
import { test } from "node:test";
import { isTurnsMessage } from "./protocol.ts";

const valid = { kind: "turns", site: "chatgpt", conversationId: "abc", url: "https://chatgpt.com/c/abc", turns: [] };

test("isTurnsMessage accepts a well-formed message", () => {
  assert.equal(isTurnsMessage(valid), true);
  assert.equal(isTurnsMessage({ ...valid, title: "t", ended: true }), true);
});

test("isTurnsMessage rejects junk, other kinds, unknown sites and missing fields", () => {
  assert.equal(isTurnsMessage(null), false);
  assert.equal(isTurnsMessage("turns"), false);
  assert.equal(isTurnsMessage({ ...valid, kind: "ping" }), false);
  assert.equal(isTurnsMessage({ ...valid, site: "copilot" }), false);
  assert.equal(isTurnsMessage({ ...valid, conversationId: "" }), false);
  assert.equal(isTurnsMessage({ ...valid, turns: "none" }), false);
  const { url: _url, ...noUrl } = valid;
  assert.equal(isTurnsMessage(noUrl), false);
});
