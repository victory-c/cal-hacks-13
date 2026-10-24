// ChatGPT content script: watches the page, extracts the turns and hands them to the service worker.
// Runs in Chrome's isolated world (own JS, shared DOM). Everything that touches the page is below
// the guard at the bottom, so node:test can import extractTurns() with no side effects.

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

function send(msg: TurnsMessage): void {
  try {
    // Rejected when the extension was reloaded under this tab; the next page load fixes it.
    chrome.runtime.sendMessage(msg).catch((err: unknown) => console.debug("[canon] sendMessage failed:", err));
  } catch (err) {
    console.debug("[canon] sendMessage failed:", err);
  }
}

function start(): void {
  let lastSent = "";
  let timer: number | undefined;

  const capture = (ended = false): void => {
    const turns = extractTurns(document);
    if (turns.length === 0) return; // home page, settings, or the chat has not started
    const conversationId = conversationIdFor(location.pathname, tabId());
    // Skip identical snapshots (MutationObserver fires for UI noise too). The final one always goes.
    const fingerprint = JSON.stringify([conversationId, turns]);
    if (!ended && fingerprint === lastSent) return;
    lastSent = fingerprint;
    const msg: TurnsMessage = { kind: "turns", site: "chatgpt", conversationId, url: location.href, turns };
    const title = pageTitle(document.title);
    if (title) msg.title = title;
    if (ended) msg.ended = true;
    send(msg);
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
