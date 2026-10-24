// The four MCP tools the server exposes. Every call is scoped to the client token's folders.
// Mirrors the "MCP tools" table in CLAUDE.md — change both together.

import type { ClientId, Fact, FactSource, Folder } from "./fact.ts";
import type { Wall } from "./walls.ts";

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
  /** v2: the fact's wall. Facts reach agents quoted with this label, as data, never instructions. */
  wall?: Wall;
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
  candidates: number;
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

export interface WhoamiOutput {
  client: ClientId;
  read: Folder[];
  write: Folder[];
}
