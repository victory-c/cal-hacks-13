import type { Folder } from "./types/fact.ts";
import type { Grant } from "./types/grants.ts";

/** True when `folder` is one of the granted folders or nested under one. */
export function folderAllows(granted: readonly Folder[], folder: Folder): boolean {
  return granted.some((g) => folder === g || folder.startsWith(`${g}/`));
}

export function grantFor(grants: readonly Grant[], client: string): Grant | undefined {
  return grants.find((g) => g.client === client);
}

export function canRead(grant: Grant, folder: Folder): boolean {
  return folderAllows(grant.read, folder);
}

export function canWrite(grant: Grant, folder: Folder): boolean {
  return folderAllows(grant.write, folder);
}

/**
 * Parses CANON_CLIENT_TOKENS (`client=token,client=token`) into token → client.
 * Whitespace around entries is ignored; malformed entries are skipped.
 */
export function parseClientTokens(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of (raw ?? "").split(",")) {
    const i = entry.indexOf("=");
    if (i <= 0) continue;
    const client = entry.slice(0, i).trim();
    const token = entry.slice(i + 1).trim();
    if (client && token) map.set(token, client);
  }
  return map;
}
