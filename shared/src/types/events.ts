// Event stream contract. The server emits these over SSE at GET /events; the dashboard,
// distiller worker and benchmark runner consume them. Plain SSE (SpacetimeDB only if there's
// slack on Saturday). Every event carries `at` (ISO 8601).

import type { ClientId, Fact, Folder } from "./fact.ts";
import type { SaveDecision } from "./judge.ts";

export type DistillEngine = "droid" | "claude" | "heuristic";

interface Base {
  at: string;
}

export type CanonEvent =
  | (Base & {
      type: "server.started";
      facts: number;
      sessions: number;
    })
  | (Base & {
      type: "session.captured";
      session: { id: string; client: ClientId; title?: string; messages: number; ended: boolean };
    })
  | (Base & { type: "distill.started"; session_id: string; engine: DistillEngine })
  | (Base & {
      type: "distill.finished";
      session_id: string;
      engine: DistillEngine;
      facts: number;
      /** Droid's plan, shown on the dashboard (Factory track proof). */
      plan?: string;
      duration_ms: number;
    })
  | (Base & { type: "fact.saved"; fact: Fact; decision: SaveDecision })
  | (Base & { type: "fact.retired"; id: string; superseded_by: string })
  | (Base & {
      type: "context.served";
      client: ClientId;
      task: string;
      fact_ids: string[];
      candidates: number;
      /** Estimated tokens handed over. */
      tokens: number;
      latency_ms: number;
      retrieval_ms?: number;
      judge_ms?: number;
      enough: boolean;
    })
  | (Base & { type: "access.denied"; client: ClientId; tool: string; folder: Folder });

export type CanonEventType = CanonEvent["type"];

/** New SSE subscribers get this many recent events replayed first. */
export const EVENT_REPLAY_LIMIT = 100;
