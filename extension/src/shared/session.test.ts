import assert from "node:assert/strict";
import { test } from "node:test";
import { KNOWN_CLIENTS, SESSION_ID_RE } from "@canon/shared";
import type { TurnsMessage } from "./protocol.ts";
import { clientFor, fnv1a32, sessionIdFor, TITLE_MAX, titleFrom, toCapturedSession } from "./session.ts";

const msg: TurnsMessage = {
  kind: "turns",
  site: "chatgpt",
  conversationId: "68fa-conv",
  url: "https://chatgpt.com/c/68fa-conv",
  turns: [
    { role: "user", text: "How do I debounce a MutationObserver?", index: 0 },
    { role: "assistant", text: "Wrap the callback in setTimeout and clear it on each call.", index: 1 },
  ],
};

test("fnv1a32 matches the published test vectors", () => {
  assert.equal(fnv1a32(""), 0x811c9dc5);
  assert.equal(fnv1a32("a"), 0xe40c292c);
  assert.equal(fnv1a32("foobar"), 0xbf9cf968);
});

test("sessionIdFor: ses_ + 8 hex, stable, and different per site and per conversation", () => {
  const id = sessionIdFor("chatgpt", "68fa-conv");
  assert.match(id, /^ses_[0-9a-f]{8}$/);
  assert.match(id, SESSION_ID_RE);
  assert.equal(sessionIdFor("chatgpt", "68fa-conv"), id);
  assert.notEqual(sessionIdFor("chatgpt", "68fa-conv2"), id);
});

test("clientFor maps every site to a client the grants table knows", () => {
  assert.equal(clientFor("chatgpt"), "chatgpt");
  for (const site of ["chatgpt"] as const) {
    assert.ok((KNOWN_CLIENTS as readonly string[]).includes(clientFor(site)), `${site} → known client`);
  }
});

test("titleFrom: first user turn, whitespace collapsed, cut to TITLE_MAX with an ellipsis", () => {
  assert.equal(titleFrom(msg.turns), "How do I debounce a MutationObserver?");
  assert.equal(titleFrom([{ role: "assistant", text: "hi", index: 0 }]), undefined);
  assert.equal(titleFrom([{ role: "user", text: "  two\n\nlines  ", index: 0 }]), "two lines");
  const long = titleFrom([{ role: "user", text: "x".repeat(200), index: 0 }])!;
  assert.equal(long.length, TITLE_MAX);
  assert.ok(long.endsWith("…"));
});

test("toCapturedSession: id, client, messages in index order, meta, title fallback, no ended_at", () => {
  const s = toCapturedSession({ ...msg, turns: [msg.turns[1], msg.turns[0]] }, "2026-10-24T03:12:00.000Z");
  assert.equal(s.id, sessionIdFor("chatgpt", "68fa-conv"));
  assert.equal(s.client, "chatgpt");
  assert.equal(s.started_at, "2026-10-24T03:12:00.000Z");
  assert.deepEqual(s.messages, [
    { role: "user", content: msg.turns[0].text },
    { role: "assistant", content: msg.turns[1].text },
  ]);
  assert.deepEqual(s.meta, { url: msg.url, site: "chatgpt" });
  assert.equal(s.title, "How do I debounce a MutationObserver?");
  assert.equal("ended_at" in s, false);
});

test("toCapturedSession: msg.title wins, ended_at only when ended", () => {
  const open = toCapturedSession({ ...msg, title: "Debounce notes" }, "2026-10-24T03:12:00.000Z", "2026-10-24T03:20:00.000Z");
  assert.equal(open.title, "Debounce notes");
  assert.equal(open.ended_at, undefined);
  const ended = toCapturedSession({ ...msg, ended: true }, "2026-10-24T03:12:00.000Z", "2026-10-24T03:20:00.000Z");
  assert.equal(ended.ended_at, "2026-10-24T03:20:00.000Z");
});
