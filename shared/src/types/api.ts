// REST surface of the Canon server (besides MCP at /mcp and SSE at /events).
// Auth on every /api and /mcp call: `Authorization: Bearer <client token>`.

import type { CanonEvent, RelayedEventType } from "./events.ts";
import type { Fact } from "./fact.ts";
import type { Grant } from "./grants.ts";
import type { SaveDecision } from "./judge.ts";
import type { ContextFact } from "./mcp.ts";
import type { CapturedSession } from "./session.ts";
import type { AuditEvent, Deal, DealStatus, Entitlement, Principal, RestrictedEntry, ReviewItem, WatchEntry, Wall } from "./walls.ts";

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

  // ---- v2 (PRD v2). Auth as above. "internal" = INTERNAL_CLIENTS only (distiller, dispatcher).
  /** GET Deal[]. POST /api/deals/:id/status { status } changes it (compliance; emits deal.status_changed). */
  deals: "/api/deals",
  /** GET Principal[] (people and agents). POST registers an agent principal (dispatcher). */
  principals: "/api/principals",
  /** GET Entitlement[] (who is over each wall, expired ones included and marked by date). */
  entitlements: "/api/entitlements",
  /** GET ListsResponse. `watch` is present only for internal clients and compliance. */
  lists: "/api/lists",
  /** GET ReviewItem[] (?state=open). POST creates one (internal). POST /api/review/:id/decision resolves it. */
  review: "/api/review",
  /** POST WallCrossingBody: request access; Jev pre-screens; lands in the review queue. */
  wallCrossings: "/api/wall-crossings",
  /** POST HandoffBody → HandoffResult. The full pipeline: permission filter → search → Jev → budget → audit. Internal. */
  handoff: "/api/handoff",
  /** POST ExitCheckBody → ExitCheckResult. Code names + restricted companies in code, indirect refs via Jev. Internal. */
  exitCheck: "/api/exit-check",
  /** GET AuditEvent[] (?principal=&deal=&since=). */
  audit: "/api/audit",
  /** POST PublishEventBody (internal): re-broadcast one RELAYED_EVENTS event on /events. */
  publish: "/api/events",
  /** POST DispatchRequest (dashboard) → { id }. The server emits dispatch.requested; lane B's dispatcher picks it up. */
  dispatch: "/api/dispatch",
} as const;

export type PostSessionBody = CapturedSession;
export interface PostSessionResponse {
  id: string;
  /** True when this id was seen before (upsert). */
  updated: boolean;
}

export interface PostFactsBody {
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

// ---- v2

export interface DealsResponse {
  deals: Deal[];
}
export interface DealStatusBody {
  status: DealStatus;
}
export interface PrincipalsResponse {
  principals: Principal[];
}
export interface EntitlementsResponse {
  entitlements: Entitlement[];
}
export interface ListsResponse {
  restricted: RestrictedEntry[];
  /** Only for internal clients and compliance. Never sent to anyone else. */
  watch?: WatchEntry[];
}

export interface ReviewResponse {
  items: ReviewItem[];
}
/** The server fills id, state ("open") and created_at. */
export type PostReviewBody = Omit<ReviewItem, "id" | "state" | "created_at" | "resolved_by" | "resolved_at">;
export interface ReviewDecisionBody {
  decision: "approved" | "denied";
  by: string;
  /** access_request approvals: when the entitlement lapses. */
  expires_at?: string;
}

export interface WallCrossingBody {
  principal: string;
  deal: string;
  reason: string;
}

export interface HandoffBody {
  /** Whose slice: a person or an agent principal. Their entitlements decide what is visible. */
  principal: string;
  task: string;
  /** Default DEFAULT_BUDGET_TOKENS. */
  budget_tokens?: number;
  /** Set by the dispatcher so the audit row and inspector link to the agent run. */
  run_id?: string;
}

/** One fact the pipeline considered. `cut` says which stage dropped it; null = handed over. */
export interface HandoffCandidate {
  fact_id: string;
  wall: Wall | "unlabeled";
  /** Dropped by the permission filter, by Jev relevance, or by the token budget. */
  cut: "wall" | "relevance" | "budget" | null;
  /** Jev's P(relevant). Absent for wall cuts: Jev never sees those. */
  p?: number;
  tokens?: number;
}

export type HandoffResult =
  | {
      refused: false;
      facts: ContextFact[];
      /** ~200 tokens: role, desk, current clearances. Always sent. */
      profile: string;
      tokens: number;
      latency_ms: number;
      inject_nothing: boolean;
      candidates: HandoffCandidate[];
      audit_id: string;
    }
  | {
      refused: true;
      /** One of NEUTRAL_REFUSALS. The only thing the requester sees. */
      message: string;
      audit_id: string;
    };

export interface ExitCheckBody {
  /** The agent (or person) whose output is about to leave its side. */
  principal: string;
  text: string;
  run_id?: string;
}
export interface ExitCheckResult {
  blocked: boolean;
  /** Compliance only. Never shown to the agent. */
  hits: string[];
  p?: number;
  /** Set when blocked: the exit_check review item. */
  review_id?: string;
}

export interface AuditResponse {
  entries: AuditEvent[];
}

/** Only RELAYED_EVENTS types; the server stamps `at` when it is missing and rejects the rest. */
export interface PublishEventBody {
  event: Extract<CanonEvent, { type: RelayedEventType }>;
}
