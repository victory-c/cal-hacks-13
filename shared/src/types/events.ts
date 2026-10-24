// Event stream contract. The server emits these over SSE at GET /events; the dashboard,
// distiller worker and benchmark runner consume them. Plain SSE (SpacetimeDB only if there's
// slack on Saturday). Every event carries `at` (ISO 8601).

import type { AgentRun, AgentStep, DispatchRequest, InboxItem } from "./agents.ts";
import type { HandoffCandidate } from "./api.ts";
import type { ClientId, Fact, Folder } from "./fact.ts";
import type { SaveDecision, TriageDecision } from "./judge.ts";
import type { AuditEvent, Principal, QuarantineItem, ScopeStage } from "./scopes.ts";

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
  | (Base & { type: "access.denied"; client: ClientId; tool: string; folder: Folder })
  // ---- Finance contract (A1). Server-emitted unless marked "relayed": those come from lane B's internal
  // workers through POST /api/events (see RELAYED_EVENTS) and the server re-broadcasts them.
  | (Base & {
      /** relayed (distiller): one per draft fact, including the ones that never became facts. */
      type: "triage.decided";
      session_id: string;
      statement: string;
      decision: TriageDecision;
      fact_id?: string;
    })
  | (Base & {
      /**
       * A captured item held for instructions aimed at an AI. The server emits it from
       * POST /api/quarantine; a worker that flags without holding may still relay it.
       */
      type: "quarantine.flagged";
      session_id: string;
      /** The QuarantineItem id, when the server's queue returned one. */
      quarantine_id: string;
      p: number;
      excerpt: string;
    })
  | (Base & { type: "quarantine.released"; item: QuarantineItem })
  | (Base & {
      /** One scope-builder stage finished, with its measured time. Moderators only. */
      type: "scope.stage";
      principal: string;
      stage: ScopeStage;
      ms: number;
      /** Facts left after this stage. */
      remaining: number;
    })
  | (Base & {
      /** A scope changed: built, rebuilt after a rule edit, or a new fact joined. Moderators only. */
      type: "scope.updated";
      principal: string;
      reason: "built" | "rule_changed" | "fact_joined" | "fact_left" | "fact_filed";
      added: string[];
      removed: string[];
      /** Facts in the scope after the change. */
      size: number;
    })
  | (Base & {
      /** People, tiers and agent profiles. Moderators see all; a member's view shows only their own agents. */
      type: "principal.changed";
      principal: Principal;
      change: "added" | "tier_changed" | "agent_created" | "agent_deleted";
      by: string;
    })
  | (Base & {
      /** Every handoff, for the inspector: what was considered, what was cut, and why. */
      type: "handoff.served";
      principal: string;
      client?: ClientId;
      run_id?: string;
      task: string;
      candidates: HandoffCandidate[];
      fact_ids: string[];
      tokens: number;
      budget_tokens: number;
      latency_ms: number;
      retrieval_ms?: number;
      judge_ms?: number;
      /** Jev said the task needed no stored context: only the pinned profile went out. */
      inject_nothing: boolean;
    })
  | (Base & { type: "audit.logged"; entry: AuditEvent })
  | (Base & {
      /** Someone asked an agent profile to run (POST /api/dispatch). The dispatcher picks it up. */
      type: "dispatch.requested";
      id: string;
      request: DispatchRequest;
    })
  | (Base & { /** relayed (dispatcher) */ type: "agent.run"; run: AgentRun })
  | (Base & { /** relayed (dispatcher) */ type: "agent.step"; step: AgentStep })
  | (Base & { /** relayed (dispatcher) */ type: "agent.inbox"; item: InboxItem });

/** Event types lane B's internal workers may publish through POST /api/events. */
export const RELAYED_EVENTS = ["triage.decided", "quarantine.flagged", "agent.run", "agent.step", "agent.inbox"] as const;
export type RelayedEventType = (typeof RELAYED_EVENTS)[number];

export type CanonEventType = CanonEvent["type"];

/** New SSE subscribers get this many recent events replayed first. */
export const EVENT_REPLAY_LIMIT = 100;
