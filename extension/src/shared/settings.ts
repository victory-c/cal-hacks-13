// What the options page saves and the service worker reads, all in chrome.storage.local.
// normalizeSettings() is pure so tests can cover the defaults; readSettings() needs chrome.*.

import { DEFAULT_SERVER_URL } from "@canon/shared";
import { normalizePrincipal } from "./session.ts";

export const STORAGE = {
  canonUrl: "canonUrl",
  token: "token",
  /** v2: whose sessions these are (`dan`). Sent as CapturedSession.principal. */
  principal: "principal",
  /** Written by the service worker after each POST, read by the options page status line. */
  lastSuccess: "lastSuccess",
  lastError: "lastError",
} as const;

export interface Settings {
  canonUrl: string;
  /** The `chatgpt=…` value from CANON_CLIENT_TOKENS. Empty until the user pastes it. */
  token: string;
  /**
   * v2: the person's principal id at the firm (`dan`, `priya`), normalized by normalizePrincipal
   * (a name or email becomes its first token, as in the hook and the ingest CLI). Empty = not set:
   * the session goes out with no principal and triage treats it cautiously.
   */
  principal: string;
}

export interface PostResult {
  at: string;
  message: string;
}

export function normalizeSettings(raw: Record<string, unknown>): Settings {
  const text = (key: string): string => (typeof raw[key] === "string" ? (raw[key] as string).trim() : "");
  return {
    canonUrl: text(STORAGE.canonUrl) || DEFAULT_SERVER_URL,
    token: text(STORAGE.token),
    principal: normalizePrincipal(raw[STORAGE.principal]),
  };
}

export async function readSettings(): Promise<Settings> {
  return normalizeSettings(await chrome.storage.local.get([STORAGE.canonUrl, STORAGE.token, STORAGE.principal]));
}
