// The moderator console's side of docs/INTEGRATION.md (PIPELINE-PRD §4.6, lane C's
// web/src/moderator): routes the console calls that the scopes surface spells differently, the
// contract's shapes for people, rules, held items, audit rows and handoffs, and the moderator's
// event stream in the contract's names. A moderator sees everything; these handlers only change
// the shape, never the view. Members reach a few of these too (their own scope and handoffs), with
// the same gates the member view uses.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";

import { GROUP_RE, INBOX, ROUTES, folderAllows, nowIso } from "@canon/shared";
import type {
  AgentSummary,
  AuditEvent,
  CanonEvent,
  ContractAuditEntry,
  ContractHandoff,
  ContractHeldItem,
  ContractPrincipal,
  ContractRule,
  Fact,
  Group,
  HandoffsResponse,
  Principal,
  PrincipalScopeResponse,
  QuarantineItem,
  ScopeRule,
} from "@canon/shared";

import type { AgentRuns } from "./agent-runs.ts";
import { toContractFact } from "./contract.ts";
import type { EventFilter } from "./events.ts";
import type { Handoffs } from "./handoffs.ts";
import { HttpError, isRecord, readJsonBody, sendJson } from "./http.ts";
import { MODERATORS_ONLY, callerRoles, logAudit, scopeFacts } from "./scopes.ts";
import type { ScopesDeps } from "./scopes.ts";

export interface ModeratorDeps extends ScopesDeps {
  runs: AgentRuns;
  handoffs: Handoffs;
}

// -------------------------------------------------------------------------------- shapes

/** A stored rule in the contract's shape: `deal` → `deal/*` when it is a prefix, not a group id. */
export function toContractRule(deps: ScopesDeps, rule: ScopeRule): ContractRule {
  const ids = new Set(deps.world.groups.map((g) => g.id));
  return {
    task: rule.task,
    exclusions: {
      groups: rule.exclude.groups.map((g) => (ids.has(g) ? g : `${g}/*`)),
      labels: [...rule.exclude.labels],
      text: rule.exclude.text ? [rule.exclude.text] : [],
    },
  };
}

export function toContractPrincipal(deps: ScopesDeps, p: Principal): ContractPrincipal {
  const out: ContractPrincipal = { id: p.id, kind: p.kind, name: p.name, rule: null, fact_ids: [...(deps.world.scopes.get(p.id)?.fact_ids ?? [])] };
  if (p.kind === "person" && p.tier) out.tier = p.tier;
  if (p.kind === "agent" && p.created_by) out.creator = p.created_by;
  const rule = deps.world.rules.get(p.id);
  if (rule) out.rule = toContractRule(deps, rule);
  return out;
}

/** The console's group: `name` and `display` both carry the display name. */
export function toConsoleGroup(g: Group): Group & { name: string; display: string } {
  const display = g.display ?? humanize(g.id);
  return { ...g, name: display, display };
}

function humanize(groupId: string): string {
  const leaf = groupId.split("/").pop() ?? groupId;
  return leaf.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function toHeldItem(deps: ScopesDeps, q: QuarantineItem): ContractHeldItem {
  const info = deps.store.sessionInfo(q.session_id);
  return { ...q, kind: info?.kind ?? "ai_session", source: info?.title ?? info?.client ?? q.session_id, author: q.principal ?? info?.principal ?? "", reason: q.excerpt, at: q.created_at };
}

/** `group` is the one group every fact the row names sits in, else null. */
export function toAuditEntry(deps: ScopesDeps, e: AuditEvent): ContractAuditEntry {
  const folders = new Set((e.fact_ids ?? []).map((id) => deps.store.getFact(id)?.folder).filter((f): f is string => f !== undefined));
  return { ...e, text: e.detail, group: folders.size === 1 ? [...folders][0] : null };
}

/** An agent as the console lists it: the principal, its rule's task, its scope size and what the dispatcher last reported. */
export function agentSummary(deps: ModeratorDeps, agent: Principal): AgentSummary {
  const run = deps.runs.view(agent.id);
  return {
    id: agent.id,
    creator: agent.created_by ?? "",
    name: agent.name,
    status: run.status,
    steps: run.steps,
    files: run.files,
    inbox: run.inbox,
    task: deps.world.rules.get(agent.id)?.task ?? "",
    fact_count: deps.world.scopes.get(agent.id)?.fact_ids.length ?? 0,
    pending: 0,
    finished_at: run.finished_at,
    leave_out: "",
    docs: [],
    schedule: "Only when I press Run",
    outputs: [],
  };
}

/** The agents a principal may list: their own (every agent for a moderator). */
export function agentSummaries(deps: ModeratorDeps, who: Principal): AgentSummary[] {
  const moderator = who.kind === "person" && who.tier === "moderator";
  const out: AgentSummary[] = [];
  for (const p of deps.world.principals.values()) {
    if (p.kind !== "agent") continue;
    if (!moderator && p.created_by !== who.id) continue;
    out.push(agentSummary(deps, p));
  }
  return out;
}

// -------------------------------------------------------------------------------- handlers

export function principalScope(deps: ScopesDeps, target: string): PrincipalScopeResponse {
  const rule = deps.world.rules.get(target);
  const scope = deps.world.scopes.get(target);
  if (!rule && !scope) throw new HttpError(404, `no scope for "${target}"`);
  const out: PrincipalScopeResponse = { principal: target, rule: rule ? toContractRule(deps, rule) : null, fact_ids: [...(scope?.fact_ids ?? [])] };
  if (scope) out.built_at = scope.built_at;
  return out;
}

/** The moderators-only inbox: facts Jev could not place, waiting to be filed. */
export function inboxFacts(deps: ScopesDeps): Fact[] {
  return deps.store.listFacts({ folder: INBOX, tier: "hot" });
}

const SLUG_RE = /[^a-z0-9]+/g;

/** POST /api/groups (moderator): a new group, filed under `custom/` unless the body names an id. */
export async function createGroup(deps: ScopesDeps, callerId: string, body: unknown): Promise<Group & { name: string; display: string }> {
  if (!isRecord(body)) throw new HttpError(400, "body must be { name, description, id? }");
  const { name, description, id } = body;
  if (typeof name !== "string" || name.trim() === "") throw new HttpError(400, "name must be a non-empty string");
  if (typeof description !== "string") throw new HttpError(400, "description must be a string");
  const slug = name.trim().toLowerCase().replace(SLUG_RE, "-").replace(/^-|-$/g, "");
  const groupId = id === undefined ? `custom/${slug}` : id;
  if (typeof groupId !== "string" || !GROUP_RE.test(groupId) || groupId === INBOX) throw new HttpError(400, `id must be a group path like "custom/${slug || "name"}"`);
  if (deps.world.groups.some((g) => g.id === groupId || (g.display ?? "").toLowerCase() === name.trim().toLowerCase())) throw new HttpError(409, `a group named "${name.trim()}" already exists`);
  const group: Group = { id: groupId, description: description.trim(), display: name.trim() };
  deps.world.groups.push(group);
  deps.world.touch("groups");
  logAudit(deps, { kind: "group.created", actor: callerId, detail: `Group ${group.id} ("${group.display}") created.` });
  deps.bus.emit({ type: "group.created", group: structuredClone(group) });
  await deps.world.flush();
  return toConsoleGroup(group);
}

/**
 * Handles the console's routes. Runs before the scopes surface so it can reshape the moderator's
 * answers; returns false when the path is none of them or the caller is not a principal.
 */
export async function handleModeratorRoute(
  deps: ModeratorDeps,
  client: string,
  method: string,
  path: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const { principal: who, isModerator } = callerRoles(deps.world, deps.grants, client);
  if (!who) return false;
  const state = deps.world;

  // GET /api/principals: the moderator's list carries each person's rule, scope and `creator`.
  if (path === ROUTES.principals && method === "GET" && isModerator) {
    return sendJson(res, 200, { principals: [...state.principals.values()].map((p) => toContractPrincipal(deps, p)) }), true;
  }
  {
    const m = /^\/api\/principals\/([^/]+)\/scope$/.exec(path);
    if (m && method === "GET") {
      const target = decodeURIComponent(m[1]);
      const targetPrincipal = state.principals.get(target);
      const own = target === who.id || (targetPrincipal?.kind === "agent" && targetPrincipal.created_by === who.id);
      // A member asking about anyone else gets the same bytes whether the target exists or not.
      if (!isModerator && !own) return sendJson(res, 403, MODERATORS_ONLY), true;
      const out = principalScope(deps, target);
      // A member never reads their own exclusions, only their task (INTEGRATION.md).
      if (!isModerator && out.rule) out.rule = { task: out.rule.task, exclusions: target === who.id ? { groups: [], labels: [], text: [] } : out.rule.exclusions };
      return sendJson(res, 200, out), true;
    }
  }
  if (path === ROUTES.groups && method === "GET" && isModerator) {
    return sendJson(res, 200, { groups: state.groups.map(toConsoleGroup) }), true;
  }
  if (path === ROUTES.groups && method === "POST") {
    if (!isModerator) return sendJson(res, 403, MODERATORS_ONLY), true;
    return sendJson(res, 200, await createGroup(deps, who.id, await readJsonBody(req))), true;
  }
  if (path === "/api/inbox" && method === "GET") {
    if (!isModerator) return sendJson(res, 403, MODERATORS_ONLY), true;
    return sendJson(res, 200, { facts: inboxFacts(deps).map((f) => toContractFact(f, deps.store.sessionInfo(f.source.session))) }), true;
  }
  if (path === ROUTES.quarantine && method === "GET" && isModerator) {
    const items = [...state.quarantine.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : 1)).map((q) => toHeldItem(deps, q));
    return sendJson(res, 200, { items }), true;
  }
  if (path === ROUTES.audit && method === "GET" && isModerator) {
    const principal = url.searchParams.get("principal") ?? undefined;
    const since = url.searchParams.get("since") ?? undefined;
    if (since !== undefined && Number.isNaN(Date.parse(since))) throw new HttpError(400, "since must be an ISO 8601 timestamp");
    const sinceIso = since === undefined ? undefined : new Date(since).toISOString();
    const entries = state.audit
      .filter((e) => (principal === undefined || e.principal === principal) && (sinceIso === undefined || e.at >= sinceIso))
      .sort((a, b) => (a.at < b.at ? -1 : 1))
      .map((e) => toAuditEntry(deps, e));
    return sendJson(res, 200, { entries }), true;
  }
  if (path === "/api/handoffs" && method === "GET") {
    const principal = url.searchParams.get("principal") ?? undefined;
    // A member sees their own handoffs and their agents'; naming anyone else narrows to nothing.
    const mine = [who.id, ...[...state.principals.values()].filter((p) => p.kind === "agent" && p.created_by === who.id).map((p) => p.id)];
    const principals = isModerator ? (principal ? [principal] : undefined) : principal ? mine.filter((p) => p === principal) : mine;
    const out: HandoffsResponse = { handoffs: deps.handoffs.list({ principals }) };
    return sendJson(res, 200, out), true;
  }
  {
    const m = /^\/api\/agents\/([^/]+)\/stop$/.exec(path);
    if (m && method === "POST") {
      // The dispatcher has no cancel request yet (PIPELINE-PRD §6, lane B); the console gets a clear answer, not a 404.
      const target = decodeURIComponent(m[1]);
      const agent = state.principals.get(target);
      const isCreator = agent?.kind === "agent" && agent.created_by === who.id;
      if (!isModerator && !isCreator) return sendJson(res, 403, { error: "only the agent's creator or a moderator may do this" }), true;
      return sendJson(res, 501, { error: "stopping a run is not implemented yet: the dispatcher has no cancel request; delete the agent to cancel its run" }), true;
    }
  }
  return false;
}

// ------------------------------------------------------------------------------ event stream

const STAGE_NAMES = { exclusions: "exclusions", moss: "candidates", jev: "judged", done: "done" } as const;

/** The handoff behind a handoff.served event, in the inspector's shape. */
export function handoffFromEvent(deps: ScopesDeps, e: Extract<CanonEvent, { type: "handoff.served" }>): ContractHandoff {
  const simulated = deps.judge.name === "fake" || deps.retriever.name !== "moss";
  const out: ContractHandoff = {
    id: e.id ?? `${e.principal}:${e.at}`,
    at: e.at,
    principal: e.principal,
    request: e.task,
    candidates: e.candidates.map((c) => ({
      fact_id: c.fact_id,
      statement: deps.store.getFact(c.fact_id)?.statement ?? "",
      p: typeof c.p === "number" ? c.p : null,
      decision: c.cut === null ? "kept" : c.cut === "budget" ? "cut_budget" : "cut_relevance",
      tokens_est: c.tokens ?? 0,
    })),
    tokens_est: e.tokens,
    budget_est: e.budget_tokens,
    timings_ms: { search: e.retrieval_ms ?? null, judge: e.judge_ms ?? null, total: e.latency_ms },
    simulated,
    inject_nothing: e.inject_nothing,
  };
  if (e.client) out.client = e.client;
  if (e.run_id) out.run_id = e.run_id;
  return out;
}

/** Shared by the moderator and member streams: the dispatcher's run events in the console's names. */
export function agentEventView(deps: ModeratorDeps, e: CanonEvent, mine: (agentId: string) => boolean): CanonEvent | false {
  switch (e.type) {
    case "agent.run": {
      if (!mine(e.run.agent)) return false;
      const agent = deps.world.principals.get(e.run.agent);
      if (!agent) return false;
      const run = agentSummary(deps, agent);
      // The tracker folded this event in before the stream saw it (it subscribes first), so the
      // view already reflects it; the transition it stands for comes from the run's own fields.
      const type = run.status === "done" || run.status === "failed" || run.status === "stopped" ? "agent.finished" : run.status === "restarting" ? "agent.restarted" : e.run.steps === 0 && e.run.state === "queued" ? "agent.started" : "agent.step";
      return type === "agent.step" ? { type: "agent.step", at: e.at, step: { run_id: e.run.id, n: e.run.steps, kind: "message", text: `run ${e.run.state}`, at: e.at }, run } : { type, at: e.at, run };
    }
    case "agent.step": {
      const agentId = deps.runs.agentOf(e.step.run_id);
      const agent = agentId ? deps.world.principals.get(agentId) : undefined;
      if (!agentId || !agent || !mine(agentId)) return false;
      return { ...e, run: agentSummary(deps, agent) };
    }
    case "agent.inbox": {
      const agentId = deps.runs.agentOf(e.item.run_id);
      const agent = agentId ? deps.world.principals.get(agentId) : undefined;
      if (!agentId || !agent || !mine(agentId)) return false;
      return { ...e, run: agentSummary(deps, agent) };
    }
    default:
      return false;
  }
}

/**
 * A moderator's stream: everything, in the contract's names where the console has one
 * (item.captured / item.quarantined / item.released, principal.added / principal.tier,
 * scope.build / scope.changed, agent.started / step / inbox / restarted / finished with the
 * console's run, context.served carrying the inspector's handoff), the server's own events
 * otherwise. Raw extraction plans stay with the distiller.
 */
export function moderatorEventView(deps: ModeratorDeps): EventFilter {
  return (e: CanonEvent): boolean | CanonEvent => {
    switch (e.type) {
      case "distill.finished": {
        const { plan: _plan, ...safe } = e;
        return safe;
      }
      case "session.captured": {
        const info = deps.store.sessionInfo(e.session.id);
        return { type: "item.captured", at: e.at, item_id: e.session.id, kind: info?.kind ?? "ai_session", source: info?.title ?? e.session.title ?? e.session.client, ...(e.session.principal ?? info?.principal ? { author: e.session.principal ?? info?.principal } : {}) };
      }
      case "quarantine.flagged": {
        const info = deps.store.sessionInfo(e.session_id);
        return { type: "item.quarantined", at: e.at, item_id: e.session_id, source: info?.title ?? e.session_id, reason: e.excerpt };
      }
      case "quarantine.released": {
        const info = deps.store.sessionInfo(e.item.session_id);
        return { type: "item.released", at: e.at, item_id: e.item.session_id, source: info?.title ?? e.item.session_id, facts: 0 };
      }
      case "principal.changed": {
        if (e.change === "agent_deleted") return e;
        const current = deps.world.principals.get(e.principal.id) ?? e.principal;
        return { type: e.change === "tier_changed" ? "principal.tier" : "principal.added", at: e.at, principal: toContractPrincipal(deps, current) };
      }
      case "scope.stage":
        return { type: "scope.build", at: e.at, build_id: e.build_id ?? "", principal: e.principal, stage: STAGE_NAMES[e.stage], ms: e.ms, counts: { remaining: e.remaining } };
      case "scope.updated":
        return { type: "scope.changed", at: e.at, principal: e.principal, added: [...e.added], removed: [...e.removed] };
      case "handoff.served": {
        const handoff = handoffFromEvent(deps, e);
        return { type: "context.served", at: e.at, client: e.client ?? "dispatcher", task: e.task, fact_ids: [...e.fact_ids], candidates: e.candidates.length, tokens: e.tokens, latency_ms: e.latency_ms, ...(e.retrieval_ms !== undefined ? { retrieval_ms: e.retrieval_ms } : {}), ...(e.judge_ms !== undefined ? { judge_ms: e.judge_ms } : {}), enough: !e.inject_nothing, handoff };
      }
      case "context.served":
        // The server's own context.served (operator MCP calls) has no handoff behind it; the console reads `handoff`.
        return false;
      case "agent.run":
      case "agent.step":
      case "agent.inbox":
        return agentEventView(deps, e, () => true);
      default:
        return true;
    }
  };
}
