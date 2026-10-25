// ChatGPT content script: watches the page, extracts the turns and hands them to the service worker.
// Runs in Chrome's isolated world (own JS, shared DOM). Everything that touches the page is below
// the guard at the bottom, so node:test can import extractTurns() with no side effects.

import { backoffMs, isTurnsAck } from "../shared/protocol.ts";
import type { Turn, TurnsMessage } from "../shared/protocol.ts";

/**
 * ChatGPT changes its markup often and without notice. If capture goes quiet, check these first:
 * open DevTools on chatgpt.com and run document.querySelectorAll(SELECTORS.turn).length.
 * As of Oct 2026 each message is one element with data-message-author-role="user" | "assistant".
 */
export const SELECTORS = {
  turn: "[data-message-author-role]",
  roleAttr: "data-message-author-role",
} as const;

/** The 1.5 s wait after the last DOM change; a streaming reply mutates the page many times a second. */
export const SETTLE_MS = 1500;
const TAB_ID_KEY = "canon.tabId";

/**
 * The structural slice of the DOM we need, so tests can pass plain objects. `innerText` is optional
 * because lib.dom's `Element` does not declare it (only HTMLElement does); at runtime every turn
 * element is an HTMLElement, and `textContent` is the fallback for anything else.
 */
export interface TurnElement {
  getAttribute(name: string): string | null;
  innerText?: string;
  textContent?: string | null;
}
export interface TurnRoot {
  querySelectorAll(selector: string): Iterable<TurnElement>;
}

export function extractTurns(root: TurnRoot): Turn[] {
  const turns: Turn[] = [];
  for (const el of root.querySelectorAll(SELECTORS.turn)) {
    const role = el.getAttribute(SELECTORS.roleAttr);
    if (role !== "user" && role !== "assistant") continue; // system/tool nodes are not conversation
    const text = (el.innerText ?? el.textContent ?? "").trim();
    if (!text) continue; // an assistant turn that has not started streaming yet
    turns.push({ role, text, index: turns.length });
  }
  return turns;
}

/**
 * /c/<id> (also /g/<gpt>/c/<id> for custom GPTs) is the conversation. A brand-new chat has no id
 * until the first reply lands, so until then the per-tab id stands in. Recomputed on every pass, so
 * the key follows the URL as soon as it gains an id and when the user switches chats in the sidebar.
 */
export function conversationIdFor(pathname: string, tabId: string): string {
  const match = /\/c\/([^/?#]+)/.exec(pathname);
  return match ? match[1] : `new-${tabId}`;
}

/** document.title is the conversation title, or just the site name before there is one. */
export function pageTitle(raw: string): string | undefined {
  const title = raw
    .replace(/\s*[|\-–—]\s*ChatGPT\s*$/i, "")
    .trim();
  if (!title || /^(ChatGPT|New chat)$/i.test(title)) return undefined;
  return title;
}

/** Retry schedule when the worker does not accept a snapshot: 1 s, 2 s, 4 s … capped at 30 s, 8 tries. */
export const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 30_000;
export const RETRY_MAX_ATTEMPTS = 8;

export interface SenderDeps {
  /** chrome.runtime.sendMessage in the page; may reject or throw (worker gone, extension reloaded). */
  send(msg: TurnsMessage): Promise<unknown>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface Snapshot {
  msg: TurnsMessage;
  fingerprint: string;
}

/**
 * Hands snapshots to the service worker and keeps three states apart: `delivered` (the worker
 * acknowledged it), the one in flight, and the newest one still waiting. Only a delivered or
 * in-flight snapshot is skipped as a duplicate, so a failed delivery is retried with backoff and an
 * unchanged transcript still goes once the worker is back. Snapshots that arrive while one is in
 * flight or backing off collapse into the single waiting slot; the final (`ended`) one never waits.
 */
export class SnapshotSender {
  private delivered = "";
  private inFlight: Snapshot | undefined;
  private latest: Snapshot | undefined;
  private retryTimer: unknown;
  private failures = 0;

  constructor(private readonly deps: SenderDeps) {}

  offer(msg: TurnsMessage, fingerprint: string): void {
    const ended = msg.ended === true;
    if (!ended && (fingerprint === this.delivered || fingerprint === this.inFlight?.fingerprint)) return;
    this.latest = { msg, fingerprint };
    if (ended && this.retryTimer !== undefined) {
      this.deps.clearTimeout(this.retryTimer); // the tab is going away; do not sit out the backoff
      this.retryTimer = undefined;
    }
    if (this.retryTimer === undefined) this.pump();
  }

  private pump(): void {
    if (this.inFlight || !this.latest) return;
    const snap = this.latest;
    this.latest = undefined;
    this.inFlight = snap;
    let reply: Promise<unknown>;
    try {
      reply = Promise.resolve(this.deps.send(snap.msg));
    } catch (err) {
      reply = Promise.reject(err);
    }
    reply.then(
      (res) => this.settle(snap, isTurnsAck(res), res),
      (err: unknown) => this.settle(snap, false, err),
    );
  }

  private settle(snap: Snapshot, ok: boolean, detail: unknown): void {
    this.inFlight = undefined;
    if (ok) {
      this.delivered = snap.fingerprint;
      this.failures = 0;
      if (this.latest && !this.latest.msg.ended && this.latest.fingerprint === this.delivered) this.latest = undefined;
      this.pump();
      return;
    }
    console.debug("[canon] sendMessage failed:", detail);
    this.failures += 1;
    if (!this.latest) this.latest = snap; // keep the newest snapshot; a newer one replaces this one
    if (this.failures >= RETRY_MAX_ATTEMPTS) {
      // Give up for now (e.g. the extension was reloaded under this tab). `delivered` is unchanged,
      // so the next capture, even of the same transcript, tries again.
      this.failures = 0;
      this.latest = undefined;
      return;
    }
    this.retryTimer = this.deps.setTimeout(() => {
      this.retryTimer = undefined;
      this.pump();
    }, backoffMs(this.failures, RETRY_BASE_MS, RETRY_MAX_MS));
  }
}

// ---------------------------------------------------------------------------------------------
// Page wiring. Nothing below runs under node:test.

function tabId(): string {
  let id = sessionStorage.getItem(TAB_ID_KEY);
  if (!id) {
    id = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
    sessionStorage.setItem(TAB_ID_KEY, id);
  }
  return id;
}

function start(): void {
  let timer: number | undefined;
  // Rejects when the worker is unavailable or the extension was reloaded under this tab; the sender retries.
  const sender = new SnapshotSender({
    send: (msg) => chrome.runtime.sendMessage(msg),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  });

  const capture = (ended = false): void => {
    const turns = extractTurns(document);
    if (turns.length === 0) return; // home page, settings, or the chat has not started
    const conversationId = conversationIdFor(location.pathname, tabId());
    // The sender skips snapshots already delivered or in flight (MutationObserver fires for UI noise
    // too). The final one always goes.
    const fingerprint = JSON.stringify([conversationId, turns]);
    const msg: TurnsMessage = { kind: "turns", site: "chatgpt", conversationId, url: location.href, turns };
    const title = pageTitle(document.title);
    if (title) msg.title = title;
    if (ended) msg.ended = true;
    sender.offer(msg, fingerprint);
  };

  const schedule = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => capture(), SETTLE_MS);
  };

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener("pagehide", () => capture(true));
  schedule();
  console.info("[canon] ChatGPT capture active");
}

if (typeof document !== "undefined" && /(^|\.)(chatgpt\.com|chat\.openai\.com)$/.test(location.hostname)) {
  start();
}
