// Scopes REST surface (A2), the scope builder + living scopes (A4+A6) and the handoff pipeline
// with the pinned profile (A7+A16).
//
// REAL here: tier enforcement (member vs moderator vs internal client), the no-existence-signals
// rule (a member is told "moderators only" BEFORE anything is looked up, so the same bytes come
// back whether the target exists or not), the PRD scope pipeline — exclusions removed in code
// before any model, one retriever query for Moss candidates, one batched judge() call per Jev
// decision with thresholds applied in code, scope.stage events with measured times, the agent-
// subset check at build time, living-scope updates on fact.saved / fact.retired — and the PRD
// handoff order: search inside the fixed scope → inject-nothing check → Jev relevance (one
// batched call) → token budget in code → audit, with the pinned profile on every handoff.
// SIMULATED without credentials: the keyword retriever stands in for Moss and the fake judge
// answers the scope and handoff questions from keyword overlap (see scope-judge.ts); both are
// named in the audit detail and GET /health.

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
  TRIAGE_THRESHOLDS,
  cutToBudget,
  factTokens,
  folderAllows,
  grantFor,
  nowIso,
  timed,
} from "@canon/shared";
import type {
  Answer,
  AuditEvent,
  ContextFact,
  Fact,
  Grant,
  Group,
  HandoffCandidate,
  HandoffResult,
  Judge,
  Principal,
  PrincipalTier,
  QuarantineItem,
  Question,
  Scope,
  ScopeRule,
  ScopeStage,
} from "@canon/shared";

import type { EventBus } from "./events.ts";
import { HttpError, isRecord, readJsonBody, sendJson } from "./http.ts";
import type { Retriever } from "./retrieval/index.ts";
import { excludeFactQ, excludeGroupQ, helpsRequestQ, inScopeQ, needsContextQ } from "./scope-judge.ts";
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
  /** Jev (or the Claude/fake fallback) behind the one judge() interface. */
  judge: Judge;
  /** Moss when credentialed, else the keyword stub (labelled simulated). */
  retriever: Retriever;
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
//
// The PRD pipeline (A4+A6): exclusions in code → one Moss query → one batched judge() call per
// Jev decision, thresholds applied in code → a fixed list of fact ids. Each stage is emitted as
// scope.stage with its measured wall-clock time (SCOPE_STAGES; "done" carries the total).

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
 * P(yes) of the noul answer with this id. A missing or malformed answer is uncertainty, and
 * uncertainty must land on the cautious side, so the caller picks the fallback: 1 for "does it
 * fall under the exclusion?" (no answer excludes) and 0 for "does it help?" (no answer stays out).
 */
function noulP(answers: readonly Answer[], id: string, fallback: 0 | 1): number {
  const a = answers.find((x) => x.id === id);
  return a?.type === "noul" && Number.isFinite(a.p) ? a.p : fallback;
}

/** " [simulated: …]" when stub providers answered, so no detail line ever claims a measured model run. */
function simLabel(deps: ScopesDeps): string {
  const sims = [deps.judge.name === "fake" ? "judge=fake" : "", deps.retriever.name !== "moss" ? `retriever=${deps.retriever.name}` : ""].filter(Boolean);
  return sims.length > 0 ? ` [simulated: ${sims.join(", ")}]` : "";
}

export interface ScopeBuild {
  scope: Scope;
  added: string[];
  removed: string[];
}

/**
 * Builds (or fully rebuilds) a principal's scope. Excluded groups and labels leave the pool in
 * code before the retriever or the judge see anything, so no excluded fact is ever named, scored
 * or counted by a model. An agent's base is its creator's scope only, so the subset property
 * holds by construction; it is re-checked against the creator's *current* scope right before the
 * write (the model calls await, and a moderator may have narrowed the creator meanwhile) and a
 * violation is a loud 500, never a silent trim. Writes the scope.built audit row.
 */
export async function buildScope(deps: ScopesDeps, principal: Principal, rule: ScopeRule, actor: string): Promise<ScopeBuild> {
  const t0 = performance.now();
  const stage = (s: ScopeStage, since: number, remaining: number): number => {
    const now = performance.now();
    deps.bus.emit({ type: "scope.stage", principal: principal.id, stage: s, ms: Math.round(now - since), remaining });
    return now;
  };

  // 1. Exclusions in code. A member draws from every hot fact outside the moderators-only inbox;
  // an agent draws from its creator's scope only.
  const base = principal.kind === "agent" && principal.created_by !== undefined ? scopeFacts(deps, principal.created_by) : hotCandidates(deps);
  const pool = base.filter((f) => allowedByRule(rule, f));
  const t1 = stage("exclusions", t0, pool.length);

  // 2. One Moss query for the task over what remains. Whatever comes back is re-filtered against
  // the post-exclusion pool in code, so a stale index can never resurrect an excluded fact. If
  // the retriever fails (Moss without credentials, blocker Q2), every pooled fact stays a
  // candidate and Jev still filters. A member's own facts are candidates regardless of the
  // query: they always join unless an exclusion removes them.
  const poolById = new Map(pool.map((f) => [f.id, f]));
  let candidates: Fact[];
  try {
    const hits = await deps.retriever.search(rule.task, { folders: [...new Set(pool.map((f) => f.folder))], k: pool.length });
    candidates = hits.map((h) => poolById.get(h.fact.id)).filter((f): f is Fact => f !== undefined);
  } catch (err) {
    console.warn(`[scopes] ${deps.retriever.name} search failed (${err instanceof Error ? err.message : String(err)}); every post-exclusion fact stays a candidate`);
    candidates = [...pool];
  }
  const own = new Set(principal.kind === "person" ? pool.filter((f) => f.author === principal.id).map((f) => f.id) : []);
  const inCandidates = new Set(candidates.map((f) => f.id));
  for (const f of pool) if (own.has(f.id) && !inCandidates.has(f.id)) candidates.push(f);
  const t2 = stage("moss", t1, candidates.length);

  // 3. Jev, one batched ask() per decision. (a) Does group g fall under the exclusion text? Any
  // real chance excludes the whole group in code. (b) Per candidate: does it fall under the
  // exclusion (a maybe counts as excluded) and does it help with the task (a yes joins)? Own
  // facts answer only the exclusion question — a member cannot lose their own memory to a
  // relevance call, only to an exclusion.
  const ctx = `Scope build for ${principal.id}. Task: "${rule.task}".`;
  let eligible = candidates;
  if (rule.exclude.text !== undefined && eligible.length > 0) {
    const text = rule.exclude.text;
    const groups = [...new Set(eligible.map((f) => f.folder))];
    const answers = await deps.judge.ask(ctx, groups.map((g) => excludeGroupQ(`xg:${g}`, g, deps.world.groups.find((x) => x.id === g)?.description, text)));
    const excludedGroups = groups.filter((g) => noulP(answers, `xg:${g}`, 1) >= TRIAGE_THRESHOLDS.EXCLUDE_GROUP);
    eligible = eligible.filter((f) => !folderAllows(excludedGroups, f.folder));
  }
  const questions: Question[] = [];
  for (const f of eligible) {
    if (rule.exclude.text !== undefined) questions.push(excludeFactQ(`xf:${f.id}`, f, rule.exclude.text));
    if (!own.has(f.id)) questions.push(inScopeQ(`rf:${f.id}`, f, rule.task));
  }
  const answers = questions.length > 0 ? await deps.judge.ask(ctx, questions) : [];
  const joined = new Set<string>();
  for (const f of eligible) {
    if (rule.exclude.text !== undefined && noulP(answers, `xf:${f.id}`, 1) >= TRIAGE_THRESHOLDS.EXCLUDE_FACT) continue;
    if (own.has(f.id) || noulP(answers, `rf:${f.id}`, 0) >= TRIAGE_THRESHOLDS.IN_SCOPE) joined.add(f.id);
  }
  stage("jev", t2, joined.size);

  // 4. The yes answers are the scope: a fixed list of fact ids, in store order.
  const fact_ids = pool.filter((f) => joined.has(f.id)).map((f) => f.id);
  if (principal.kind === "agent" && principal.created_by !== undefined) {
    // A moderator creator sees everything and has no scope record; any other creator's current scope caps the agent's.
    const creatorScope = deps.world.scopes.get(principal.created_by);
    if (creatorScope) {
      const creators = new Set(creatorScope.fact_ids);
      if (!fact_ids.every((fid) => creators.has(fid))) throw new HttpError(500, `agent ${principal.id} scope is not a subset of its creator's`);
    }
  }
  const prevIds = new Set(deps.world.scopes.get(principal.id)?.fact_ids ?? []);
  const scope: Scope = { principal: principal.id, fact_ids, built_at: nowIso(), rule_updated_at: rule.updated_at };
  deps.world.scopes.set(principal.id, scope);
  stage("done", t0, fact_ids.length);

  const kept = new Set(fact_ids);
  const added = fact_ids.filter((fid) => !prevIds.has(fid));
  const removed = [...prevIds].filter((fid) => !kept.has(fid));
  logAudit(deps, {
    kind: "scope.built",
    actor,
    principal: principal.id,
    fact_ids,
    detail:
      `Scope built for "${rule.task}": ${base.length} fact(s) → exclusions in code ${pool.length} → ${deps.retriever.name} candidates ${candidates.length} → ` +
      `${deps.judge.name} yes/no ${fact_ids.length}${principal.kind === "agent" ? `; subset of ${principal.created_by ?? "?"}'s scope` : ""}${simLabel(deps)}.`,
  });
  return { scope, added, removed };
}

/** The creator's scope as facts; a moderator creator has no scope and sees every hot fact. */
function scopeFacts(deps: ScopesDeps, principalId: string): Fact[] {
  const creator = deps.world.principals.get(principalId);
  if (creator?.kind === "person" && creator.tier === "moderator") return hotCandidates(deps);
  const scope = deps.world.scopes.get(principalId);
  if (!scope) return [];
  return scope.fact_ids.map((fid) => deps.store.getFact(fid)).filter((f): f is Fact => f !== undefined);
}

// ---------------------------------------------------------------------------- living scopes
//
// PRD #11. Facts in the inbox (and quarantined captures, which never become facts) join no member
// scope, not even their author's, until a moderator files or releases them. Otherwise a member's
// own new facts always join their scope; everyone else's join only if they clear the same code
// exclusions and Jev checks as the original build, against each member's existing rule. An agent
// gains a fact only when its creator's scope holds it AND the fact clears the agent's own rule —
// checked in code, so an agent never exceeds its creator. A retired fact leaves every scope.

/** Wires the living-scope updates to the bus. Returns the unsubscribe. */
export function attachLivingScopes(deps: ScopesDeps): () => void {
  return deps.bus.subscribe((e) => {
    if (e.type === "fact.saved") {
      void onFactSaved(deps, e.fact).catch((err: unknown) => {
        console.error(`[scopes] living update for ${e.fact.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    } else if (e.type === "fact.retired") {
      onFactRetired(deps, e.id);
    }
  });
}

interface LiveCheck {
  principal: Principal;
  rule: ScopeRule;
  scope: Scope;
  /** The author's own fact: it joins without a relevance call (but an exclusion still removes it). */
  own: boolean;
}

/** A new hot fact joins every scope whose checks it clears, with one batched judge() call across them all. */
export async function onFactSaved(deps: ScopesDeps, fact: Fact): Promise<void> {
  if (fact.tier !== "hot") return;
  if (folderAllows([INBOX], fact.folder)) return; // moderators only until filed; joins no scope

  const members: LiveCheck[] = [];
  const agents: LiveCheck[] = [];
  for (const p of deps.world.principals.values()) {
    const rule = deps.world.rules.get(p.id);
    const scope = deps.world.scopes.get(p.id);
    if (!rule || !scope || scope.fact_ids.includes(fact.id)) continue;
    if (!allowedByRule(rule, fact)) continue; // exclusions in code, before any model
    const check: LiveCheck = { principal: p, rule, scope, own: p.kind === "person" && fact.author === p.id };
    (p.kind === "agent" ? agents : members).push(check);
  }
  if (members.length === 0 && agents.length === 0) return;

  // One batched ask across every scope this fact could join (CLAUDE.md: one call per decision).
  const questions: Question[] = [];
  for (const c of [...members, ...agents]) {
    if (c.rule.exclude.text !== undefined) questions.push(excludeFactQ(`xf:${c.principal.id}`, fact, c.rule.exclude.text));
    if (!c.own) questions.push(inScopeQ(`rf:${c.principal.id}`, fact, c.rule.task));
  }
  let answers: readonly Answer[] = [];
  let judgeFailed = false;
  if (questions.length > 0) {
    try {
      answers = await deps.judge.ask(`A new fact was saved. Which existing scopes does it join? ${fact.id} (group ${fact.folder}).`, questions);
    } catch (err) {
      judgeFailed = true; // uncertainty excludes: only pure-code joins proceed below
      console.warn(`[scopes] ${deps.judge.name} failed on living update for ${fact.id} (${err instanceof Error ? err.message : String(err)}); only code-checked joins apply`);
    }
  }
  const passes = (c: LiveCheck): boolean => {
    if (c.rule.exclude.text !== undefined) {
      if (judgeFailed) return false; // a maybe counts as excluded, and no answer is worse than a maybe
      if (noulP(answers, `xf:${c.principal.id}`, 1) >= TRIAGE_THRESHOLDS.EXCLUDE_FACT) return false;
    }
    if (c.own) return true;
    return !judgeFailed && noulP(answers, `rf:${c.principal.id}`, 0) >= TRIAGE_THRESHOLDS.IN_SCOPE;
  };

  for (const c of members) if (passes(c)) joinScope(deps, c, fact);
  for (const c of agents) {
    const creator = c.principal.created_by !== undefined ? deps.world.principals.get(c.principal.created_by) : undefined;
    const creatorHolds =
      creator?.kind === "person" && creator.tier === "moderator"
        ? true // a moderator creator sees every hot fact and has no scope record
        : c.principal.created_by !== undefined && (deps.world.scopes.get(c.principal.created_by)?.fact_ids.includes(fact.id) ?? false);
    if (creatorHolds && passes(c)) joinScope(deps, c, fact); // members joined above, so a creator's gain reaches their agents in the same pass
  }
}

function joinScope(deps: ScopesDeps, c: LiveCheck, fact: Fact): void {
  // The judge call awaited above; the scope may have been rebuilt meanwhile, so write to the current one.
  const scope = deps.world.scopes.get(c.principal.id) ?? c.scope;
  if (scope.fact_ids.includes(fact.id)) return;
  scope.fact_ids.push(fact.id);
  logAudit(deps, {
    kind: "fact.joined_scope",
    actor: fact.author ?? fact.source.client,
    principal: c.principal.id,
    fact_ids: [fact.id],
    detail: `${fact.id} (group ${fact.folder}) joined ${c.principal.id}'s scope${c.own ? " as the author's own fact" : ` for "${c.rule.task}"`}${simLabel(deps)}.`,
  });
  deps.bus.emit({ type: "scope.updated", principal: c.principal.id, reason: "fact_joined", added: [fact.id], removed: [], size: scope.fact_ids.length });
}

/** A retired fact leaves every scope that held it. */
export function onFactRetired(deps: ScopesDeps, factId: string): void {
  for (const scope of deps.world.scopes.values()) {
    const i = scope.fact_ids.indexOf(factId);
    if (i === -1) continue;
    scope.fact_ids.splice(i, 1);
    logAudit(deps, { kind: "fact.left_scope", actor: "server", principal: scope.principal, fact_ids: [factId], detail: `${factId} was retired and left ${scope.principal}'s scope.` });
    deps.bus.emit({ type: "scope.updated", principal: scope.principal, reason: "fact_left", added: [], removed: [factId], size: scope.fact_ids.length });
  }
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
//
// The PRD order, always (A7): permission (the fixed scope is the whole candidate universe) →
// search inside the scope → inject-nothing check → Jev relevance, one batched ask → token budget
// in code → audit. Never a refusal: what is outside the scope was never a candidate, so an
// out-of-scope request just gets an ordinary (possibly empty) slice.

/**
 * The pinned profile (A16, PRD must-ship #7): who this principal is and their standing task, in
 * well under 200 tokens, sent on every handoff including inject-nothing. It is built from the
 * principal and the rule's task only — never the exclusions, never an excluded group's name,
 * never a count of anything hidden.
 */
export function pinnedProfile(deps: ScopesDeps, who: Principal): string {
  const rule = deps.world.rules.get(who.id);
  const role = who.kind === "agent" ? `an agent created by ${who.created_by ?? "unknown"}` : who.tier === "moderator" ? "a moderator" : "a member";
  return (
    `${who.name} (${who.id}), ${role}. Standing task: ${rule?.task ?? "none set"}. ` +
    `Any facts handed over with this profile are the complete stored context for this request; work from them and the request alone.`
  );
}

async function runHandoff(deps: ScopesDeps, client: string, body: unknown): Promise<HandoffResult> {
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
  const request = task.trim();

  // 1. Permission: only facts inside the fixed scope are ever candidates. An agent uses its own
  // scope (⊆ its creator's by construction); what is outside was never considered.
  const inScope = scope.fact_ids.map((fid) => deps.store.getFact(fid)).filter((f): f is Fact => f !== undefined);

  // 2. Search inside the scope: the retriever query is narrowed to the scope's groups and every
  // hit is re-checked against the scope's fact ids in code (the PRD fallback until Moss filters
  // by id), so a stale index can never surface an out-of-scope fact. If the retriever fails,
  // every in-scope fact stays a candidate and Jev still filters.
  const byId = new Map(inScope.map((f) => [f.id, f]));
  let retrieval_ms = 0;
  let candidates: Fact[];
  try {
    const r = await timed(() => deps.retriever.search(request, { folders: [...new Set(inScope.map((f) => f.folder))], k: inScope.length }));
    retrieval_ms = r.ms;
    candidates = r.result.map((h) => byId.get(h.fact.id)).filter((f): f is Fact => f !== undefined);
  } catch (err) {
    console.warn(`[scopes] ${deps.retriever.name} search failed on handoff (${err instanceof Error ? err.message : String(err)}); every in-scope fact stays a candidate`);
    candidates = [...inScope];
  }

  // 3 + 4. Two Jev decisions, one batched ask() each: first "does this request need any stored
  // context at all?" (below the bar nothing is injected and relevance is never asked), then
  // "does fact i help answer it?" per candidate. No candidates means nothing to ask. A judge
  // failure serves nothing unjudged — the handoff still succeeds with the pinned profile alone.
  let judge_ms = 0;
  const pById = new Map<string, number>();
  let needsNoContext = false;
  if (candidates.length > 0) {
    const state = [`Handoff for ${principal}.`, "Candidate facts:", ...candidates.map((f, i) => `${i + 1}. [${f.id}] ${f.statement}`)].join("\n");
    try {
      const needs = await timed(() => deps.judge.ask(state, [needsContextQ("needs", request)]));
      judge_ms += needs.ms;
      needsNoContext = noulP(needs.result, "needs", 1) < TRIAGE_THRESHOLDS.NEEDS_CONTEXT;
      if (!needsNoContext) {
        const judged = await timed(() => deps.judge.ask(state, candidates.map((f) => helpsRequestQ(`hf:${f.id}`, f, request))));
        judge_ms += judged.ms;
        for (const f of candidates) pById.set(f.id, noulP(judged.result, `hf:${f.id}`, 0));
      }
    } catch (err) {
      console.warn(`[scopes] ${deps.judge.name} failed on handoff for ${principal} (${err instanceof Error ? err.message : String(err)}); nothing unjudged is served`);
    }
  }

  // 5. The token budget, in code: the best facts that fit, best first.
  const relevant = candidates
    .map((fact) => ({ fact, p: pById.get(fact.id) ?? 0 }))
    .filter((s) => s.p >= TRIAGE_THRESHOLDS.RELEVANT)
    .sort((a, b) => (b.p !== a.p ? b.p - a.p : a.fact.updated !== b.fact.updated ? (a.fact.updated < b.fact.updated ? 1 : -1) : a.fact.id < b.fact.id ? -1 : 1));
  const { kept, tokens } = needsNoContext ? { kept: [] as Fact[], tokens: 0 } : cutToBudget(relevant.map((s) => s.fact), budget);
  const keptIds = new Set(kept.map((f) => f.id));

  // What the inspector sees: every candidate the pipeline considered and which stage cut it.
  // On inject-nothing (or a failed judge) nothing was individually scored, so `p` is omitted.
  const candidatesOut: HandoffCandidate[] = candidates.map((fact) => {
    const p = pById.get(fact.id);
    const out: HandoffCandidate = {
      fact_id: fact.id,
      group: fact.folder,
      cut: keptIds.has(fact.id) ? null : needsNoContext || (p ?? 0) < TRIAGE_THRESHOLDS.RELEVANT ? "relevance" : "budget",
      tokens: factTokens(fact),
    };
    if (p !== undefined) out.p = p;
    return out;
  });
  const facts: ContextFact[] = kept.map((f) => {
    const out: ContextFact = { id: f.id, statement: f.statement, folder: f.folder, updated: f.updated, source: f.source, relevance: pById.get(f.id) ?? 0 };
    if (f.detail) out.detail = f.detail;
    return out;
  });

  // 6. Audit: exactly the facts sent, the actor, the principal and the run when there is one.
  const profile = pinnedProfile(deps, who);
  const inject_nothing = facts.length === 0;
  const latency_ms = Math.round(performance.now() - t0);
  const entry = logAudit(deps, {
    kind: "handoff",
    actor: client,
    principal,
    fact_ids: kept.map((f) => f.id),
    ...(typeof run_id === "string" ? { run_id } : {}),
    detail:
      `Handoff for "${request}": ${inScope.length} in scope → ${deps.retriever.name} ${candidates.length} candidate(s) → ` +
      `${deps.judge.name} ${relevant.length} relevant → budget kept ${kept.length} (${tokens} est. tokens)` +
      `${inject_nothing ? "; only the pinned profile went out" : ""}${simLabel(deps)}.`,
  });
  deps.bus.emit({
    type: "handoff.served",
    principal,
    client,
    ...(typeof run_id === "string" ? { run_id } : {}),
    task: request,
    candidates: candidatesOut,
    fact_ids: kept.map((f) => f.id),
    tokens,
    budget_tokens: budget,
    latency_ms,
    retrieval_ms,
    judge_ms,
    inject_nothing,
  });
  return { facts, profile, tokens, latency_ms, inject_nothing, candidates: candidatesOut, audit_id: entry.id };
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
      return sendJson(res, 200, await addPerson(deps, callerId, await readJsonBody(req))), true;
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
      const { scope, added, removed } = await buildScope(deps, targetPrincipal, rule, callerId);
      logAudit(deps, {
        kind: "scope.rule_changed",
        actor: callerId,
        principal: target,
        fact_ids: [...added, ...removed],
        detail: `Rule updated: "${rule.task}". Scope rebuilt: ${added.length} fact(s) joined, ${removed.length} left.`,
      });
      deps.bus.emit({ type: "scope.updated", principal: target, reason: "rule_changed", added, removed, size: scope.fact_ids.length });
      // The change reaches the member's agents: each is rebuilt from the creator's new scope with
      // its own rule, so a narrowed creator narrows their agents before the agents' next step.
      if (targetPrincipal.kind === "person") {
        for (const agent of state.principals.values()) {
          if (agent.kind !== "agent" || agent.created_by !== target) continue;
          const agentRule = state.rules.get(agent.id);
          if (!agentRule) continue;
          const r = await buildScope(deps, agent, agentRule, callerId);
          deps.bus.emit({ type: "scope.updated", principal: agent.id, reason: "rule_changed", added: r.added, removed: r.removed, size: r.scope.fact_ids.length });
        }
      }
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
    return sendJson(res, 200, await createAgent(deps, callerId, isModerator, await readJsonBody(req))), true;
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
    return sendJson(res, 200, await runHandoff(deps, client, await readJsonBody(req))), true;
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
async function addPerson(deps: ScopesDeps, callerId: string, body: unknown): Promise<Principal> {
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
    const { scope } = await buildScope(deps, principal, clean, callerId); // logs the scope.built audit row
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
async function createAgent(deps: ScopesDeps, callerId: string, isModerator: boolean, body: unknown): Promise<Principal> {
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
  logAudit(deps, { kind: "agent.created", actor: callerId, principal: agent.id, detail: `${creator.name} gets agent "${agent.name}"; its scope is built from the creator's only.` });
  const { scope } = await buildScope(deps, agent, clean, callerId); // logs the scope.built audit row
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
