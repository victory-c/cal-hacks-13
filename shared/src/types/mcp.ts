// The four MCP tools the server exposes. What a call may see depends on the token's class
// (docs/PIPELINE-PRD.md §4.2): a per-person or per-agent token reads its own scope through the
// same handoff the Claude Code hook uses; an operator token without a principal (claude-code,
// chatgpt) keeps the scaffold's folder grants. Mirrors the "MCP tools" table in CLAUDE.md —
// change both together.

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
  /**
   * Operator tokens: Jev's "enough to answer?" verdict, with `missing` saying what to ask for.
   * Person and agent tokens: true when at least one fact was handed over; `missing` is never set
   * (a hint about what the memory lacks is an existence signal).
   */
  enough: boolean;
  missing?: string;
  /** Operator tokens only: how many candidates retrieval produced before Jev filtered them. */
  candidates?: number;
  /** Person and agent tokens: the pinned profile (name, tier, task), as on every handoff. */
  profile?: string;
}

export interface SearchInput {
  query: string;
  /**
   * Narrow to these folders. For a person they narrow within the scope and anything else is
   * ignored silently; for an operator token they are intersected with the client's grants.
   */
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
 * A person's whoami shows who they are and their task, never their exclusions, group names or
 * counts of anything hidden. `read`/`write` are the scaffold's folder grants and appear only for
 * operator tokens, since a list of groups is an existence signal.
 */
export interface WhoamiOutput {
  client: ClientId;
  principal?: string;
  name?: string;
  tier?: "moderator" | "member";
  /** Agents: the person who created them. */
  created_by?: string;
  /** The task from their scope rule. */
  task?: string;
  read?: Folder[];
  write?: Folder[];
}
