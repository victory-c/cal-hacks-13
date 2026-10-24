// Walls contract (finance contract, A1). Deals, the people and agents who may be cleared for them, the
// restricted and watch lists, the compliance review queue and the audit log. Code owns access:
// nothing in here is decided by a model. Jev may flag, rank and pre-screen; only compliance (or a
// deal-status change) lowers a wall.
//
// Summarized in CLAUDE.md "Architecture and contracts". Agree changes with both builders first.

/** Facts nobody needs clearance for. */
export const PUBLIC_WALL = "public" as const;

/** A fact's wall: `public`, or the id of the deal it belongs to (`deal_falcon`). */
export type Wall = typeof PUBLIC_WALL | `deal_${string}`;

export const DEAL_ID_RE = /^deal_[a-z0-9_]+$/;

export function isDealWall(w: string): w is `deal_${string}` {
  return DEAL_ID_RE.test(w);
}

/**
 * confidential: the wall is up. announced: restrictions lift, the deal's facts read as public.
 * terminated: the wall stays up and every agent working the deal stops.
 */
export const DEAL_STATUSES = ["confidential", "announced", "terminated"] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

export interface Deal {
  /** `deal_` + lowercase slug, e.g. `deal_falcon`. Also the fact wall label. */
  id: string;
  /** "Project Falcon" */
  code_name: string;
  /**
   * Every other name that points at the deal: the code name's short form ("Falcon"), company
   * names, tickers. Triage and the exit check match these in code, case-insensitively.
   */
  aliases: string[];
  /** Companies involved. While the deal is confidential they are on the restricted list. */
  companies: string[];
  status: DealStatus;
  /** ISO 8601 */
  status_changed_at: string;
}

/** Private side (deal) or public side (research, trading). Compliance sees everything. */
export const DESKS = ["deal", "research", "trading", "compliance"] as const;
export type Desk = (typeof DESKS)[number];

export interface Principal {
  /** People by first name (`dan`, `maya`); agents `agt_<role>_<n>`. */
  id: string;
  kind: "person" | "agent";
  name: string;
  desk: Desk;
  /** Agents only: the person it works for. An agent is never cleared for more than them. */
  acts_for?: string;
  /**
   * Agents only: the one wall it works behind (`deal_falcon`), or `public`. Its clearance is
   * this side intersected with `acts_for`'s live entitlements, so no grant is ever made for it.
   */
  side?: Wall;
}

/** Who is over which wall. Deny by default: no live entitlement, no deal facts. */
export interface Entitlement {
  principal: string;
  deal: string;
  /** Principal id of the approver (compliance). */
  granted_by: string;
  /** ISO 8601 */
  granted_at: string;
  /** ISO 8601. Past it the entitlement is ignored. Missing = until revoked. */
  expires_at?: string;
  reason: string;
}

/** Shared with staff. Public-side requests that name one are refused with the rule. */
export interface RestrictedEntry {
  company: string;
  ticker?: string;
  added_at: string;
}

/** Secret. Never sent to anyone but compliance and internal workers; refusals give no reason. */
export interface WatchEntry {
  company: string;
  ticker?: string;
  added_at: string;
}

/** The only wording a requester ever sees. It must not leak which deal it protects. */
export const NEUTRAL_REFUSALS = {
  restricted_list: "I can't help with that company right now. It's on the restricted list. Contact compliance.",
  watch_list: "I can't help with that right now.",
} as const;
export type RefusalRule = keyof typeof NEUTRAL_REFUSALS;

/**
 * The compliance queue (Maya's pending list). Lane B creates `label_unsure` and `quarantine`
 * items from triage and `exit_check` items from agent outputs; lane A creates `access_request`.
 */
export const REVIEW_KINDS = ["label_unsure", "quarantine", "access_request", "exit_check"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_STATES = ["open", "approved", "denied"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** Jev's 4 described levels for "how clearly is this access request tied to the deal?". */
export const PRESCREEN_LEVELS = {
  1: "Clearly unrelated to the deal",
  2: "Weak or vague tie",
  3: "Plausible tie, needs a human",
  4: "Clearly needed for the deal work",
} as const;
export type PrescreenLevel = keyof typeof PRESCREEN_LEVELS;

export interface ReviewItem {
  /** `rev_` + hex */
  id: string;
  kind: ReviewKind;
  state: ReviewState;
  created_at: string;
  /** One line for Maya. Compliance-only, so it may name the deal. */
  summary: string;
  /** The captured item / fact / principal / deal / agent run it is about, when known. */
  session_id?: string;
  fact_id?: string;
  principal?: string;
  deal?: string;
  run_id?: string;
  /** The judge's probability behind the flag (confidential, injection, leak), when there was one. */
  p?: number;
  /** quarantine / exit_check: the exact text that tripped it, trimmed. */
  excerpt?: string;
  /** access_request: Jev's pre-screen. 1 and 4 are pre-filled for Maya; 2–3 are borderline. */
  prescreen?: { level: PrescreenLevel; p: number };
  /** label_unsure: the wall triage proposed. Approving applies it. */
  proposed_wall?: Wall;
  resolved_by?: string;
  resolved_at?: string;
  /** access_request approvals expire. */
  expires_at?: string;
}

export const AUDIT_KINDS = [
  "handoff",
  "refusal",
  "access.requested",
  "access.decided",
  "label.changed",
  "deal.status_changed",
  "quarantine",
  "exit_check.blocked",
  "agent.dispatched",
  "agent.cancelled",
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

/** "Who knew what, and when?" One row per handoff, refusal, approval, label or wall change. */
export interface AuditEvent {
  /** `aud_` + hex */
  id: string;
  at: string;
  kind: AuditKind;
  /** Principal or client that caused it. */
  actor: string;
  /** Who it happened to (who received the facts, who was refused). */
  principal?: string;
  deal?: string;
  /** handoff: exactly the facts sent. */
  fact_ids?: string[];
  run_id?: string;
  /** The full reason. Compliance only. */
  detail: string;
}
