// Client grants: which folders each AI client may read and write. Mirrors the "Client grants"
// section of CLAUDE.md. Nothing external ever reads `private/`.
//
// Tokens come from CANON_CLIENT_TOKENS (format `client=token,client=token`). See ../grants.ts.

import type { ClientId, Folder } from "./fact.ts";

export interface Grant {
  client: ClientId;
  read: Folder[];
  write: Folder[];
  /**
   * The principal this client acts for (`leo` for the desk assistant's token). The permission
   * filter checks that principal's entitlements against each fact's wall, on top of folders.
   */
  principal?: string;
}

/** Internal workers that run on your own machine, not AI clients. Only these may write `private/`. */
export const INTERNAL_CLIENTS = ["distiller", "dispatcher"] as const;

// The scaffold's folders plus the synthetic finance world's top groups: triage files facts into
// deal/falcon, market/public, … so the distiller's grant must cover them.
const ALL_FOLDERS: Folder[] = ["career", "projects", "team", "private", "inbox", "deal", "market", "desk", "firm", "research"];

/** Demo defaults. The server loads these unless CANON_GRANTS_FILE points at a JSON override. */
export const DEMO_GRANTS: readonly Grant[] = [
  { client: "claude-code", read: ["projects", "career"], write: ["projects"] },
  { client: "chatgpt", read: ["career"], write: [] },
  { client: "teammate-cursor", read: ["team"], write: [] },
  // The distiller worker files decided facts into every folder (POST /api/facts).
  { client: "distiller", read: ALL_FOLDERS, write: ALL_FOLDERS },
  // The ingest CLI (hooks/ingest/) only posts raw sessions; it holds no folder access and no
  // principal, so as an operator client it may name each item's principal (the memo's author).
  { client: "ingest", read: [], write: [] },
  // Scopes (A2): one token per synthetic-world person and the dispatcher. Direct folder reads/
  // writes stay deny-by-default; their only access is through their scope (server/src/scopes.ts).
  { client: "dispatcher", read: [], write: [] },
  { client: "maya", read: [], write: [], principal: "maya" },
  { client: "dan", read: [], write: [], principal: "dan" },
  { client: "priya", read: [], write: [], principal: "priya" },
  { client: "leo", read: [], write: [], principal: "leo" },
];
