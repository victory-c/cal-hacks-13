// What the options page saves and the service worker reads, all in chrome.storage.local.
// normalizeSettings() is pure so tests can cover the defaults; readSettings() needs chrome.*.

import { DEFAULT_SERVER_URL } from "@canon/shared";

export const STORAGE = {
  canonUrl: "canonUrl",
  token: "token",
  /** Written by the service worker after each POST, read by the options page status line. */
  lastSuccess: "lastSuccess",
  lastError: "lastError",
} as const;

export interface Settings {
  canonUrl: string;
  /** The `chatgpt=…` value from CANON_CLIENT_TOKENS. Empty until the user pastes it. */
  token: string;
}

export interface PostResult {
  at: string;
  message: string;
}

export function normalizeSettings(raw: Record<string, unknown>): Settings {
  const url = typeof raw[STORAGE.canonUrl] === "string" ? (raw[STORAGE.canonUrl] as string).trim() : "";
  const token = typeof raw[STORAGE.token] === "string" ? (raw[STORAGE.token] as string).trim() : "";
  return { canonUrl: url || DEFAULT_SERVER_URL, token };
}

export async function readSettings(): Promise<Settings> {
  return normalizeSettings(await chrome.storage.local.get([STORAGE.canonUrl, STORAGE.token]));
}
