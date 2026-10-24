// Bearer-token auth and folder grants (task A6). One token per AI client; the token's client
// maps to a Grant (which folders it may read and write). Tokens are dev values from .env, not
// secrets; nothing here is exposed beyond localhost.

import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { isAbsolute, resolve } from "node:path";

import { DEMO_GRANTS, REPO_ROOT, env, parseClientTokens } from "@canon/shared";
import type { Grant } from "@canon/shared";

/** Same values as .env.example, so the stack runs with no .env at all (dev only). */
export const DEV_CLIENT_TOKENS = "claude-code=dev-claude-code,chatgpt=dev-chatgpt,teammate-cursor=dev-teammate-cursor,distiller=dev-distiller";

/** `Authorization: Bearer <token>` → the client it belongs to, or null. */
export function authenticate(req: IncomingMessage, tokens: Map<string, string>): { client: string } | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!m) return null;
  const client = tokens.get(m[1]);
  return client ? { client } : null;
}

/** token → client from CANON_CLIENT_TOKENS, falling back to the dev defaults with a warning. */
export function loadTokens(): Map<string, string> {
  const raw = env("CANON_CLIENT_TOKENS");
  if (raw) {
    const map = parseClientTokens(raw);
    if (map.size === 0) throw new Error('CANON_CLIENT_TOKENS has no "client=token" pairs. See .env.example.');
    return map;
  }
  console.warn("[auth] CANON_CLIENT_TOKENS not set; using the dev tokens from .env.example");
  return parseClientTokens(DEV_CLIENT_TOKENS);
}

/** DEMO_GRANTS, or the JSON Grant[] at CANON_GRANTS_FILE (relative to the repo root). */
export function loadGrants(): Grant[] {
  const file = env("CANON_GRANTS_FILE");
  if (!file) return DEMO_GRANTS.map((g) => ({ ...g, read: [...g.read], write: [...g.write] }));
  const path = isAbsolute(file) ? file : resolve(REPO_ROOT, file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`CANON_GRANTS_FILE ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`CANON_GRANTS_FILE ${path}: expected a JSON array of { client, read, write }`);
  return parsed.map((g, i) => {
    const ok =
      typeof g === "object" && g !== null && typeof g.client === "string" && isStringArray(g.read) && isStringArray(g.write);
    if (!ok) throw new Error(`CANON_GRANTS_FILE ${path}: entry ${i} must be { client: string, read: string[], write: string[] }`);
    return { client: g.client, read: g.read, write: g.write } as Grant;
  });
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((s) => typeof s === "string");
}
