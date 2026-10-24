// Client grants: which folders each AI client may read and write. Mirrors the "Client grants"
// section of CLAUDE.md. Nothing external ever reads `private/`.
//
// Tokens come from CANON_CLIENT_TOKENS (format `client=token,client=token`). See ../grants.ts.

import type { ClientId, Folder } from "./fact.ts";

export interface Grant {
  client: ClientId;
  read: Folder[];
  write: Folder[];
}

/** Internal workers that run on your own machine, not AI clients. Only these may write `private/`. */
export const INTERNAL_CLIENTS = ["distiller"] as const;

const ALL_FOLDERS: Folder[] = ["career", "projects", "team", "private", "inbox"];

/** Demo defaults. The server loads these unless CANON_GRANTS_FILE points at a JSON override. */
export const DEMO_GRANTS: readonly Grant[] = [
  { client: "claude-code", read: ["projects", "career"], write: ["projects"] },
  { client: "chatgpt", read: ["career"], write: [] },
  { client: "teammate-cursor", read: ["team"], write: [] },
  // The distiller worker files decided facts into every folder (POST /api/facts).
  { client: "distiller", read: ALL_FOLDERS, write: ALL_FOLDERS },
];
