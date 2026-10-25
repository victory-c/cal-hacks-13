// The member view's side of docs/INTEGRATION.md for person and agent tokens (PIPELINE-PRD §4.6):
// GET /api/me, the contract-shaped GET /api/facts, GET /api/groups inside the scope, POST /api/items,
// PATCH /api/facts/:id, POST /api/facts/:id/retire, GET/POST /api/agents in the contract's shape,
// POST /api/agents/:id/run, PUT /api/principals/:id/rule, and the member's own event stream.
//
// Everything a person reads starts from their scope (a moderator: every hot fact). A fact outside
// it is a 404 with the same bytes as a missing one; nothing names, counts or hints at the rest.
// Operator, internal and tokenless callers never reach these handlers (the router checks the
// token's principal first), so the scaffold's routes and shapes are untouched.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";

import { ROUTES, SOURCE_KINDS, folderAllows, newSessionId, nowIso } from "@canon/shared";
import type {
  AddItemResponse,
  AgentSummary,
  AgentsResponse,
  BuildResponse,
  CanonEvent,
  CapturedSession,
  ContractFact,
  ContractFactsResponse,
  Fact,
  MeResponse,
  Principal,
  SaveDecision,
  SourceKind,
} from "@canon/shared";

import type { EventFilter } from "./events.ts";
import { HttpError, isRecord, readJsonBody, sendJson } from "./http.ts";
import { MODERATORS_ONLY, NOT_YOUR_AGENT, allowedByRule, callerRoles, createAgent, inWorldGroup, logAudit, putRule, requestDispatch, scopeFacts } from "./scopes.ts";
import type { ScopesDeps } from "./scopes.ts";
import type { SessionInfo } from "./store.ts";

const ITEM_KINDS: readonly SourceKind[] = SOURCE_KINDS.filter((k) => k !== "ai_session");

// -------------------------------------------------------------------------------- shapes

/** The contract's fact: group, labels, author, dates and status; the item it came from when the archive still has it. */
export function toContractFact(fact: Fact, item?: SessionInfo): ContractFact {
  const out: ContractFact = {
    id: fact.id,
    statement: fact.statement,
    group: fact.folder,
    labels: fact.labels ? [...fact.labels] : [],
    source: fact.source.session,
    happened_at: fact.happened ?? fact.updated,
    learned_at: fact.updated,
    status: fact.tier,
  };
  if (fact.author) out.author = fact.author;
  if (fact.detail) out.detail = fact.detail;
  if (item?.kind) out.source_kind = item.kind;
  if (item?.title) out.source_title = item.title;
  return out;
}

function isModerator(who: Principal): boolean {
  return who.kind === "person" && who.tier === "moderator";
}

/** Everything a principal may read: their scope, or every hot fact for a moderator. */
function universeOf(deps: ScopesDeps, who: Principal): Fact[] {
  return isModerator(who) ? deps.store.listFacts({ tier: "hot" }) : scopeFacts(deps, who.id);
}

function canSee(deps: ScopesDeps, who: Principal, factId: string): boolean {
  if (isModerator(who)) return deps.store.getFact(factId) !== undefined;
  return deps.world.scopes.get(who.id)?.fact_ids.includes(factId) ?? false;
}

/** "Public market" from `market/public` when the world gives no display name. */
function humanize(groupId: string): string {
  const leaf = groupId.split("/").pop() ?? groupId;
  return leaf.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------------- reads

export function me(deps: ScopesDeps, who: Principal): MeResponse {
  const out: MeResponse = { id: who.id, kind: who.kind, name: who.name };
  if (who.kind === "person" && who.tier) out.tier = who.tier;
  if (who.kind === "agent" && who.created_by) out.creator = who.created_by;
  const task = deps.world.rules.get(who.id)?.task;
  if (task) out.task = task;
  if (deps.world.firm) out.firm = deps.world.firm;
  return out;
}

/** GET /api/facts for a person: the scope in the contract's shape, filterable by group (prefix), label and q. */
export function listContractFacts(deps: ScopesDeps, who: Principal, query: URLSearchParams): ContractFactsResponse {
  const group = query.get("group") ?? undefined;
  const label = query.get("label") ?? undefined;
  const q = query.get("q")?.trim().toLowerCase() || undefined;
  const status = query.get("status") ?? undefined;
  let facts = universeOf(deps, who);
  if (isModerator(who) && status === "cold") facts = deps.store.listFacts({ tier: "cold" });
  const out = facts
    .filter((f) => !group || folderAllows([group], f.folder))
    .filter((f) => !label || (f.labels ?? []).includes(label))
    .filter((f) => !q || f.statement.toLowerCase().includes(q) || (f.detail ?? "").toLowerCase().includes(q))
    .map((f) => toContractFact(f, deps.store.sessionInfo(f.source.session)));
  return { facts: out };
}

/** GET /api/groups for a member: only the groups their scope has a fact in, with display names. */
export function groupsInScope(deps: ScopesDeps, who: Principal): { groups: Array<{ id: string; display: string }> } {
  const present = new Set(universeOf(deps, who).map((f) => f.folder));
  const groups = deps.world.groups
    .filter((g) => [...present].some((folder) => folderAllows([g.id], folder)))
    .map((g) => ({ id: g.id, display: g.display ?? humanize(g.id) }));
  return { groups };
}

/** GET /api/agents: the caller's own agents (every agent for a moderator). Run fields fill in as the dispatcher reports. */
export function listAgents(deps: ScopesDeps, who: Principal): AgentsResponse {
  const agents: AgentSummary[] = [];
  for (const p of deps.world.principals.values()) {
    if (p.kind !== "agent") continue;
    if (!isModerator(who) && p.created_by !== who.id) continue;
    agents.push({
      id: p.id,
      creator: p.created_by ?? "",
      name: p.name,
      status: "ready",
      steps: [],
      files: [],
      inbox: [],
      fact_count: deps.world.scopes.get(p.id)?.fact_ids.length ?? 0,
      pending: 0,
      finished_at: null,
      leave_out: "",
      docs: [],
      schedule: "Only when I press Run",
      outputs: [],
      task: deps.world.rules.get(p.id)?.task ?? "",
    });
  }
  return { agents };
}

// --------------------------------------------------------------------------------- writes

/**
 * POST /api/items: a pasted memo, chat, email, transcript or note becomes one captured session
 * authored by the caller (a moderator may name another author), which the distiller triages like
 * any capture. Origin is left unknown: the text may be from outside the firm (an email), and
 * triage reads unknown origin with extra care.
 */
export async function addItem(deps: ScopesDeps, who: Principal, body: unknown): Promise<AddItemResponse> {
  if (!isRecord(body)) throw new HttpError(400, "body must be { kind, source, text, author? }");
  const { kind, source, text, author } = body;
  if (typeof kind !== "string" || !ITEM_KINDS.includes(kind as SourceKind)) throw new HttpError(400, `kind must be ${ITEM_KINDS.join("|")}`);
  if (typeof source !== "string" || source.trim() === "") throw new HttpError(400, "source must be a non-empty string (where the text comes from)");
  if (typeof text !== "string" || text.trim() === "") throw new HttpError(400, "text must be a non-empty string");
  let principal = who.kind === "agent" ? who.created_by ?? who.id : who.id;
  if (author !== undefined) {
    if (typeof author !== "string" || author.trim() === "") throw new HttpError(400, "author must be a principal id");
    if (author !== principal) {
      if (!isModerator(who)) throw new HttpError(403, "only a moderator may add an item for someone else");
      if (!deps.world.principals.has(author)) throw new HttpError(404, `no principal "${author}"`);
      principal = author;
    }
  }
  const now = nowIso();
  const session: CapturedSession = {
    id: newSessionId(),
    client: "ingest",
    started_at: now,
    ended_at: now,
    title: source.trim(),
    kind: kind as SourceKind,
    principal,
    messages: [{ role: "user", content: text, at: now }],
    meta: { source: "api/items", added_by: who.id },
  };
  await deps.store.putSession(session);
  deps.bus.emit({ type: "session.captured", session: { id: session.id, client: session.client, title: session.title, messages: 1, ended: true } });
  return { item_id: session.id };
}

/** PATCH /api/facts/:id: a person edits the statement of a fact in their scope (same id, learned today). */
export async function editFact(deps: ScopesDeps, who: Principal, factId: string, body: unknown): Promise<ContractFact> {
  const fact = deps.store.getFact(factId);
  if (!fact || !canSee(deps, who, factId)) throw new HttpError(404, `no fact "${factId}"`);
  if (!isRecord(body) || typeof body.statement !== "string" || body.statement.trim() === "") throw new HttpError(400, "body must be { statement }");
  const next: Fact = { ...fact, statement: body.statement.trim(), updated: nowIso().slice(0, 10) };
  const saved = await deps.store.putFact(next);
  logAudit(deps, { kind: "fact.edited", actor: who.id, fact_ids: [saved.id], detail: `${saved.id} statement edited by ${who.id}.` });
  // Re-saved by its reader, not re-judged: the decision keeps the stored probabilities.
  const decision: SaveDecision = { tier: saved.tier, folder: saved.folder, action: "add", keep_p: saved.jev_keep, folder_p: 1, judge: deps.judge.name };
  deps.bus.emit({ type: "fact.saved", fact: saved, decision });
  await deps.world.flush();
  return toContractFact(saved, deps.store.sessionInfo(saved.source.session));
}

/** POST /api/facts/:id/retire: to cold storage, with its history kept; it leaves every scope. */
export async function retireFact(deps: ScopesDeps, who: Principal, factId: string): Promise<{ ok: true }> {
  const fact = deps.store.getFact(factId);
  if (!fact || !canSee(deps, who, factId)) throw new HttpError(404, `no fact "${factId}"`);
  await deps.store.putFact({ ...fact, tier: "cold" });
  logAudit(deps, { kind: "fact.retired", actor: who.id, fact_ids: [fact.id], detail: `${fact.id} retired to cold storage by ${who.id}.` });
  // No successor: `superseded_by` is empty. The living-scope listener takes it out of every scope.
  deps.bus.emit({ type: "fact.retired", id: fact.id, superseded_by: "" });
  await deps.world.flush();
  return { ok: true };
}

// ---------------------------------------------------------------------------------- router

/**
 * Handles the member view's routes for a token bound to a principal. Returns false when the path
 * is none of them, or the token has no principal, so the scopes routes and the scaffold continue.
 */
export async function handleContractRoute(
  deps: ScopesDeps,
  client: string,
  method: string,
  path: string,
  _url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const { principal: who, isModerator: moderator } = callerRoles(deps.world, deps.grants, client);

  if (path === ROUTES.me && method === "GET") {
    if (!who) return sendJson(res, 404, { error: "this token is not a person or agent" }), true;
    return sendJson(res, 200, me(deps, who)), true;
  }
  if (!who) return false;

  // Members see only the groups their scope has facts in; moderators fall through to the full list.
  if (path === ROUTES.groups && method === "GET" && !moderator) return sendJson(res, 200, groupsInScope(deps, who)), true;

  if (path === ROUTES.items && method === "POST") {
    return sendJson(res, 200, await addItem(deps, who, await readJsonBody(req))), true;
  }

  {
    const m = /^\/api\/facts\/([^/]+)$/.exec(path);
    if (m && method === "PATCH") return sendJson(res, 200, await editFact(deps, who, decodeURIComponent(m[1]), await readJsonBody(req))), true;
  }
  {
    const m = /^\/api\/facts\/([^/]+)\/retire$/.exec(path);
    if (m && method === "POST") return sendJson(res, 200, await retireFact(deps, who, decodeURIComponent(m[1]))), true;
  }

  if (path === ROUTES.agents && method === "GET") return sendJson(res, 200, listAgents(deps, who)), true;
  if (path === ROUTES.agents && method === "POST") {
    // Both the scaffold body and the contract's; the reply carries the agent and its build id.
    return sendJson(res, 200, await createAgent(deps, who.id, moderator, await readJsonBody(req))), true;
  }
  {
    const m = /^\/api\/agents\/([^/]+)\/run$/.exec(path);
    if (m && method === "POST") {
      const r = requestDispatch(deps, who.id, moderator, decodeURIComponent(m[1]));
      if ("denied" in r) return sendJson(res, 403, NOT_YOUR_AGENT), true;
      return sendJson(res, 200, { id: r.id }), true;
    }
  }
  {
    const m = /^\/api\/principals\/([^/]+)\/rule$/.exec(path);
    if (m && method === "PUT") {
      const target = decodeURIComponent(m[1]);
      const targetPrincipal = deps.world.principals.get(target);
      const isCreator = targetPrincipal?.kind === "agent" && targetPrincipal.created_by === who.id;
      // The gate runs before anything is looked up for the caller: the same bytes whether the target exists or not.
      if (!moderator && !isCreator) return sendJson(res, 403, MODERATORS_ONLY), true;
      const { build_id } = await putRule(deps, who.id, target, await readJsonBody(req));
      const out: BuildResponse = { build_id };
      return sendJson(res, 200, out), true;
    }
  }
  return false;
}

// ------------------------------------------------------------------------------ event stream

const STAGE_NAMES = { exclusions: "exclusions", moss: "candidates", jev: "judged", done: "done" } as const;

/**
 * A member's own stream (INTEGRATION.md "Events", Members column): their items, facts that are
 * in their scope (or their own, bound to join), their own and their agents' scope changes in the
 * contract's names, their agents' runs, and the context their own AI client was served. No
 * triage, quarantine, audit, refile or other people's events; no exclusion text, no counts of
 * anything hidden.
 */
export function memberEventView(deps: ScopesDeps, who: Principal, client: string): EventFilter {
  const mine = (principalId: string): boolean => principalId === who.id || deps.world.principals.get(principalId)?.created_by === who.id;
  const inScope = (factId: string): boolean => deps.world.scopes.get(who.id)?.fact_ids.includes(factId) ?? false;
  // A member's own new fact is bound to join unless an exclusion removes it in code, so it may be
  // shown at once; with plain-language exclusions the judge still has to speak, so wait for the join.
  const ownAndAllowed = (fact: Fact): boolean => {
    if (fact.author !== who.id || fact.tier !== "hot" || !inWorldGroup(deps, fact)) return false;
    const rule = deps.world.rules.get(who.id);
    return !!rule && rule.exclude.text === undefined && allowedByRule(rule, fact);
  };
  const runAgent = new Map<string, string>(); // run id → agent, learned from agent.run events on this stream
  const ownSession = (id: string): boolean => deps.store.sessionInfo(id)?.principal === who.id;

  return (e: CanonEvent): boolean | CanonEvent => {
    switch (e.type) {
      case "server.started":
        return true;
      case "fact.saved": {
        if (!inScope(e.fact.id) && !ownAndAllowed(e.fact)) return false;
        const { supersedes: previous, ...fact } = e.fact;
        const { supersedes: _p, triage: _t, ...decision } = e.decision;
        const keepPrevious = previous !== undefined && inScope(previous);
        return {
          ...e,
          fact: keepPrevious ? { ...fact, supersedes: previous } : fact,
          decision: keepPrevious ? { ...decision, supersedes: previous } : { ...decision, action: "add" },
        };
      }
      case "fact.retired": {
        // The scope already dropped the id by the time this frame is written (the living-scope
        // listener runs first), so go by the fact's author or the successor's place in the scope.
        const retired = deps.store.getFact(e.id);
        return retired?.author === who.id || (e.superseded_by !== "" && inScope(e.superseded_by)) ? e : false;
      }
      case "scope.stage":
        return mine(e.principal)
          ? { type: "scope.build", at: e.at, build_id: e.build_id ?? "", principal: e.principal, stage: STAGE_NAMES[e.stage], ms: e.ms, counts: { remaining: e.remaining } }
          : false;
      case "scope.updated":
        return mine(e.principal) ? { type: "scope.changed", at: e.at, principal: e.principal, added: [...e.added], removed: [...e.removed] } : false;
      case "session.captured": {
        const info = deps.store.sessionInfo(e.session.id);
        if (!info || info.principal !== who.id) return false;
        return { type: "item.captured", at: e.at, item_id: e.session.id, kind: info.kind ?? "ai_session", source: info.title ?? e.session.client, author: who.id };
      }
      case "distill.started":
        return ownSession(e.session_id) ? e : false;
      case "distill.finished": {
        if (!ownSession(e.session_id)) return false;
        const { plan: _plan, ...safe } = e;
        return safe;
      }
      case "principal.changed":
        return e.principal.id === who.id || e.principal.created_by === who.id ? e : false;
      case "dispatch.requested":
        return mine(e.request.agent) ? e : false;
      case "agent.run":
        if (!mine(e.run.agent)) return false;
        runAgent.set(e.run.id, e.run.agent);
        return e;
      case "agent.step":
        return runAgent.has(e.step.run_id) ? e : false;
      case "agent.inbox":
        return runAgent.has(e.item.run_id) ? e : false;
      case "handoff.served":
        // Their agents' handoffs, without what was considered (moderators-only).
        return e.principal !== who.id && mine(e.principal) ? { ...e, candidates: [] } : false;
      case "context.served":
        return e.client === client ? e : false;
      default:
        return false;
    }
  };
}
