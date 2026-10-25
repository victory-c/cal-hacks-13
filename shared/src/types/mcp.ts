// The four MCP tools the server exposes. Every call is scoped to the client token's folders.
// Mirrors the "MCP tools" table in CLAUDE.md — change both together.

import type { ClientId, Fact, FactSource, Folder } from "./fact.ts";

export const MCP_TOOLS = {
  context: "canon_context",
  search: "canon_search",
  save: "canon_save",
  whoami: "canon_whoami",
} as const;
export type McpToolName = (typeof MCP_TOOLS)[keyof typeof MCP_TOOLS];

export const DEFAULT_BUDGET_TOKENS = 1500;

export interface ContextInput {
  task: string;
  /** Default 1500. */
  budget_tokens?: number;
}

export interface ContextFact {
  id: string;
  statement: string;
  folder: Folder;
  updated: string;
  source: FactSource;
  /** Jev's P(relevant to this task). */
  relevance: number;
  detail?: string;
}

export interface ContextOutput {
  facts: ContextFact[];
  /** Estimated tokens of the slice handed over (see tokens.ts; label it "est." in UIs). */
  tokens: number;
  latency_ms: number;
  /** Jev's "enough to answer?" verdict. When false, `missing` says what to ask the user for. */
  enough: boolean;
  missing?: string;
  /** How many candidates retrieval produced before Jev filtered them. */
  candidates?: number;
  profile?: string;
}

export interface SearchInput {
  query: string;
  /** Narrow to these folders (still intersected with the client's grants). */
  folders?: Folder[];
}

export interface SearchOutput {
  facts: Fact[];
}

export interface SaveInput {
  text: string;
  /** Hint only. The distiller + Jev decide where it lands. */
  folder?: Folder;
}

/** Saves are queued: text → cold archive → distiller → Jev → hot/cold. Never straight to hot. */
export interface SaveOutput {
  queued: true;
  session_id: string;
}

/**
 * Scopes: a member's whoami shows who they are and their task, never their exclusions, group
 * names or counts of anything hidden. `read`/`write` are the scaffold's folder grants; leave
 * them out for members, since a list of groups is an existence signal.
 */
export interface WhoamiOutput {
  client: ClientId;
  principal?: string;
  created_by?: string;
  name?: string;
  tier?: "moderator" | "member";
  /** The task from their scope rule. */
  task?: string;
  read?: Folder[];
  write?: Folder[];
}
