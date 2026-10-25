import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SERVER_URL, ROUTES } from "@canon/shared";
import type { CapturedSession } from "@canon/shared";
import { buildPost, DEBOUNCE_MS, isRetryableStatus, Outbox, OUTBOX_PREFIX, RETRY_BASE_MS, RETRY_MAX_ATTEMPTS, RETRY_MAX_MS, shouldDebounce } from "./background.ts";
import type { OutboxEntry, PostOutcome } from "./background.ts";
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

test("isRetryableStatus: timeouts, rate limits and 5xx retry; other 4xx do not", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isRetryableStatus(status), true, String(status));
  for (const status of [400, 401, 403, 404, 413, 422]) assert.equal(isRetryableStatus(status), false, String(status));
});

// --- Outbox: queue, retry and resume (issue #23) -------------------------------------------------

/** A fake clock with timers, chrome.storage.session as a plain object, and a scripted POST. */
function outboxHarness(outcomes: Array<PostOutcome | "throw" | "hang">, storage: Record<string, unknown> = {}) {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const posts: TurnsMessage[] = [];
  const postTimes: number[] = [];
  const hanging: Array<(o: PostOutcome) => void> = [];
  let wakes = 0;
  let idles = 0;
  let failWrites = false;
  const deps = {
    storage: {
      get: async (_keys: null) => structuredClone(storage),
      set: async (items: Record<string, unknown>) => {
        if (failWrites) throw new Error("QUOTA_BYTES quota exceeded");
        Object.assign(storage, structuredClone(items));
      },
      remove: async (key: string) => {
        delete storage[key];
      },
    },
    post: async (_key: string, msg: TurnsMessage): Promise<PostOutcome> => {
      posts.push(msg);
      postTimes.push(now);
      const next = outcomes.shift() ?? { ok: true };
      if (next === "throw") throw new Error("boom");
      if (next === "hang") return new Promise<PostOutcome>((resolve) => hanging.push(resolve));
      return next;
    },
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number);
    },
    wake: () => {
      wakes++;
    },
    idle: () => {
      idles++;
    },
  };
  const settle = () => new Promise((r) => setImmediate(r));
  /** Moves the clock forward, firing due timers in order. */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await settle();
    }
    now = end;
    await settle();
  };
  return {
    deps,
    storage,
    posts,
    postTimes,
    hanging,
    settle,
    advance,
    get wakes() {
      return wakes;
    },
    get idles() {
      return idles;
    },
    failWrites(v: boolean) {
      failWrites = v;
    },
  };
}

const KEY = "chatgpt:conv-1";
const withText = (text: string, ended = false): TurnsMessage => ({ ...msg, turns: [{ role: "user", text, index: 0 }], ...(ended ? { ended: true } : {}) });
const stored = (h: { storage: Record<string, unknown> }) => h.storage[OUTBOX_PREFIX + KEY] as OutboxEntry | undefined;

test("Outbox: the ack (enqueue) means queued, not persisted; the entry stays until the POST succeeds", async () => {
  const h = outboxHarness(["hang"]);
  const outbox = new Outbox(h.deps);
  await outbox.enqueue(KEY, msg); // resolves before the POST has an answer
  assert.equal(h.posts.length, 1);
  assert.deepEqual(stored(h)?.msg, msg, "stored before the ack");
  h.hanging[0]({ ok: true });
  await h.settle();
  assert.equal(stored(h), undefined);
  assert.equal(outbox.size(), 0);
  assert.equal(h.idles, 1);
});

test("Outbox: a 5xx keeps the snapshot and retries the unchanged content with backoff until it lands", async () => {
  const h = outboxHarness([{ ok: false, retry: true }, { ok: false, retry: true }, { ok: true }]);
  const outbox = new Outbox(h.deps);
  await outbox.enqueue(KEY, msg);
  await h.settle();
  assert.equal(h.posts.length, 1);
  assert.equal(stored(h)?.attempts, 1);
  assert.equal(h.wakes, 1, "a retry asks for the wake-up alarm");
  await h.advance(RETRY_BASE_MS - 1);
  assert.equal(h.posts.length, 1, "no retry before the backoff");
  await h.advance(1);
  assert.equal(h.posts.length, 2);
  await h.advance(RETRY_BASE_MS * 2);
  assert.equal(h.posts.length, 3);
  assert.deepEqual(h.posts.map((m) => m.turns[0].text), ["hi", "hi", "hi"]);
  assert.equal(stored(h), undefined, "removed once the server accepted it");
});

test("Outbox: a timeout or network error (post throws) is retried too", async () => {
  const h = outboxHarness(["throw", { ok: true }]);
  const outbox = new Outbox(h.deps);
  await outbox.enqueue(KEY, msg);
  await h.settle();
  assert.equal(stored(h)?.attempts, 1);
  await h.advance(RETRY_BASE_MS);
  assert.equal(h.posts.length, 2);
  assert.equal(outbox.size(), 0);
});

test("Outbox: a permanent failure (no token, 4xx) is dropped, not retried", async () => {
  const h = outboxHarness([{ ok: false, retry: false }]);
  const outbox = new Outbox(h.deps);
  await outbox.enqueue(KEY, msg);
  await h.settle();
  await h.advance(RETRY_MAX_MS * 2);
  assert.equal(h.posts.length, 1);
  assert.equal(stored(h), undefined);
});

test("Outbox: backoff is capped and retries stop after RETRY_MAX_ATTEMPTS", async () => {
  const h = outboxHarness(Array.from({ length: RETRY_MAX_ATTEMPTS }, () => ({ ok: false, retry: true }) as PostOutcome));
  const outbox = new Outbox(h.deps);
  await outbox.enqueue(KEY, msg);
  await h.settle();
  await h.advance(RETRY_MAX_MS * RETRY_MAX_ATTEMPTS);
  assert.equal(h.posts.length, RETRY_MAX_ATTEMPTS);
  const gaps = h.postTimes.slice(1).map((t, i) => t - h.postTimes[i]);
  assert.deepEqual(gaps, gaps.map((_, i) => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** i)));
  assert.equal(Math.max(...gaps), RETRY_MAX_MS);
  assert.equal(stored(h), undefined);
  assert.equal(outbox.size(), 0);
});

test("Outbox: snapshots coalesce to the latest, during the debounce, a backoff and an in-flight POST", async () => {
  const h = outboxHarness([{ ok: true }, { ok: false, retry: true }, "hang"]);
  const outbox = new Outbox(h.deps);
  await outbox.enqueue(KEY, withText("v1")); // posts at once
  await h.settle();
  await outbox.enqueue(KEY, withText("v2")); // inside the debounce window
  await outbox.enqueue(KEY, withText("v3"));
  await h.advance(DEBOUNCE_MS);
  assert.deepEqual(h.posts.map((m) => m.turns[0].text), ["v1", "v3"]);
  await outbox.enqueue(KEY, withText("v4")); // while v3's retry waits
  await h.advance(RETRY_BASE_MS);
  assert.deepEqual(h.posts.map((m) => m.turns[0].text), ["v1", "v3", "v4"], "the retry sends the newest snapshot");
  await outbox.enqueue(KEY, withText("v5")); // while v4's POST is in flight
  h.hanging[0]({ ok: true });
  await h.settle();
  assert.equal(stored(h)?.msg.turns[0].text, "v5", "a newer snapshot is not removed with the one that landed");
  await h.advance(DEBOUNCE_MS);
  assert.deepEqual(h.posts.map((m) => m.turns[0].text), ["v1", "v3", "v4", "v5"]);
  assert.equal(stored(h), undefined);
});

test("Outbox: the final snapshot skips the debounce", async () => {
  const h = outboxHarness([]);
  const outbox = new Outbox(h.deps);
  await outbox.enqueue(KEY, withText("v1"));
  await h.settle();
  await outbox.enqueue(KEY, withText("v1", true));
  await h.settle();
  assert.equal(h.posts.length, 2);
  assert.equal(h.posts[1].ended, true);
});

test("Outbox: resume() after a worker restart picks up a stored snapshot and retries it", async () => {
  const first = outboxHarness([{ ok: false, retry: true }]);
  await new Outbox(first.deps).enqueue(KEY, msg);
  await first.settle();
  assert.equal(stored(first)?.attempts, 1);
  // Chrome stops the worker: in-memory timers are gone, chrome.storage.session survives.
  const second = outboxHarness([{ ok: true }], first.storage);
  const outbox = new Outbox(second.deps);
  await outbox.resume();
  assert.equal(second.posts.length, 0, "still respects the stored backoff");
  await second.advance(RETRY_BASE_MS);
  assert.equal(second.posts.length, 1);
  assert.deepEqual(second.posts[0], msg);
  assert.equal(stored(second), undefined);
  // Junk under the prefix is ignored.
  const third = outboxHarness([], { [`${OUTBOX_PREFIX}x`]: { msg: "nope" }, other: 1 });
  await new Outbox(third.deps).resume();
  assert.equal(third.posts.length, 0);
});

test("Outbox: a failed store rejects enqueue so the worker can answer ok: false", async () => {
  const h = outboxHarness(["hang"]);
  h.failWrites(true);
  await assert.rejects(new Outbox(h.deps).enqueue(KEY, msg), /quota/);
});
