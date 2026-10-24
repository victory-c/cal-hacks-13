// Scopes contract (PRD: two tiers and task-built scopes). Access is decided when a scope is
// built, not when a question is asked: a scope is a fixed list of fact ids, built by removing
// excluded groups and labels in code, then Moss candidates, then Jev yes/no per fact. At question
// time code only searches inside that list. Nobody is refused; what is outside a scope simply is
// not in that memory, and nothing names, counts or hints at it.
//
// Summarized in CLAUDE.md "Architecture and contracts". Agree changes with both builders first.

/** Moderators see all memory and manage people and scopes. Members see only their scope. */
export const PRINCIPAL_TIERS = ["moderator", "member"] as const;
export type PrincipalTier = (typeof PRINCIPAL_TIERS)[number];

export interface Principal {
  /** People by first name (`dan`, `maya`); agents `agt_` + slug or hex. */
  id: string;
  kind: "person" | "agent";
  name: string;
  /** People only. An agent is never a moderator and never holds more than its creator. */
  tier?: PrincipalTier;
  /** Agents only: who created it. Its scope is built from, and stays inside, theirs. */
  created_by?: string;
}

/**
 * A group is the one bucket the memory system files a fact into: `deal/falcon`,
 * `research/logistics`, `market/public`. It is the fact's `folder` (facts live at
 * data/facts/<group>/<id>.md). `inbox` holds facts nobody could place; only moderators see it.
 */
export interface Group {
  /** Lowercase slug path, e.g. `deal/falcon`. Exclusions match it and everything under it. */
  id: string;
  /** One line Jev reads when filing a fact or checking an exclusion. Moderators only. */
  description: string;
  /**
   * Names that point at the group (code names, companies, tickers). Triage matches them in code
   * as a filing hint next to Jev's pick. Moderators only: never shown to members or agents.
   */
  aliases?: string[];
}

/** Labels refine a group when it is too coarse (`nimbus`). Lowercase slug. */
export const LABEL_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * What a moderator (or an agent's creator) writes for one principal. The task is shown to that
 * principal and their agents; the exclusions never are.
 */
export interface ScopeRule {
  principal: string;
  /** Plain language: "Write the logistics sector note from public market data". */
  task: string;
  exclude: {
    /** Group ids removed in code before any model runs; a prefix removes its subgroups too. */
    groups: string[];
    /** Labels removed in code. */
    labels: string[];
    /** Plain language ("anything about pending deals"). Jev checks every group and candidate against it; maybe counts as yes. */
    text?: string;
  };
  /** Principal id of whoever set it: a moderator, or the creator for an agent. */
  set_by: string;
  updated_at: string;
}

/** The facts a principal can ever see. Kept current as facts arrive and rules change. */
export interface Scope {
  principal: string;
  fact_ids: string[];
  built_at: string;
  /** The ScopeRule.updated_at it was built from. */
  rule_updated_at: string;
}

/** The scope builder's stages, shown live with measured times (moderators only). */
export const SCOPE_STAGES = ["exclusions", "moss", "jev", "done"] as const;
export type ScopeStage = (typeof SCOPE_STAGES)[number];

/** Captured text held for instructions aimed at an AI. It joins no scope until a moderator releases it. */
export interface QuarantineItem {
  /** `qtn_` + hex */
  id: string;
  session_id: string;
  state: "held" | "released";
  created_at: string;
  /** Jev's P(contains instructions aimed at an AI). */
  p: number;
  /** The text that tripped it, trimmed. Moderators only. */
  excerpt: string;
  /** Who the captured item belongs to, when known. */
  principal?: string;
  released_by?: string;
  released_at?: string;
}

export const AUDIT_KINDS = [
  "scope.built",
  "scope.rule_changed",
  "fact.joined_scope",
  "fact.left_scope",
  "handoff",
  "person.added",
  "tier.changed",
  "agent.created",
  "agent.deleted",
  "fact.filed",
  "quarantine",
  "quarantine.released",
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

/** "Who knew what, and when?" Moderators only. */
export interface AuditEvent {
  /** `aud_` + hex */
  id: string;
  at: string;
  kind: AuditKind;
  /** Principal or client that caused it. */
  actor: string;
  /** Whose scope or memory it touched. */
  principal?: string;
  /** handoff: exactly the facts sent. fact.joined_scope / left_scope: the facts. */
  fact_ids?: string[];
  run_id?: string;
  detail: string;
}
