// REST surface of the Canon server (besides MCP at /mcp and SSE at /events).
// Auth on every /api and /mcp call: `Authorization: Bearer <client token>`.

import type { CanonEvent, DistillEngine, RelayedEventType } from "./events.ts";
import type { Fact, GroupId } from "./fact.ts";
import type { Grant } from "./grants.ts";
import type { SaveDecision } from "./judge.ts";
import type { ContextFact } from "./mcp.ts";
import type { CapturedSession } from "./session.ts";
import type { AuditEvent, Group, Principal, PrincipalTier, QuarantineItem, Scope, ScopeRule } from "./scopes.ts";

export const DEFAULT_PORTS = { server: 4100, web: 4200, status: 4173 } as const;
export const DEFAULT_SERVER_URL = `http://localhost:${DEFAULT_PORTS.server}`;

export const ROUTES = {
  health: "/health",
  /** SSE stream of CanonEvent. */
  events: "/events",
  /** MCP Streamable HTTP endpoint. */
  mcp: "/mcp",
  /**
   * POST upsert CapturedSession; GET /api/sessions/:id returns it from the cold archive.
   * Scopes: GET is moderators and internal clients only (a raw session holds more than any one
   * scope). On POST the server binds `principal` to a per-person client's own principal (rejects a
   * mismatch); operator and internal clients (ingest, dispatcher) may set it, e.g. the dispatcher
   * posts an agent's outputs with principal = the agent's creator.
   */
  sessions: "/api/sessions",
  /** GET list (?folder=&tier=); POST writes decided facts (distiller → store). */
  facts: "/api/facts",
  /** GET the grants table, for the dashboard. */
  grants: "/api/grants",

  // ---- Scopes (A1). "moderator" = a moderator's client; "internal" = INTERNAL_CLIENTS (distiller,
  // dispatcher). Members never see groups, rules, other people's scopes or the audit log.
  /** GET GroupsResponse (moderator, internal). Triage reads it to file facts. */
  groups: "/api/groups",
  /** GET Principal[] and GET /api/principals/:id (moderator, internal). POST AddPersonBody (moderator). POST /api/principals/:id/tier { tier } (moderator). */
  principals: "/api/principals",
  /**
   * GET /api/scope-rules/:principal (moderator; the creator for their own agents; internal, so the
   * dispatcher can read an agent's task). PUT ScopeRule (moderator; the creator for their own
   * agents). A PUT rebuilds the scope, and every agent built from it.
   */
  scopeRules: "/api/scope-rules",
  /** GET /api/scopes/:principal → Scope (moderator). GET /api/scopes/:principal/facts → Fact[] (internal: an agent's sandbox). */
  scopes: "/api/scopes",
  /** POST CreateAgentBody → Principal (any person, for themselves; built from the creator's scope). DELETE /api/agents/:id. */
  agents: "/api/agents",
  /** GET QuarantineItem[] (moderator). POST PostQuarantineBody (internal). POST /api/quarantine/:id/release (moderator). */
  quarantine: "/api/quarantine",
  /** POST HandoffBody → HandoffResult: Moss inside the scope → Jev relevance → budget → audit. Internal. */
  handoff: "/api/handoff",
  /** GET AuditEvent[] (?principal=&since=) (moderator). */
  audit: "/api/audit",
  /** POST PublishEventBody (internal): re-broadcast one RELAYED_EVENTS event on /events. */
  publish: "/api/events",
  /** POST DispatchRequest → { id } (the agent's creator or a moderator). Emits dispatch.requested. */
  dispatch: "/api/dispatch",
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

// ---- Scopes (A1)

export interface GroupsResponse {
  groups: Group[];
}

export interface PrincipalsResponse {
  principals: Principal[];
}
export interface AddPersonBody {
  id: string;
  name: string;
  tier: PrincipalTier;
  /** The new person's scope rule (members). Moderators see everything and need none. */
  rule?: Pick<ScopeRule, "task" | "exclude">;
}

export interface CreateAgentBody {
  /** The person creating it. A member may only create agents for themselves. */
  created_by: string;
  name: string;
  /** Same form a moderator uses: the task plus optional exclusions. */
  rule: Pick<ScopeRule, "task" | "exclude">;
}

export type ScopeResponse = Scope;
export interface ScopeFactsResponse {
  facts: Fact[];
}

export interface QuarantineResponse {
  items: QuarantineItem[];
}
/** The server fills id, state ("held") and created_at, and returns the QuarantineItem. */
export type PostQuarantineBody = Pick<QuarantineItem, "session_id" | "p" | "excerpt" | "principal">;
export type PostQuarantineResponse = QuarantineItem;

export interface HandoffBody {
  /** Whose slice: a person or an agent principal. Only facts in their scope are ever candidates. */
  principal: string;
  /** The request (a question, or an agent's next step). */
  task: string;
  /** Default DEFAULT_BUDGET_TOKENS. */
  budget_tokens?: number;
  /** Set by the dispatcher so the audit row and inspector link to the agent run. */
  run_id?: string;
}

/** One in-scope fact the pipeline considered. `cut` says which stage dropped it; null = handed over. */
export interface HandoffCandidate {
  fact_id: string;
  group: GroupId;
  cut: "relevance" | "budget" | null;
  /** Jev's P(helps with this request). */
  p?: number;
  tokens?: number;
}

/** Never a refusal: what is outside the scope was never a candidate, so there is nothing to refuse. */
export interface HandoffResult {
  facts: ContextFact[];
  /** About 200 tokens: name, tier and task description. Never the exclusions. Always sent. */
  profile: string;
  tokens: number;
  latency_ms: number;
  inject_nothing: boolean;
  /** Moderators and internal clients only; members never see what was considered. */
  candidates: HandoffCandidate[];
  audit_id: string;
}

export interface AuditResponse {
  entries: AuditEvent[];
}

export type RelayedEvent = Extract<CanonEvent, { type: RelayedEventType }>;

/** `at` becomes optional, per union member, so the discriminant on `type` still narrows. */
type WithOptionalAt<E> = E extends { at: string } ? Omit<E, "at"> & { at?: string } : never;

/**
 * Only RELAYED_EVENTS types; the server rejects the rest. `at` may be omitted: the server stamps
 * it on receipt, and every event it broadcasts on /events carries one.
 */
export interface PublishEventBody {
  event: WithOptionalAt<RelayedEvent>;
}
