// Scopes REST surface (task A2): fixture-backed stubs behind the real tier and client gates, so
// lanes B and C build against the final contract while the Moss/Jev scope builder is still open.
//
// What is REAL here: tier enforcement (member vs moderator vs internal client), the no-existence-
// signals rule (a member is told "moderators only" BEFORE anything is looked up, so the same bytes
// come back whether the target exists or not), code-level exclusion filtering wherever a scope is
// (re)built, and the agent-scope-subset check. What is a STUB: scope membership starts from the
// fixtures in distiller/fixtures/world/, a rebuild only removes facts (never adds), and handoff
// relevance is the keyword stub, not Moss + Jev. Those land with the scope-builder tasks.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { URL } from "node:url";

import {
  DEFAULT_BUDGET_TOKENS,
  GROUP_RE,
  INBOX,
  INTERNAL_CLIENTS,
  LABEL_RE,
  PRINCIPAL_TIERS,
  RELAYED_EVENTS,
  REPO_ROOT,
  ROUTES,
  SESSION_ID_RE,
  cutToBudget,
  factTokens,
  folderAllows,
  grantFor,
  nowIso,
} from "@canon/shared";
import type {
  AuditEvent,
  ContextFact,
  Fact,
  Grant,
  Group,
  HandoffCandidate,
  HandoffResult,
  Principal,
  PrincipalTier,
  QuarantineItem,
  Scope,
  ScopeRule,
} from "@canon/shared";

import type { EventBus } from "./events.ts";
import { HttpError, isRecord, readJsonBody, sendJson } from "./http.ts";
import { tokenize } from "./retrieval/keyword.ts";
import type { FileStore } from "./store.ts";

// ---------------------------------------------------------------------------------- fixtures

export interface WorldFixtures {
  groups: Group[];
  principals: Principal[];
  rules: ScopeRule[];
  scopes: Scope[];
  quarantine: QuarantineItem[];
  audit: AuditEvent[];
}

export const WORLD_FIXTURES_DIR = join(REPO_ROOT, "distiller", "fixtures", "world");

/** Reads the synthetic-world state (groups, people, rules, scopes, quarantine, audit). */
export function loadWorldFixtures(dir: string = WORLD_FIXTURES_DIR): WorldFixtures {
  const read = <T>(file: string, key: string): T => {
    const path = join(dir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(`world fixture ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isRecord(parsed) || !Array.isArray(parsed[key])) throw new Error(`world fixture ${path}: expected { ${key}: [...] }`);
    return parsed[key] as T;
  };
  return {
    groups: read<Group[]>("groups.json", "groups"),
    principals: read<Principal[]>("principals.json", "principals"),
    rules: read<ScopeRule[]>("scope-rules.json", "rules"),
    scopes: read<Scope[]>("scopes.json", "scopes"),
    quarantine: read<QuarantineItem[]>("quarantine.json", "items"),
    audit: read<AuditEvent[]>("audit.json", "entries"),
  };
}

/** In-memory world state, one per server. Cloned from the fixtures so instances never share. */
export class ScopeState {
  readonly groups: Group[];
  readonly principals = new Map<string, Principal>();
  readonly rules = new Map<string, ScopeRule>(); // by principal
  readonly scopes = new Map<string, Scope>(); // by principal
  readonly quarantine = new Map<string, QuarantineItem>();
  readonly audit: AuditEvent[];

  constructor(world: WorldFixtures = loadWorldFixtures()) {
    const w = structuredClone(world);
    this.groups = w.groups;
    for (const p of w.principals) this.principals.set(p.id, p);
    for (const r of w.rules) this.rules.set(r.principal, r);
    for (const s of w.scopes) this.scopes.set(s.principal, s);
    for (const q of w.quarantine) this.quarantine.set(q.id, q);
    this.audit = w.audit;
  }
}

export interface ScopesDeps {
  world: ScopeState;
  store: FileStore;
  bus: EventBus;
  grants: readonly Grant[];
}

// ------------------------------------------------------------------------------------ gates

/**
 * The one denial every non-moderator sees on a moderator route, sent BEFORE any lookup of the
 * requested id: the same bytes whether the target exists or not, so nothing outside the caller's
 * view is named, counted or hinted at.
 */
const MODERATORS_ONLY = { error: "moderators only" };
const INTERNAL_ONLY = { error: "internal clients only" };
/** Agent routes: creators are allowed too, so "moderators only" would be wrong — but the body is still one constant. */
const NOT_YOUR_AGENT = { error: "only the agent's creator or a moderator may do this" };

const PERSON_ID_RE = /^[a-z][a-z0-9_-]*$/;

function id(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

// ------------------------------------------------------------------------------------ audit

function logAudit(deps: ScopesDeps, entry: Omit<AuditEvent, "id" | "at">): AuditEvent {
  const full: AuditEvent = { id: id("aud"), at: nowIso(), ...entry };
  deps.world.audit.push(full);
  deps.bus.emit({ type: "audit.logged", entry: full });
  return full;
}

// ------------------------------------------------------------------------- scope building

/** The code-level exclusion filter: excluded groups (prefix) and labels are removed before any model runs. */
function allowedByRule(rule: Pick<ScopeRule, "exclude">, fact: Fact): boolean {
  if (rule.exclude.groups.length && folderAllows(rule.exclude.groups, fact.folder)) return false;
  if (fact.labels?.some((l) => rule.exclude.labels.includes(l))) return false;
  return true;
}

/** Hot facts a scope may ever draw from: never the moderators-only inbox. */
function hotCandidates(deps: ScopesDeps): Fact[] {
  return deps.store.listFacts({ tier: "hot" }).filter((f) => !folderAllows([INBOX], f.folder));
}

/**
 * Builds a scope for a principal (STUB: exclusions in code over the base set; the Moss + Jev
 * selection is a later task, so everything not excluded joins). An agent's base is its creator's
 * scope only, so the subset property holds by construction; it is still asserted below.
 */
function buildScope(deps: ScopesDeps, principal: Principal, rule: ScopeRule): Scope {
  const base =
    principal.kind === "agent" && principal.created_by !== undefined
      ? scopeFacts(deps, principal.created_by)
      : hotCandidates(deps);
  const fact_ids = base.filter((f) => allowedByRule(rule, f)).map((f) => f.id);
  if (principal.kind === "agent" && principal.created_by) {
    // A moderator creator sees everything and has no scope record; any other creator's scope caps the agent's.
    const creatorScope = deps.world.scopes.get(principal.created_by);
    if (creatorScope) {
      const creators = new Set(creatorScope.fact_ids);
      if (!fact_ids.every((fid) => creators.has(fid))) throw new HttpError(500, `agent ${principal.id} scope is not a subset of its creator's`);
    }
  }
  const scope: Scope = { principal: principal.id, fact_ids, built_at: nowIso(), rule_updated_at: rule.updated_at };
  deps.world.scopes.set(principal.id, scope);
  return scope;
}

/** The creator's scope as facts; a moderator creator has no scope and sees every hot fact. */
function scopeFacts(deps: ScopesDeps, principalId: string): Fact[] {
  const creator = deps.world.principals.get(principalId);
  if (creator?.kind === "person" && creator.tier === "moderator") return hotCandidates(deps);
  const scope = deps.world.scopes.get(principalId);
  if (!scope) return [];
  return scope.fact_ids.map((fid) => deps.store.getFact(fid)).filter((f): f is Fact => f !== undefined);
}

/**
 * Re-applies a changed rule to an existing scope. STUB: only removes (newly allowed facts join
 * when the real builder lands); an agent's result is also intersected with its creator's scope,
 * so the subset check holds on every update.
 */
function rebuildScope(deps: ScopesDeps, principal: Principal, rule: ScopeRule): { scope: Scope; removed: string[] } {
  const old = deps.world.scopes.get(principal.id);
  const oldIds = old?.fact_ids ?? [];
  // A moderator creator has no scope record and caps nothing; any other creator's scope caps the agent's.
  const creatorScope = principal.kind === "agent" && principal.created_by ? deps.world.scopes.get(principal.created_by) : undefined;
  const creators = creatorScope ? new Set(creatorScope.fact_ids) : undefined;
  const fact_ids = oldIds.filter((fid) => {
    if (creators && !creators.has(fid)) return false;
    const fact = deps.store.getFact(fid);
    if (!fact) return false;
    return allowedByRule(rule, fact);
  });
  const kept = new Set(fact_ids);
  const removed = oldIds.filter((fid) => !kept.has(fid));
  const scope: Scope = { principal: principal.id, fact_ids, built_at: nowIso(), rule_updated_at: rule.updated_at };
  deps.world.scopes.set(principal.id, scope);
  return { scope, removed };
}

// ------------------------------------------------------------------------------ validation

function parseRuleBody(body: unknown, principal: string, setBy: string, where = "body"): ScopeRule {
  if (!isRecord(body)) throw new HttpError(400, `${where} must be a ScopeRule object`);
  if (body.principal !== undefined && body.principal !== principal) throw new HttpError(400, `${where}.principal must be "${principal}"`);
  const { task, exclude } = body;
  if (typeof task !== "string" || task.trim() === "") throw new HttpError(400, `${where}.task must be a non-empty string`);
  if (!isRecord(exclude) || !Array.isArray(exclude.groups) || !Array.isArray(exclude.labels)) {
    throw new HttpError(400, `${where}.exclude must be { groups: string[], labels: string[], text? }`);
  }
  for (const g of exclude.groups) {
    if (typeof g !== "string" || !GROUP_RE.test(g)) throw new HttpError(400, `${where}.exclude.groups entries must be group paths like "deal/falcon" (got ${JSON.stringify(g)})`);
  }
  for (const l of exclude.labels) {
    if (typeof l !== "string" || !LABEL_RE.test(l)) throw new HttpError(400, `${where}.exclude.labels entries must be lowercase slugs (got ${JSON.stringify(l)})`);
  }
  if (exclude.text !== undefined && typeof exclude.text !== "string") throw new HttpError(400, `${where}.exclude.text must be a string`);
  const clean: ScopeRule = {
    principal,
    task: task.trim(),
    exclude: { groups: exclude.groups as string[], labels: exclude.labels as string[] },
    set_by: setBy,
    updated_at: nowIso(),
  };
  if (typeof exclude.text === "string" && exclude.text.trim() !== "") clean.exclude.text = exclude.text.trim();
  return clean;
}

// --------------------------------------------------------------------------------- handoff

/**
 * STUB relevance: the keyword tokenizer's overlap share stands in for Moss + Jev until the real
 * pipeline lands. Everything else is the real shape: only facts already in the fixed scope are
 * ever candidates, the budget cut, the pinned profile (never the exclusions), the audit row and
 * the handoff.served event.
 */
function runHandoff(deps: ScopesDeps, client: string, body: unknown): HandoffResult {
  const t0 = performance.now();
  if (!isRecord(body)) throw new HttpError(400, "body must be a HandoffBody object");
  const { principal, task, budget_tokens, run_id } = body;
  if (typeof principal !== "string" || principal === "") throw new HttpError(400, "body.principal must be a principal id");
  if (typeof task !== "string" || task.trim() === "") throw new HttpError(400, "body.task must be a non-empty string");
  if (budget_tokens !== undefined && (typeof budget_tokens !== "number" || !Number.isFinite(budget_tokens) || budget_tokens <= 0)) {
    throw new HttpError(400, "body.budget_tokens must be a positive number");
  }
  if (run_id !== undefined && typeof run_id !== "string") throw new HttpError(400, "body.run_id must be a string");
  const who = deps.world.principals.get(principal);
  if (!who) throw new HttpError(404, `no principal "${principal}"`); // internal callers only; no member sees this
  const scope = deps.world.scopes.get(principal);
  if (!scope) throw new HttpError(404, `no scope for "${principal}"`);
  const budget = budget_tokens ?? DEFAULT_BUDGET_TOKENS;

  // Only facts inside the fixed scope are ever candidates; what is outside was never considered.
  const inScope = scope.fact_ids.map((fid) => deps.store.getFact(fid)).filter((f): f is Fact => f !== undefined);
  const query = tokenize(task);
  const scored = inScope.map((fact) => {
    const tokens = tokenize(`${fact.statement} ${fact.detail ?? ""} ${fact.folder.replaceAll("/", " ")}`);
    let matched = 0;
    for (const t of query) if (tokens.has(t)) matched++;
    return { fact, p: query.size === 0 ? 0 : matched / query.size };
  });
  const relevant = scored
    .filter((s) => s.p > 0)
    .sort((a, b) => (b.p !== a.p ? b.p - a.p : a.fact.updated !== b.fact.updated ? (a.fact.updated < b.fact.updated ? 1 : -1) : a.fact.id < b.fact.id ? -1 : 1));
  const { kept, tokens } = cutToBudget(relevant.map((s) => s.fact), budget);
  const keptIds = new Set(kept.map((f) => f.id));

  const candidates: HandoffCandidate[] = scored.map(({ fact, p }) => ({
    fact_id: fact.id,
    group: fact.folder,
    cut: keptIds.has(fact.id) ? null : p > 0 ? "budget" : "relevance",
    p,
    tokens: factTokens(fact),
  }));
  const byId = new Map(scored.map((s) => [s.fact.id, s.p]));
  const facts: ContextFact[] = kept.map((f) => {
    const out: ContextFact = { id: f.id, statement: f.statement, folder: f.folder, updated: f.updated, source: f.source, relevance: byId.get(f.id) ?? 0 };
    if (f.detail) out.detail = f.detail;
    return out;
  });

  // The pinned profile: who they are and their task. Never the exclusions, groups or counts.
  const rule = deps.world.rules.get(principal);
  const tier = who.kind === "agent" ? `agent created by ${who.created_by ?? "unknown"}` : (who.tier ?? "member");
  const profile = `${who.name} (${tier}). Task: ${rule?.task ?? "none set"}.`;

  const latency_ms = Math.round(performance.now() - t0);
  const entry = logAudit(deps, {
    kind: "handoff",
    actor: client,
    principal,
    fact_ids: kept.map((f) => f.id),
    ...(typeof run_id === "string" ? { run_id } : {}),
    detail: task.trim(),
  });
  deps.bus.emit({
    type: "handoff.served",
    principal,
    client,
    ...(typeof run_id === "string" ? { run_id } : {}),
    task: task.trim(),
    candidates,
    fact_ids: kept.map((f) => f.id),
    tokens,
    budget_tokens: budget,
    latency_ms,
    inject_nothing: facts.length === 0,
  });
  return { facts, profile, tokens, latency_ms, inject_nothing: facts.length === 0, candidates, audit_id: entry.id };
}

// ---------------------------------------------------------------------------------- router

/**
 * Handles the scopes routes (ROUTES.groups … ROUTES.dispatch) for an authenticated client.
 * Returns false when the path is none of them, so the caller's routing continues.
 */
export async function handleScopesRoute(
  deps: ScopesDeps,
  client: string,
  method: string,
  path: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const state = deps.world;
  const callerId = grantFor(deps.grants, client)?.principal ?? client;
  const caller = state.principals.get(callerId);
  const isModerator = caller?.kind === "person" && caller.tier === "moderator";
  const isInternal = (INTERNAL_CLIENTS as readonly string[]).includes(client);

  // ---- GET /api/groups (moderator, internal): triage reads it to file facts.
  if (path === ROUTES.groups && method === "GET") {
    if (!isModerator && !isInternal) return sendJson(res, 403, MODERATORS_ONLY), true;
    return sendJson(res, 200, { groups: state.groups }), true;
  }

  // ---- /api/principals (moderator only, checked before anything is read or looked up).
  if (path === ROUTES.principals || path.startsWith(`${ROUTES.principals}/`)) {
    if (!isModerator) return sendJson(res, 403, MODERATORS_ONLY), true;
    if (method === "GET" && path === ROUTES.principals) {
      return sendJson(res, 200, { principals: [...state.principals.values()] }), true;
    }
    if (method === "POST" && path === ROUTES.principals) {
      return sendJson(res, 200, addPerson(deps, callerId, await readJsonBody(req))), true;
    }
    const m = /^\/api\/principals\/([^/]+)\/tier$/.exec(path);
    if (method === "POST" && m) {
      return sendJson(res, 200, changeTier(deps, callerId, decodeURIComponent(m[1]), await readJsonBody(req))), true;
    }
    return false;
  }

  // ---- /api/scope-rules/:principal (moderator; the creator for their own agents).
  if (path.startsWith(`${ROUTES.scopeRules}/`)) {
    const target = decodeURIComponent(path.slice(ROUTES.scopeRules.length + 1));
    const targetPrincipal = state.principals.get(target);
    const isCreator = targetPrincipal?.kind === "agent" && targetPrincipal.created_by === callerId;
    // A member asking about anything that is not their own agent gets the same bytes whether the
    // target exists or not. Members never read their own rule: exclusions are never shown to them.
    if (!isModerator && !isCreator) return sendJson(res, 403, MODERATORS_ONLY), true;
    if (method === "GET") {
      const rule = state.rules.get(target);
      if (!rule) throw new HttpError(404, `no scope rule for "${target}"`);
      return sendJson(res, 200, rule), true;
    }
    if (method === "PUT") {
      if (!targetPrincipal) throw new HttpError(404, `no principal "${target}"`);
      const rule = parseRuleBody(await readJsonBody(req), target, callerId);
      state.rules.set(target, rule);
      const { scope, removed } = rebuildScope(deps, targetPrincipal, rule);
      logAudit(deps, { kind: "scope.rule_changed", actor: callerId, principal: target, fact_ids: removed, detail: `Rule updated: "${rule.task}". ${removed.length} fact(s) left the scope.` });
      deps.bus.emit({ type: "scope.updated", principal: target, reason: "rule_changed", added: [], removed, size: scope.fact_ids.length });
      return sendJson(res, 200, rule), true;
    }
    return false;
  }

  // ---- /api/scopes/:principal and /api/scopes/:principal/facts (moderator, internal).
  if (path.startsWith(`${ROUTES.scopes}/`)) {
    if (!isModerator && !isInternal) return sendJson(res, 403, MODERATORS_ONLY), true;
    if (method !== "GET") return false;
    const m = /^\/api\/scopes\/([^/]+)(\/facts)?$/.exec(path);
    if (!m) return false;
    const target = decodeURIComponent(m[1]);
    const scope = state.scopes.get(target);
    if (!scope) throw new HttpError(404, `no scope for "${target}"`);
    if (m[2]) {
      const facts = scope.fact_ids.map((fid) => deps.store.getFact(fid)).filter((f): f is Fact => f !== undefined);
      return sendJson(res, 200, { facts }), true;
    }
    return sendJson(res, 200, scope), true;
  }

  // ---- /api/agents (POST: any person for themselves; DELETE: the creator or a moderator).
  if (path === ROUTES.agents && method === "POST") {
    return sendJson(res, 200, createAgent(deps, callerId, isModerator, await readJsonBody(req))), true;
  }
  if (path.startsWith(`${ROUTES.agents}/`) && method === "DELETE") {
    const target = decodeURIComponent(path.slice(ROUTES.agents.length + 1));
    const targetPrincipal = state.principals.get(target);
    const isCreator = targetPrincipal?.kind === "agent" && targetPrincipal.created_by === callerId;
    if (!isModerator && !isCreator) return sendJson(res, 403, NOT_YOUR_AGENT), true;
    if (!targetPrincipal || targetPrincipal.kind !== "agent") throw new HttpError(404, `no agent "${target}"`);
    state.principals.delete(target);
    state.rules.delete(target);
    state.scopes.delete(target);
    logAudit(deps, { kind: "agent.deleted", actor: callerId, principal: target, detail: `Agent "${targetPrincipal.name}" deleted.` });
    deps.bus.emit({ type: "principal.changed", principal: targetPrincipal, change: "agent_deleted", by: callerId });
    return sendJson(res, 200, { ok: true }), true;
  }

  // ---- /api/quarantine (GET: moderator. POST: internal. :id/release: moderator).
  if (path === ROUTES.quarantine && method === "GET") {
    if (!isModerator) return sendJson(res, 403, MODERATORS_ONLY), true;
    const items = [...state.quarantine.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    return sendJson(res, 200, { items }), true;
  }
  if (path === ROUTES.quarantine && method === "POST") {
    if (!isInternal) return sendJson(res, 403, INTERNAL_ONLY), true;
    return sendJson(res, 200, holdQuarantine(deps, client, await readJsonBody(req))), true;
  }
  {
    const m = /^\/api\/quarantine\/([^/]+)\/release$/.exec(path);
    if (m && method === "POST") {
      if (!isModerator) return sendJson(res, 403, MODERATORS_ONLY), true;
      const item = state.quarantine.get(decodeURIComponent(m[1]));
      if (!item) throw new HttpError(404, `no quarantine item "${decodeURIComponent(m[1])}"`);
      if (item.state === "released") throw new HttpError(409, `${item.id} was already released by ${item.released_by ?? "a moderator"}`);
      item.state = "released";
      item.released_by = callerId;
      item.released_at = nowIso();
      logAudit(deps, { kind: "quarantine.released", actor: callerId, ...(item.principal ? { principal: item.principal } : {}), detail: `${item.id} (session ${item.session_id}) released.` });
      deps.bus.emit({ type: "quarantine.released", item: structuredClone(item) });
      return sendJson(res, 200, item), true;
    }
  }

  // ---- GET /api/audit?principal=&since= (moderator).
  if (path === ROUTES.audit && method === "GET") {
    if (!isModerator) return sendJson(res, 403, MODERATORS_ONLY), true;
    const principal = url.searchParams.get("principal") ?? undefined;
    const since = url.searchParams.get("since") ?? undefined;
    if (since !== undefined && Number.isNaN(Date.parse(since))) throw new HttpError(400, "since must be an ISO 8601 timestamp");
    const sinceIso = since === undefined ? undefined : new Date(since).toISOString();
    const entries = state.audit
      .filter((e) => (principal === undefined || e.principal === principal) && (sinceIso === undefined || e.at >= sinceIso))
      .sort((a, b) => (a.at < b.at ? -1 : 1));
    return sendJson(res, 200, { entries }), true;
  }

  // ---- POST /api/handoff (internal: the dispatcher and the MCP layer call this, never members).
  if (path === ROUTES.handoff && method === "POST") {
    if (!isInternal) return sendJson(res, 403, INTERNAL_ONLY), true;
    return sendJson(res, 200, runHandoff(deps, client, await readJsonBody(req))), true;
  }

  // ---- POST /api/dispatch (the agent's creator or a moderator).
  if (path === ROUTES.dispatch && method === "POST") {
    const body = await readJsonBody(req);
    if (!isRecord(body) || typeof body.agent !== "string" || typeof body.by !== "string") {
      throw new HttpError(400, "body must be { agent, by }");
    }
    const agent = state.principals.get(body.agent);
    const isCreator = agent?.kind === "agent" && agent.created_by === callerId;
    // Same bytes for "not yours" and "no such agent": no existence signal for members.
    if (!isModerator && !isCreator) return sendJson(res, 403, NOT_YOUR_AGENT), true;
    if (!agent || agent.kind !== "agent") throw new HttpError(404, `no agent "${body.agent}"`);
    if (body.by !== callerId) throw new HttpError(403, `body.by must be the caller ("${callerId}")`);
    const dispatchId = id("dsp");
    deps.bus.emit({ type: "dispatch.requested", id: dispatchId, request: { agent: agent.id, by: callerId } });
    return sendJson(res, 200, { id: dispatchId }), true;
  }

  // ---- POST /api/events (internal): re-broadcast one RELAYED_EVENTS event.
  if (path === ROUTES.publish && method === "POST") {
    if (!isInternal) return sendJson(res, 403, INTERNAL_ONLY), true;
    const body = await readJsonBody(req);
    if (!isRecord(body) || !isRecord(body.event)) throw new HttpError(400, "body must be { event }");
    const event = body.event;
    if (typeof event.type !== "string" || !(RELAYED_EVENTS as readonly string[]).includes(event.type)) {
      throw new HttpError(400, `event.type must be one of ${RELAYED_EVENTS.join("|")}`);
    }
    if (event.at !== undefined && typeof event.at !== "string") throw new HttpError(400, "event.at must be an ISO 8601 string");
    // The event shape beyond the type is lane B's; the server stamps `at` and re-broadcasts.
    const emitted = deps.bus.emit(event as Parameters<EventBus["emit"]>[0]);
    return sendJson(res, 200, { ok: true, at: emitted.at }), true;
  }

  return false;
}

// -------------------------------------------------------------------------------- handlers

/** POST /api/principals (moderator): adds a person; members come with a rule and get a scope. */
function addPerson(deps: ScopesDeps, callerId: string, body: unknown): Principal {
  if (!isRecord(body)) throw new HttpError(400, "body must be an AddPersonBody object");
  const { id: personId, name, tier, rule } = body;
  if (typeof personId !== "string" || !PERSON_ID_RE.test(personId)) throw new HttpError(400, `id must match ${PERSON_ID_RE} (people go by first name)`);
  if (personId.startsWith("agt_")) throw new HttpError(400, "people never use the agt_ prefix");
  if (deps.world.principals.has(personId)) throw new HttpError(409, `principal "${personId}" already exists`);
  if (typeof name !== "string" || name.trim() === "") throw new HttpError(400, "name must be a non-empty string");
  if (typeof tier !== "string" || !(PRINCIPAL_TIERS as readonly string[]).includes(tier)) throw new HttpError(400, `tier must be ${PRINCIPAL_TIERS.join("|")}`);
  if (tier === "member" && rule === undefined) throw new HttpError(400, "a member needs a rule ({ task, exclude }); moderators see everything and need none");

  const principal: Principal = { id: personId, kind: "person", name: name.trim(), tier: tier as PrincipalTier };
  deps.world.principals.set(personId, principal);
  logAudit(deps, { kind: "person.added", actor: callerId, principal: personId, detail: `${principal.name} added as a ${tier}.` });
  deps.bus.emit({ type: "principal.changed", principal, change: "added", by: callerId });

  if (tier === "member") {
    const clean = parseRuleBody(rule, personId, callerId, "body.rule");
    deps.world.rules.set(personId, clean);
    const scope = buildScope(deps, principal, clean);
    logAudit(deps, { kind: "scope.built", actor: callerId, principal: personId, fact_ids: scope.fact_ids, detail: `Scope built for "${clean.task}" (exclusions applied in code).` });
    deps.bus.emit({ type: "scope.updated", principal: personId, reason: "built", added: scope.fact_ids, removed: [], size: scope.fact_ids.length });
  }
  return principal;
}

/** POST /api/principals/:id/tier (moderator). */
function changeTier(deps: ScopesDeps, callerId: string, target: string, body: unknown): Principal {
  const principal = deps.world.principals.get(target);
  if (!principal) throw new HttpError(404, `no principal "${target}"`);
  if (principal.kind !== "person") throw new HttpError(400, "an agent has no tier; it never holds more than its creator");
  if (!isRecord(body) || typeof body.tier !== "string" || !(PRINCIPAL_TIERS as readonly string[]).includes(body.tier)) {
    throw new HttpError(400, `body.tier must be ${PRINCIPAL_TIERS.join("|")}`);
  }
  principal.tier = body.tier as PrincipalTier;
  logAudit(deps, { kind: "tier.changed", actor: callerId, principal: target, detail: `${principal.name} is now a ${principal.tier}.` });
  deps.bus.emit({ type: "principal.changed", principal, change: "tier_changed", by: callerId });
  return principal;
}

/** POST /api/agents: a member creates agents only for themselves; the scope comes from the creator's. */
function createAgent(deps: ScopesDeps, callerId: string, isModerator: boolean, body: unknown): Principal {
  if (!isRecord(body)) throw new HttpError(400, "body must be a CreateAgentBody object");
  const { created_by, name, rule } = body;
  if (typeof created_by !== "string" || created_by === "") throw new HttpError(400, "created_by must be a principal id");
  if (!isModerator && created_by !== callerId) return denyAgentCreate();
  const creator = deps.world.principals.get(created_by);
  if (!creator || creator.kind !== "person") {
    if (!isModerator) return denyAgentCreate(); // a non-person caller never learns who exists
    throw new HttpError(404, `no person "${created_by}"`);
  }
  if (typeof name !== "string" || name.trim() === "") throw new HttpError(400, "name must be a non-empty string");
  const agent: Principal = { id: id("agt"), kind: "agent", name: name.trim(), created_by };
  const clean = parseRuleBody(rule, agent.id, callerId, "body.rule");
  deps.world.principals.set(agent.id, agent);
  deps.world.rules.set(agent.id, clean);
  const scope = buildScope(deps, agent, clean);
  logAudit(deps, { kind: "agent.created", actor: callerId, principal: agent.id, detail: `${creator.name} gets agent "${agent.name}"; its scope is built from the creator's only.` });
  logAudit(deps, { kind: "scope.built", actor: callerId, principal: agent.id, fact_ids: scope.fact_ids, detail: `Agent scope built for "${clean.task}": subset of ${created_by}'s scope, exclusions applied in code.` });
  deps.bus.emit({ type: "principal.changed", principal: agent, change: "agent_created", by: callerId });
  deps.bus.emit({ type: "scope.updated", principal: agent.id, reason: "built", added: scope.fact_ids, removed: [], size: scope.fact_ids.length });
  return agent;
}

function denyAgentCreate(): never {
  throw new HttpError(403, "a member may only create agents for themselves");
}

/** POST /api/quarantine (internal): hold a captured item until a moderator releases it. */
function holdQuarantine(deps: ScopesDeps, client: string, body: unknown): QuarantineItem {
  if (!isRecord(body)) throw new HttpError(400, "body must be a PostQuarantineBody object");
  const { session_id, p, excerpt, principal } = body;
  if (typeof session_id !== "string" || !SESSION_ID_RE.test(session_id)) throw new HttpError(400, `session_id must match ${SESSION_ID_RE}`);
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw new HttpError(400, "p must be a number in [0, 1]");
  if (typeof excerpt !== "string" || excerpt.trim() === "") throw new HttpError(400, "excerpt must be a non-empty string");
  if (principal !== undefined && (typeof principal !== "string" || principal === "")) throw new HttpError(400, "principal must be a principal id");
  const item: QuarantineItem = {
    id: id("qtn"),
    session_id,
    state: "held",
    created_at: nowIso(),
    p,
    excerpt: excerpt.trim(),
    ...(typeof principal === "string" ? { principal } : {}),
  };
  deps.world.quarantine.set(item.id, item);
  logAudit(deps, { kind: "quarantine", actor: client, ...(item.principal ? { principal: item.principal } : {}), detail: `${item.id} held for session ${session_id} (p ${p}).` });
  return item;
}
