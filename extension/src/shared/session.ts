// Pure mapping from a content-script message to the CapturedSession the server stores. No chrome.*
// and no Node here, so the same code runs in the service worker and under node:test.

import type { CapturedSession, ClientId, SessionMessage } from "@canon/shared";
import type { Site, Turn, TurnsMessage } from "./protocol.ts";

export const TITLE_MAX = 80;

/**
 * FNV-1a 32-bit over the UTF-8 bytes of the input. Sync and dependency-free (crypto.subtle is
 * async and node:crypto is not in the browser), so content script, service worker and tests all
 * derive the same id with no round trip. Collisions across one person's chats are not a concern.
 */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(input)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** `ses_` + 8 hex, stable for one conversation on one site, so every POST upserts the same session. */
export function sessionIdFor(site: Site, conversationId: string): string {
  return `ses_${fnv1a32(`${site}:${conversationId}`).toString(16).padStart(8, "0")}`;
}

// These must match the client names in CANON_CLIENT_TOKENS / the grants table (KNOWN_CLIENTS).
const CLIENTS: Record<Site, ClientId> = { chatgpt: "chatgpt", claude: "claude-web", gemini: "gemini-web" };

export function clientFor(site: Site): ClientId {
  return CLIENTS[site];
}

/** First user turn, whitespace collapsed, cut to TITLE_MAX characters including the ellipsis. */
export function titleFrom(turns: readonly Turn[]): string | undefined {
  const first = turns.find((t) => t.role === "user")?.text.replace(/\s+/g, " ").trim();
  if (!first) return undefined;
  return first.length <= TITLE_MAX ? first : `${first.slice(0, TITLE_MAX - 1)}…`;
}

/**
 * `startedAt` is when the service worker first saw this conversation (kept in chrome.storage.session).
 * `endedAt` is stamped only when the message says the page is going away.
 * v2: every web chat is kind "ai_session"; `principal` (from the options page) goes out only when set.
 */
export function toCapturedSession(msg: TurnsMessage, startedAt: string, endedAt: string = new Date().toISOString(), principal = ""): CapturedSession {
  const turns = [...msg.turns].sort((a, b) => a.index - b.index);
  const messages: SessionMessage[] = turns.map((t) => ({ role: t.role, content: t.text }));
  const session: CapturedSession = {
    id: sessionIdFor(msg.site, msg.conversationId),
    client: clientFor(msg.site),
    started_at: startedAt,
    messages,
    meta: { url: msg.url, site: msg.site },
    kind: "ai_session",
  };
  const title = msg.title ?? titleFrom(turns);
  if (title) session.title = title;
  if (msg.ended) session.ended_at = endedAt;
  const who = normalizePrincipal(principal);
  if (who) session.principal = who;
  return session;
}

/**
 * The principal id every capture path sends, so one person gets one id whether they typed `dan`,
 * `Dan Okafor` or `dan.okafor@harborlane.com` on the options page: " Dan " → "dan",
 * "agt_research_1" kept, a name or an email → its first token ("dan"), "Maya (Compliance)" →
 * "maya". Blank, or nothing that starts with a letter → "" (not sent).
 * Mirrors normalizePrincipal in hooks/claude-code/lib.mjs (the hook and the ingest CLI); keep the
 * two in step.
 */
export function normalizePrincipal(value: unknown): string {
  if (typeof value !== "string") return "";
  const v = value.trim().toLowerCase();
  if (/^[a-z][a-z0-9_]*$/.test(v)) return v;
  const local = /(?<![a-z0-9._+'-])([a-z0-9._+'-]+)@[a-z0-9-]+(?:\.[a-z0-9-]+)+/.exec(v)?.[1];
  const first = (local ?? v).split(/[^a-z0-9]+/).find(Boolean);
  return first && /^[a-z]/.test(first) ? first : "";
}
