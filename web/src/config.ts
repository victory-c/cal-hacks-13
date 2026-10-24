// Dashboard settings: which server to talk to, and an optional USD-per-million-token rate for the
// cost line. The URL query wins (a link can carry them), then localStorage, then the contract
// default. Pure over a Storage-like object so it runs under node:test.

import { DEFAULT_SERVER_URL } from "@canon/shared";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const KEYS = { server: "canon.server", rate: "canon.rate" } as const;

/** `?server=` is remembered; otherwise the remembered one; otherwise the contract default. */
export function resolveServerUrl(search: string, storage: StorageLike, fallback: string = DEFAULT_SERVER_URL): string {
  const fromQuery = normalizeUrl(new URLSearchParams(search).get("server"));
  if (fromQuery) {
    storage.setItem(KEYS.server, fromQuery);
    return fromQuery;
  }
  return normalizeUrl(storage.getItem(KEYS.server)) ?? fallback;
}

/**
 * USD per million tokens, or null when nobody set one (then the cost column shows "—": we never
 * assume a price). `?rate=` is remembered; `?rate=0` or junk clears it.
 */
export function resolveRate(search: string, storage: StorageLike): number | null {
  const q = new URLSearchParams(search).get("rate");
  if (q !== null) {
    const n = Number(q);
    if (Number.isFinite(n) && n > 0) {
      storage.setItem(KEYS.rate, String(n));
      return n;
    }
    storage.removeItem(KEYS.rate);
    return null;
  }
  const stored = Number(storage.getItem(KEYS.rate));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

/** http(s) origin + path without a trailing slash, or null when it is not a usable URL. */
export function normalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.toString().replace(/\/+$/, "");
}

/** localStorage when it works (it throws in some private modes), else a per-page memory map. */
export function safeStorage(): StorageLike {
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      ls.getItem(KEYS.server); // throws when storage is blocked
      return ls;
    }
  } catch {
    // fall through to memory
  }
  return memoryStorage();
}

export function memoryStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}
