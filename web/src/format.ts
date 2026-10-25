// Pure formatters for the dashboard. No DOM, so they run under node:test.
// Every number on screen goes through here so the labels stay honest: a missing value is "—",
// never 0, and token counts are always presented as estimates by the caller ("est.").

import { KNOWN_CLIENTS } from "@canon/shared";
import type { ClientId } from "@canon/shared";

/** Shown wherever there is no real number yet. */
export const DASH = "—";

function missing(n: number | null | undefined): n is null | undefined {
  return n === null || n === undefined || !Number.isFinite(n) || n < 0;
}

/** 412 → "412 ms", 1400 → "1.4 s", 12_000 → "12 s". */
export function fmtMs(ms: number | null | undefined): string {
  if (missing(ms)) return DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return `${s < 10 ? trimZero(s.toFixed(1)) : String(Math.round(s))} s`;
}

/** 842 → "842", 1400 → "1.4K", 12_300 → "12K", 1_250_000 → "1.3M". */
export function fmtTokens(n: number | null | undefined): string {
  if (missing(n)) return DASH;
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${trimZero((n / 1000).toFixed(1))}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${trimZero((n / 1_000_000).toFixed(1))}M`;
}

/** 0.91 → "91%". Clamped to [0, 1]. */
export function pct(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return DASH;
  return `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`;
}

/**
 * USD for `tokens` at `ratePerMillion` USD per 1M tokens. The rate is user-supplied (?rate=),
 * never built in, so a cost only appears when someone chose a price. Four decimals below a cent.
 */
export function fmtCost(tokens: number | null | undefined, ratePerMillion: number | null | undefined): string {
  if (missing(tokens) || ratePerMillion === null || ratePerMillion === undefined) return DASH;
  if (!Number.isFinite(ratePerMillion) || ratePerMillion <= 0) return DASH;
  const usd = (tokens / 1_000_000) * ratePerMillion;
  if (usd === 0) return "$0";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** "just now", "42 s ago", "5 min ago", "3 h ago", "2 d ago". Future or unparsable → "—"/"just now". */
export function relativeTime(iso: string | null | undefined, now: number | Date = Date.now()): string {
  if (!iso) return DASH;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return DASH;
  const nowMs = typeof now === "number" ? now : now.getTime();
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

// `satisfies` makes the typecheck fail when KNOWN_CLIENTS gains a client we have no label for.
const CLIENT_LABELS = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  hermes: "Hermes",
  chatgpt: "ChatGPT",
  "claude-web": "Claude",
  "gemini-web": "Gemini",
  "gemini-cli": "Gemini CLI",
  "teammate-cursor": "Teammate · Cursor",
  distiller: "Distiller",
} satisfies Record<(typeof KNOWN_CLIENTS)[number], string> & Record<string, string>;

/** Human name for a client id; unknown ids are shown as-is. */
export function clientLabel(client: ClientId): string {
  return (CLIENT_LABELS as Record<string, string | undefined>)[client] ?? client;
}

/** `career/projects` → `career`; `inbox` → `inbox`. */
export function folderTop(folder: string): string {
  const i = folder.indexOf("/");
  return i < 0 ? folder : folder.slice(0, i);
}

/** `career/projects` → `projects`; `career` → "" (the top folder itself). */
export function folderSub(folder: string): string {
  const i = folder.indexOf("/");
  return i < 0 ? "" : folder.slice(i + 1);
}

/** Cuts long task strings for the counter; the full text goes in a title attribute. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function trimZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}
