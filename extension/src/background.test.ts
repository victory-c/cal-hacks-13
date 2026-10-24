import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SERVER_URL, ROUTES } from "@canon/shared";
import type { CapturedSession } from "@canon/shared";
import { buildPost, DEBOUNCE_MS, shouldDebounce } from "./background.ts";
import type { TurnsMessage } from "./shared/protocol.ts";
import { sessionIdFor } from "./shared/session.ts";
import { normalizeSettings } from "./shared/settings.ts";

const msg: TurnsMessage = {
  kind: "turns",
  site: "chatgpt",
  conversationId: "conv-1",
  url: "https://chatgpt.com/c/conv-1",
  turns: [{ role: "user", text: "hi", index: 0 }],
};
const settings = { canonUrl: "http://localhost:4100", token: "dev-chatgpt", principal: "" };

test("shouldDebounce: only within the window, never for the final snapshot", () => {
  assert.equal(shouldDebounce(undefined, 10_000), false);
  assert.equal(shouldDebounce(9_000, 10_000), true);
  assert.equal(shouldDebounce(10_000 - DEBOUNCE_MS, 10_000), false);
  assert.equal(shouldDebounce(9_000, 10_000, true), false);
  assert.equal(shouldDebounce(9_500, 10_000, false, 100), false);
});

test("buildPost targets ROUTES.sessions with a bearer token and a CapturedSession body", () => {
  const { url, init, session } = buildPost(msg, "2026-10-24T03:12:00.000Z", settings);
  assert.equal(url, `http://localhost:4100${ROUTES.sessions}`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, "Bearer dev-chatgpt");
  assert.equal(init.headers["content-type"], "application/json");
  const body = JSON.parse(init.body) as CapturedSession;
  assert.deepEqual(body, session);
  assert.equal(body.id, sessionIdFor("chatgpt", "conv-1"));
  assert.equal(body.client, "chatgpt");
  assert.equal(body.started_at, "2026-10-24T03:12:00.000Z");
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
  assert.equal(body.ended_at, undefined);
  assert.equal(body.kind, "ai_session");
  assert.equal("principal" in body, false, "no principal set → none sent");
});

test("buildPost v2: the options-page principal goes out on the session", () => {
  const { init, session } = buildPost(msg, "2026-10-24T03:12:00.000Z", { ...settings, principal: "dan" });
  assert.equal(session.principal, "dan");
  assert.equal((JSON.parse(init.body) as CapturedSession).principal, "dan");
  assert.equal(session.kind, "ai_session");
});

test("buildPost strips a trailing slash and stamps ended_at on the final snapshot", () => {
  const { url, session } = buildPost({ ...msg, ended: true }, "2026-10-24T03:12:00.000Z", { ...settings, canonUrl: "http://127.0.0.1:4100/" }, "2026-10-24T03:30:00.000Z");
  assert.equal(url, `http://127.0.0.1:4100${ROUTES.sessions}`);
  assert.equal(session.ended_at, "2026-10-24T03:30:00.000Z");
});

test("buildPost refuses to post without a token and says where to get one", () => {
  assert.throws(() => buildPost(msg, "2026-10-24T03:12:00.000Z", { ...settings, token: "" }), /options page.*CANON_CLIENT_TOKENS/);
});

test("normalizeSettings defaults the URL, trims every field and lowercases the principal", () => {
  assert.deepEqual(normalizeSettings({}), { canonUrl: DEFAULT_SERVER_URL, token: "", principal: "" });
  assert.deepEqual(normalizeSettings({ canonUrl: "  ", token: 42, principal: 7 }), { canonUrl: DEFAULT_SERVER_URL, token: "", principal: "" });
  assert.deepEqual(normalizeSettings({ canonUrl: " http://x:1 ", token: " t ", principal: " Dan " }), { canonUrl: "http://x:1", token: "t", principal: "dan" });
});
