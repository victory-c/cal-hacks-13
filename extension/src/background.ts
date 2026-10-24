// Service worker: receives turn snapshots from content scripts, throttles per conversation and
// POSTs the whole session to the Canon server, which upserts it by session id into the cold
// archive. The pure pieces (shouldDebounce, buildPost) are exported for tests; the chrome.* wiring
// at the bottom is guarded so importing this file under node:test has no side effects.

import { ROUTES } from "@canon/shared";
import type { CapturedSession } from "@canon/shared";
import { isTurnsMessage } from "./shared/protocol.ts";
import type { TurnsMessage } from "./shared/protocol.ts";
import { toCapturedSession } from "./shared/session.ts";
import { readSettings, STORAGE } from "./shared/settings.ts";
import type { PostResult, Settings } from "./shared/settings.ts";

/** Content scripts already wait 1.5 s after the last DOM change; this caps posts while a reply streams. */
export const DEBOUNCE_MS = 2000;
export const POST_TIMEOUT_MS = 5000;

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
    throw new Error("No client token set. Open the Canon Capture options page and paste the chatgpt token from CANON_CLIENT_TOKENS.");
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

// ---------------------------------------------------------------------------------------------
// Chrome wiring. Nothing below runs under node:test.

// In-memory is fine: when Chrome kills the worker, both maps reset and the next snapshot posts at once.
const lastPostAt = new Map<string, number>();
const pending = new Map<string, { msg: TurnsMessage; timer: ReturnType<typeof setTimeout> }>();

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

function handleTurns(msg: TurnsMessage): void {
  const key = conversationKey(msg);
  const now = Date.now();
  const last = lastPostAt.get(key);
  if (shouldDebounce(last, now, msg.ended)) {
    // Coalesce: keep only the newest snapshot and post it when the window closes.
    const waiting = pending.get(key);
    if (waiting) {
      waiting.msg = msg;
      return;
    }
    const timer = setTimeout(() => {
      const entry = pending.get(key);
      pending.delete(key);
      if (entry) void post(key, entry.msg);
    }, (last ?? now) + DEBOUNCE_MS - now);
    pending.set(key, { msg, timer });
    return;
  }
  const waiting = pending.get(key);
  if (waiting) {
    clearTimeout(waiting.timer); // this snapshot is newer than the one waiting
    pending.delete(key);
  }
  void post(key, msg);
}

async function post(key: string, msg: TurnsMessage): Promise<void> {
  lastPostAt.set(key, Date.now());
  try {
    const settings = await readSettings();
    const { url, init, session } = buildPost(msg, await startedAtFor(key), settings);
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`POST ${url} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`.trim());
    }
    await report("ok", `${session.id} · ${session.messages.length} messages${session.ended_at ? " · ended" : ""}`);
  } catch (err) {
    await report("error", err instanceof Error ? err.message : String(err));
  }
}

async function report(kind: keyof typeof BADGE, message: string): Promise<void> {
  if (kind === "error") console.warn(`[canon] ${message}`);
  const result: PostResult = { at: new Date().toISOString(), message };
  await chrome.action.setBadgeBackgroundColor({ color: BADGE[kind].color });
  await chrome.action.setBadgeText({ text: BADGE[kind].text });
  await chrome.storage.local.set({ [kind === "ok" ? STORAGE.lastSuccess : STORAGE.lastError]: result });
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isTurnsMessage(message)) return;
    sendResponse({ ok: true }); // ack now so the content script's promise settles; the POST follows
    handleTurns(message);
  });
}
