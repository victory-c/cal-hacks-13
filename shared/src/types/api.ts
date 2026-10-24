// REST surface of the Canon server (besides MCP at /mcp and SSE at /events).
// Auth on every /api and /mcp call: `Authorization: Bearer <client token>`.

import type { DistillEngine } from "./events.ts";
import type { Fact } from "./fact.ts";
import type { Grant } from "./grants.ts";
import type { SaveDecision } from "./judge.ts";
import type { CapturedSession } from "./session.ts";

export const DEFAULT_PORTS = { server: 4100, web: 4200, status: 4173 } as const;
export const DEFAULT_SERVER_URL = `http://localhost:${DEFAULT_PORTS.server}`;

export const ROUTES = {
  health: "/health",
  /** SSE stream of CanonEvent. */
  events: "/events",
  /** MCP Streamable HTTP endpoint. */
  mcp: "/mcp",
  /** POST upsert CapturedSession; GET /api/sessions/:id returns it from the cold archive. */
  sessions: "/api/sessions",
  /** GET list (?folder=&tier=); POST writes decided facts (distiller → store). */
  facts: "/api/facts",
  /** GET the grants table, for the dashboard. */
  grants: "/api/grants",
} as const;

export type PostSessionBody = CapturedSession;
export interface PostSessionResponse {
  id: string;
  /** True when this id was seen before (upsert). */
  updated: boolean;
}

export interface PostFactsBody {
  /** Internal worker attribution; emitted after the write succeeds. */
  distillation?: { session_id: string; engine: DistillEngine; plan?: string; duration_ms: number };
  facts: Array<{ fact: Fact; decision: SaveDecision }>;
}
export interface PostFactsResponse {
  saved: string[];
  retired: string[];
}

export interface ListFactsResponse {
  facts: Fact[];
}

export interface HealthResponse {
  ok: true;
  facts: number;
  sessions: number;
  uptime_s: number;
  judge: string;
  retriever: string;
}

export interface GrantsResponse {
  grants: Grant[];
}
