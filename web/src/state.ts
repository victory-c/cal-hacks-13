// The dashboard's state and reducer. Pure: no DOM, no fetch, so it runs under node:test.
//
// Why keyed rows: the server replays the last EVENT_REPLAY_LIMIT events to every new SSE
// subscriber, so after a reconnect we see events we already applied. Facts, sessions and
// distills are keyed by id (replay lands on the same row); the served/denied logs have no id,
// so they are deduped by a key built from the event's fields.

import type { CanonEvent, CanonEventType, ClientId, DistillEngine, Fact, SaveDecision } from "@canon/shared";

/** Runtime list of every event type, for EventSource.addEventListener. */
export const EVENT_TYPES = [
  "server.started",
  "session.captured",
  "distill.started",
  "distill.finished",
  "fact.saved",
  "fact.retired",
  "context.served",
  "access.denied",
  // Scopes contract (A1). Listened for, not rendered yet: the reducer passes them through.
  "triage.decided",
  "quarantine.flagged",
  "quarantine.released",
  "scope.stage",
  "scope.updated",
  "principal.changed",
  "handoff.served",
  "audit.logged",
  "dispatch.requested",
  "dispatch.stop_requested",
  "agent.run",
  "agent.step",
  "agent.inbox",
  "fact.filed",
  "item.captured",
  "scope.build",
  "scope.changed",
  "group.created",
] as const satisfies readonly CanonEventType[];

// The typecheck fails here when the contract gains an event type the list above lacks.
type Unlisted = Exclude<CanonEventType, (typeof EVENT_TYPES)[number]>;
const everyTypeListed: Unlisted extends never ? true : never = true;
void everyTypeListed;

/** Logs without ids keep this many rows. Plenty for a demo; bounds memory for a long one. */
export const MAX_LOG = 200;

export interface SessionRow {
  id: string;
  client: ClientId;
  title?: string;
  messages: number;
  ended: boolean;
  at: string;
}

export interface Retirement {
  by: string;
  at: string;
}

export interface FactRow {
  fact: Fact;
  /** Absent for facts loaded over REST: the list endpoint carries no decision. */
  decision?: SaveDecision;
  retired?: Retirement;
  at: string;
}

export interface DistillRow {
  session_id: string;
  engine: DistillEngine;
  status: "running" | "finished";
  facts?: number;
  plan?: string;
  duration_ms?: number;
  at: string;
}

export type ServedRow = Extract<CanonEvent, { type: "context.served" }>;
export type DeniedRow = Extract<CanonEvent, { type: "access.denied" }>;

export interface State {
  server?: { facts: number; sessions: number; at: string };
  sessions: Map<string, SessionRow>;
  facts: Map<string, FactRow>;
  /** Every retirement seen, even for facts not loaded yet (a fact.retired can precede its fact). */
  retired: Map<string, Retirement>;
  /** Keyed by session id: distill.finished replaces distill.started for the same session. */
  distills: Map<string, DistillRow>;
  /** Newest first. */
  served: ServedRow[];
  /** Newest first. */
  denied: DeniedRow[];
  /** Dedupe keys of served/denied events already applied. */
  seen: Set<string>;
}

export function initialState(): State {
  return {
    sessions: new Map(),
    facts: new Map(),
    retired: new Map(),
    distills: new Map(),
    served: [],
    denied: [],
    seen: new Set(),
  };
}

/**
 * Merges the REST fact list (GET /api/facts) into the state. Keeps a decision already learned
 * from a fact.saved event; REST rows have none. `at` falls back to the fact's `updated` date.
 */
export function initFromFacts(facts: readonly Fact[], state: State = initialState()): State {
  let next: State = { ...state, facts: new Map(state.facts), retired: new Map(state.retired) };
  for (const fact of facts) {
    const prev = next.facts.get(fact.id);
    const row: FactRow = { fact, at: prev?.at ?? fact.updated };
    if (prev?.decision) row.decision = prev.decision;
    const retirement = prev?.retired ?? next.retired.get(fact.id);
    if (retirement) row.retired = retirement;
    next.facts.set(fact.id, row);
    if (fact.supersedes && fact.supersedes !== fact.id) next = retire(next, fact.supersedes, fact.id, fact.updated);
  }
  return next;
}

export function reduce(state: State, e: CanonEvent): State {
  switch (e.type) {
    case "server.started":
      return { ...state, server: { facts: e.facts, sessions: e.sessions, at: e.at } };

    case "session.captured": {
      const sessions = new Map(state.sessions);
      const row: SessionRow = { id: e.session.id, client: e.session.client, messages: e.session.messages, ended: e.session.ended, at: e.at };
      if (e.session.title) row.title = e.session.title;
      sessions.set(e.session.id, row);
      return { ...state, sessions };
    }

    case "distill.started": {
      const distills = new Map(state.distills);
      distills.set(e.session_id, { session_id: e.session_id, engine: e.engine, status: "running", at: e.at });
      return { ...state, distills };
    }

    case "distill.finished": {
      const distills = new Map(state.distills);
      const row: DistillRow = { session_id: e.session_id, engine: e.engine, status: "finished", facts: e.facts, duration_ms: e.duration_ms, at: e.at };
      if (e.plan) row.plan = e.plan;
      distills.set(e.session_id, row);
      return { ...state, distills };
    }

    case "fact.saved": {
      const facts = new Map(state.facts);
      const prev = facts.get(e.fact.id);
      const row: FactRow = { fact: e.fact, decision: e.decision, at: e.at };
      const retirement = prev?.retired ?? state.retired.get(e.fact.id);
      if (retirement) row.retired = retirement;
      facts.set(e.fact.id, row);
      let next: State = { ...state, facts };
      // A superseding save retires the old fact even if the server's fact.retired is late or lost.
      const old = e.decision.action === "supersede" ? (e.decision.supersedes ?? e.fact.supersedes) : e.fact.supersedes;
      if (old && old !== e.fact.id) next = retire(next, old, e.fact.id, e.at);
      return next;
    }

    case "fact.retired":
      return retire(state, e.id, e.superseded_by, e.at);

    case "context.served": {
      const key = `served|${e.at}|${e.client}|${e.task}`;
      if (state.seen.has(key)) return state;
      return { ...state, served: insertNewestFirst(state.served, e), seen: new Set(state.seen).add(key) };
    }

    case "access.denied": {
      const key = `denied|${e.at}|${e.client}|${e.tool}|${e.folder}`;
      if (state.seen.has(key)) return state;
      return { ...state, denied: insertNewestFirst(state.denied, e), seen: new Set(state.seen).add(key) };
    }

    // Scope events: the moderator console and member view (lane C) will render these.
    case "triage.decided":
    case "quarantine.flagged":
    case "quarantine.released":
    case "scope.stage":
    case "scope.updated":
    case "principal.changed":
    case "handoff.served":
    case "audit.logged":
    case "dispatch.requested":
    case "dispatch.stop_requested":
    case "agent.run":
    case "agent.step":
    case "agent.inbox":
    case "fact.filed":
    case "item.captured":
    case "scope.build":
    case "scope.changed":
    case "group.created":
      return state;

    default:
      return assertNever(e);
  }
}

/** The latest canon_context call, which the counter hero shows. */
export function lastServed(state: State): ServedRow | undefined {
  return state.served[0];
}

/** Rows newest first, for the lists. ISO timestamps compare as strings. */
export function newestFirst<T extends { at: string }>(rows: Iterable<T>): T[] {
  return Array.from(rows).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

function retire(state: State, id: string, by: string, at: string): State {
  const retired = new Map(state.retired);
  const retirement: Retirement = { by, at };
  retired.set(id, retirement);
  const facts = state.facts;
  const row = facts.get(id);
  if (!row) return { ...state, retired };
  const next = new Map(facts);
  next.set(id, { ...row, retired: retirement });
  return { ...state, retired, facts: next };
}

/** Inserts by `at` descending. Replays arrive in order, but this keeps a late event in place too. */
function insertNewestFirst<T extends { at: string }>(rows: readonly T[], row: T): T[] {
  const i = rows.findIndex((r) => r.at <= row.at);
  const out = rows.slice();
  out.splice(i < 0 ? out.length : i, 0, row);
  return out.slice(0, MAX_LOG);
}

function assertNever(x: never): never {
  throw new Error(`unknown event: ${JSON.stringify(x).slice(0, 120)}`);
}
