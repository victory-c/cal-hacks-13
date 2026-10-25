// Event stream contract. The server emits these over SSE at GET /events; the dashboard,
// distiller worker and benchmark runner consume them. Plain SSE (SpacetimeDB only if there's
// slack on Saturday). Every event carries `at` (ISO 8601).

import type { AgentRun, AgentStep, DispatchRequest, InboxItem } from "./agents.ts";
import type { AgentSummary, ContractHandoff, ContractPrincipal, HandoffCandidate } from "./api.ts";
import type { ClientId, Fact, Folder } from "./fact.ts";
import type { SaveDecision, TriageDecision } from "./judge.ts";
import type { AuditEvent, Group, Principal, QuarantineItem, ScopeStage } from "./scopes.ts";
import type { SourceKind } from "./session.ts";

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
      /** `client` is the capture source (claude-code, chatgpt, ingest); `principal` the author, when the token or the body named one. */
      session: { id: string; client: ClientId; title?: string; messages: number; ended: boolean; principal?: string };
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
  /** A moderator refiled a fact (POST /api/facts/:id/file). Moderators and internal clients only. */
  | (Base & { type: "fact.filed"; fact_id: string; from: Folder; group: Folder; labels: string[] })
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
      /** On a moderator's or member's stream: the handoff behind this context, as the inspector shows it. */
      handoff?: ContractHandoff;
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
      /** One id per build, so a console can group the stages of one build. */
      build_id?: string;
    })
  // ---- Member view (docs/INTEGRATION.md). The server writes these into a person's own stream from
  // the events above; moderators and internal clients keep the originals.
  | (Base & {
      /** `scope.stage` for the caller or their agents, in the contract's names. Counts are within the caller's view. */
      type: "scope.build";
      build_id: string;
      principal: string;
      stage: "exclusions" | "candidates" | "judged" | "done";
      ms: number;
      counts: Record<string, number>;
    })
  | (Base & {
      /** `scope.updated` for the caller or their agents: which facts joined or left. */
      type: "scope.changed";
      principal: string;
      added: string[];
      removed: string[];
    })
  | (Base & {
      /** `session.captured` for an item the caller authored: a capture, a pasted item or a canon_save. */
      type: "item.captured";
      item_id: string;
      kind: SourceKind;
      source: string;
      author?: string;
    })
  | (Base & {
      /**
       * A scope changed: built, rebuilt after a rule edit, or a new fact joined. Moderators and
       * internal clients only. One event per principal: when a creator's scope changes, the
       * server also emits one for each of their agents, with that agent's own added and removed
       * facts. The dispatcher routes from the agent's event only.
       */
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
      /** The audit row's id, which the inspector's record also carries. */
      id?: string;
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
  | (Base & { /** relayed (dispatcher); on a person's stream `run` adds the console's view of the agent */ type: "agent.step"; step: AgentStep; run?: AgentSummary })
  | (Base & { /** relayed (dispatcher); on a person's stream `run` adds the console's view of the agent */ type: "agent.inbox"; item: InboxItem; run?: AgentSummary })
  // ---- Console view (docs/INTEGRATION.md): what a moderator's or member's stream carries instead of
  // the server's own names above. The server derives them; nobody publishes them.
  | (Base & { type: "agent.started"; run: AgentSummary })
  | (Base & { type: "agent.restarted"; run: AgentSummary })
  | (Base & { type: "agent.finished"; run: AgentSummary })
  | (Base & { type: "item.quarantined"; item_id: string; source: string; reason: string })
  | (Base & { type: "item.released"; item_id: string; source: string; facts: number })
  | (Base & { type: "principal.added"; principal: ContractPrincipal })
  | (Base & { type: "principal.tier"; principal: ContractPrincipal })
  | (Base & { type: "group.created"; group: Group });

/** Event types lane B's internal workers may publish through POST /api/events. */
export const RELAYED_EVENTS = ["triage.decided", "quarantine.flagged", "agent.run", "agent.step", "agent.inbox"] as const;
export type RelayedEventType = (typeof RELAYED_EVENTS)[number];

export type CanonEventType = CanonEvent["type"];

/** New SSE subscribers get this many recent events replayed first. */
export const EVENT_REPLAY_LIMIT = 100;
