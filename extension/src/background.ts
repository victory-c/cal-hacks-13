// Service worker: receives turn snapshots from content scripts, queues the newest one per
// conversation in an outbox (chrome.storage.session), throttles and POSTs the whole session to the
// Canon server, which upserts it by session id into the cold archive. Transient failures stay in the
// outbox and are retried with backoff, also after Chrome restarts the worker. The testable pieces
// (shouldDebounce, buildPost, isRetryableStatus, Outbox) are exported; the chrome.* wiring at the
// bottom is guarded so importing this file under node:test has no side effects.

import { ROUTES } from "@canon/shared";
import type { CapturedSession } from "@canon/shared";
import { backoffMs, isTurnsMessage } from "./shared/protocol.ts";
import type { TurnsAck, TurnsMessage } from "./shared/protocol.ts";
import { toCapturedSession } from "./shared/session.ts";
import { readSettings, STORAGE } from "./shared/settings.ts";
import type { PostResult, Settings } from "./shared/settings.ts";

/** Content scripts already wait 1.5 s after the last DOM change; this caps posts while a reply streams. */
export const DEBOUNCE_MS = 2000;
export const POST_TIMEOUT_MS = 5000;
/** Retry schedule for a failed POST: 2 s, 4 s, 8 s … capped at 60 s, then give up after 30 attempts (~25 min). */
export const RETRY_BASE_MS = 2000;
export const RETRY_MAX_MS = 60_000;
export const RETRY_MAX_ATTEMPTS = 30;
export const OUTBOX_PREFIX = "outbox:";

const BADGE = { ok: { text: "•", color: "#2e7d32" }, error: { text: "!", color: "#c62828" } } as const;

/** True when a post for this conversation went out less than `windowMs` ago. The final snapshot never waits. */
export function shouldDebounce(lastPostAt: number | undefined, now: number, ended = false, windowMs = DEBOUNCE_MS): boolean {
  if (ended || lastPostAt === undefined) return false;
  return now - lastPostAt < windowMs;
}

export interface PostRequest {
  url: string;
  init: { method: "POST"; headers: Record<string, string>; body: string };
  session: CapturedSession;
}

/** Builds the request for POST /api/sessions. Throws a message the options page can show when no token is set. */
export function buildPost(msg: TurnsMessage, startedAt: string, settings: Settings, endedAt?: string): PostRequest {
  if (!settings.token) {
    throw new Error("No client token set. Open the Bullwark Capture options page and paste the chatgpt token from CANON_CLIENT_TOKENS.");
  }
  const session = toCapturedSession(msg, startedAt, endedAt, settings.principal);
  return {
    url: `${settings.canonUrl.replace(/\/+$/, "")}${ROUTES.sessions}`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${settings.token}` },
      body: JSON.stringify(session),
    },
    session,
  };
}

/** Worth retrying: the server or a proxy is unavailable, overloaded or timed out. Other 4xx will not change by retrying. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export type PostOutcome = { ok: true } | { ok: false; retry: boolean };

/** One conversation's newest snapshot, as stored under `outbox:<site>:<conversation id>`. */
export interface OutboxEntry {
  msg: TurnsMessage;
  /** Bumped on every new snapshot, so a POST that finishes knows whether something newer arrived meanwhile. */
  version: number;
  /** Consecutive failed POSTs; 0 for a fresh snapshot. */
  attempts: number;
  /** Epoch ms before which no retry is made. */
  notBefore: number;
}

export interface OutboxDeps {
  storage: {
    get(keys: null): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(key: string): Promise<void>;
  };
  /** One POST attempt; reports its own outcome (badge, options page). Must not throw. */
  post(key: string, msg: TurnsMessage): Promise<PostOutcome>;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** A retry is pending: make sure the worker wakes up even if Chrome stops it meanwhile. */
  wake?(): void;
  /** The outbox is empty. */
  idle?(): void;
}

function isOutboxEntry(x: unknown): x is OutboxEntry {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  return isTurnsMessage(e.msg) && typeof e.version === "number" && typeof e.attempts === "number" && typeof e.notBefore === "number";
}

/**
 * The newest unsent snapshot per conversation. A snapshot leaves the outbox only once the server
 * accepted it (or the failure is permanent, or retries ran out); a newer snapshot replaces an older
 * one (coalescing), so a retry always sends the latest transcript. Entries are written to storage
 * before the content script is acknowledged and reloaded by resume(), so they survive the worker
 * being stopped.
 */
export class Outbox {
  private readonly entries = new Map<string, OutboxEntry>();
  private readonly timers = new Map<string, unknown>();
  private readonly posting = new Set<string>();
  private readonly lastPostAt = new Map<string, number>();

  constructor(private readonly deps: OutboxDeps) {}

  /** Queues the snapshot; resolves once it is stored. A storage failure rejects (the caller nacks). */
  async enqueue(key: string, msg: TurnsMessage): Promise<void> {
    const prev = this.entries.get(key);
    const entry: OutboxEntry = { msg, version: (prev?.version ?? 0) + 1, attempts: prev?.attempts ?? 0, notBefore: prev?.notBefore ?? 0 };
    this.entries.set(key, entry);
    try {
      await this.deps.storage.set({ [OUTBOX_PREFIX + key]: entry });
    } finally {
      this.schedule(key);
    }
  }

  /** Reloads stored entries (worker start, retry alarm) and schedules anything without a timer. */
  async resume(): Promise<void> {
    const stored = await this.deps.storage.get(null);
    for (const [storageKey, value] of Object.entries(stored)) {
      if (!storageKey.startsWith(OUTBOX_PREFIX) || !isOutboxEntry(value)) continue;
      const key = storageKey.slice(OUTBOX_PREFIX.length);
      if (!this.entries.has(key)) this.entries.set(key, value);
    }
    for (const key of this.entries.keys()) {
      if (!this.timers.has(key)) this.schedule(key);
    }
  }

  /** Conversations still waiting to reach the server. */
  size(): number {
    return this.entries.size;
  }

  private schedule(key: string): void {
    if (this.posting.has(key)) return; // the running POST reschedules when it settles
    const entry = this.entries.get(key);
    if (!entry) return;
    const waiting = this.timers.get(key);
    if (waiting !== undefined) this.deps.clearTimeout(waiting);
    this.timers.delete(key);
    const now = this.deps.now();
    const last = this.lastPostAt.get(key);
    let at = last !== undefined && shouldDebounce(last, now, entry.msg.ended) ? last + DEBOUNCE_MS : now;
    at = Math.max(at, entry.notBefore);
    if (at <= now) {
      void this.flush(key);
      return;
    }
    this.timers.set(
      key,
      this.deps.setTimeout(() => {
        this.timers.delete(key);
        void this.flush(key);
      }, at - now),
    );
  }

  private async flush(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry || this.posting.has(key)) return;
    this.posting.add(key);
    this.lastPostAt.set(key, this.deps.now());
    let outcome: PostOutcome;
    try {
      outcome = await this.deps.post(key, entry.msg);
    } catch {
      outcome = { ok: false, retry: true };
    }
    const current = this.entries.get(key) ?? entry;
    const newer = current.version !== entry.version;
    try {
      if (!outcome.ok && outcome.retry && entry.attempts + 1 < RETRY_MAX_ATTEMPTS) {
        // Keep the newest snapshot and wait out the backoff; a newer one does not reset it (the server is still down).
        current.attempts = entry.attempts + 1;
        current.notBefore = this.deps.now() + backoffMs(current.attempts, RETRY_BASE_MS, RETRY_MAX_MS);
        await this.deps.storage.set({ [OUTBOX_PREFIX + key]: current });
        this.deps.wake?.();
      } else if (newer) {
        // Done with this snapshot (sent, permanent failure or out of retries); the newer one starts fresh.
        current.attempts = 0;
        current.notBefore = 0;
        await this.deps.storage.set({ [OUTBOX_PREFIX + key]: current });
      } else {
        this.entries.delete(key);
        await this.deps.storage.remove(OUTBOX_PREFIX + key);
        if (this.entries.size === 0) this.deps.idle?.();
      }
    } catch (err) {
      console.warn("[canon] outbox storage failed:", err);
    } finally {
      this.posting.delete(key);
      this.schedule(key);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Chrome wiring. Nothing below runs under node:test.

const RETRY_ALARM = "canon-outbox-retry";

function conversationKey(msg: TurnsMessage): string {
  return `${msg.site}:${msg.conversationId}`;
}

/** First-seen time per conversation, kept in chrome.storage.session so it survives worker restarts but not Chrome restarts. */
async function startedAtFor(key: string): Promise<string> {
  const storageKey = `startedAt:${key}`;
  const stored: unknown = (await chrome.storage.session.get(storageKey))[storageKey];
  if (typeof stored === "string") return stored;
  const now = new Date().toISOString();
  await chrome.storage.session.set({ [storageKey]: now });
  return now;
}

/** One POST attempt for the outbox. Reports the outcome; network errors, timeouts, 408, 429 and 5xx are retried. */
async function post(key: string, msg: TurnsMessage): Promise<PostOutcome> {
  let startedAt: string;
  let settings: Settings;
  try {
    startedAt = await startedAtFor(key);
    settings = await readSettings();
  } catch (err) {
    await report("error", err instanceof Error ? err.message : String(err)); // storage hiccup: retry
    return { ok: false, retry: true };
  }
  let request: PostRequest;
  try {
    request = buildPost(msg, startedAt, settings);
  } catch (err) {
    // No token is a setup problem, not a transient one: report it and drop this snapshot as before.
    await report("error", err instanceof Error ? err.message : String(err));
    return { ok: false, retry: false };
  }
  const { url, init, session } = request;
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
    if (!res.ok) {
      await report("error", `POST ${url} → HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim());
      return { ok: false, retry: isRetryableStatus(res.status) };
    }
    await report("ok", `${session.id} · ${session.messages.length} messages${session.ended_at ? " · ended" : ""}`);
    return { ok: true };
  } catch (err) {
    await report("error", err instanceof Error ? err.message : String(err)); // network error or timeout
    return { ok: false, retry: true };
  }
}

async function report(kind: keyof typeof BADGE, message: string): Promise<void> {
  if (kind === "error") console.warn(`[canon] ${message}`);
  const result: PostResult = { at: new Date().toISOString(), message };
  try {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE[kind].color });
    await chrome.action.setBadgeText({ text: BADGE[kind].text });
    await chrome.storage.local.set({ [kind === "ok" ? STORAGE.lastSuccess : STORAGE.lastError]: result });
  } catch (err) {
    console.warn("[canon] could not record the post result:", err);
  }
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  const outbox = new Outbox({
    storage: {
      get: (keys) => chrome.storage.session.get(keys),
      set: (items) => chrome.storage.session.set(items),
      remove: (key) => chrome.storage.session.remove(key),
    },
    post,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    // Timers die with the worker; the alarm wakes it to resume() whatever is still queued.
    wake: () => void chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 0.5 }),
    idle: () => void chrome.alarms.clear(RETRY_ALARM),
  });
  void outbox.resume().catch((err: unknown) => console.warn("[canon] outbox resume failed:", err));
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== RETRY_ALARM) return;
    void outbox.resume().then(
      () => {
        if (outbox.size() === 0) void chrome.alarms.clear(RETRY_ALARM);
      },
      (err: unknown) => console.warn("[canon] outbox resume failed:", err),
    );
  });
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isTurnsMessage(message)) return;
    // Ack once the snapshot is stored in the outbox: ok means "queued", not "on the server". The POST
    // and its retries follow; a failed store answers ok: false so the content script retries.
    outbox.enqueue(conversationKey(message), message).then(
      () => sendResponse({ ok: true } satisfies TurnsAck),
      (err: unknown) => {
        console.warn("[canon] could not queue the snapshot:", err);
        sendResponse({ ok: false } satisfies TurnsAck);
      },
    );
    return true; // keep the message channel open for the async sendResponse
  });
}
