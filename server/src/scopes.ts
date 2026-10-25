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
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
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
import { writeAtomic } from "./store.ts";
import type { FileStore } from "./store.ts";

// ---------------------------------------------------------------------------------- fixtures

export interface WorldFixtures {
  groups: Group[];
  principals: Principal[];
  rules: ScopeRule[];
  scopes: Scope[];
  quarantine: QuarantineItem[];
  audit: AuditEvent[];
  /**
   * Principals whose scope the server builds with the real pipeline when it starts, people before
   * agents (the demo world's 0:00 scopes). Scopes in `scopes` are a snapshot and are used as is.
   */
  initial_scopes?: string[];
}

/**
 * The earlier Harbor Lane / Project Falcon world (lane B's fixtures), kept as the server tests'
 * world: its prebuilt scope snapshot pins test expectations. The demo runs on fixtures/world/ (world.ts).
 */
export const WORLD_FIXTURES_DIR = join(REPO_ROOT, "distiller", "fixtures", "world");

/** One per-person client for each of the Falcon test world's people, added to DEMO_GRANTS in tests. */
export const FALCON_TEST_GRANTS: readonly Grant[] = ["maya", "dan", "priya", "leo"].map((p) => ({ client: p, read: [], write: [], principal: p }));

/** Reads the Falcon test world's state (groups, people, rules, scopes, quarantine, audit). */
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
  /** Built by buildInitialScopes() at startup, people before agents. */
  readonly initialScopes: string[];

  private writes: Promise<void> = Promise.resolve();
  private persistedAudit = 0;
  readonly handoffs: Array<Record<string, unknown>> = [];
  readonly invalidRunVersions = new Map<string, number>();
  readonly agentRuns = new Map<string, Record<string, unknown>>();
  readonly agentSteps = new Map<string, Array<Record<string, unknown>>>();
  readonly agentInbox = new Map<string, Array<Record<string, unknown>>>();
  readonly firm = "Axe Capital";

  constructor(world: WorldFixtures = loadWorldFixtures(), private readonly dir?: string) {
    let w = structuredClone(world);
    if (dir && existsSync(join(dir, "world", "principals.json"))) {
      const read = <T>(name: string, key: string): T => JSON.parse(readFileSync(join(dir, "world", `${name}.json`), "utf8"))[key] as T;
      w = { ...w, principals: read("principals", "principals"), rules: read("rules", "rules"), scopes: read("scopes", "scopes"), groups: read("groups", "groups"), quarantine: read("quarantine", "items"), audit: [] };
      const audit = join(dir, "world", "audit.jsonl");
      if (existsSync(audit)) w.audit = readFileSync(audit, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as AuditEvent);
      this.persistedAudit = w.audit.length;
    }
    this.groups = w.groups;
    this.initialScopes = w.initial_scopes ?? [];
    for (const p of w.principals) this.principals.set(p.id, p);
    for (const r of w.rules) this.rules.set(r.principal, r);
    for (const s of w.scopes) this.scopes.set(s.principal, s);
    for (const q of w.quarantine) this.quarantine.set(q.id, q);
    this.audit = w.audit;
  }

  /** One queue for snapshots and append-only audit. A failed write remains visible to callers. */
  flush(): Promise<void> {
    if (!this.dir) return Promise.resolve();
    const snapshot = structuredClone({ principals: [...this.principals.values()], rules: [...this.rules.values()], scopes: [...this.scopes.values()], groups: this.groups, items: [...this.quarantine.values()], audit: this.audit });
    const dir = join(this.dir, "world");
    this.writes = this.writes.then(async () => {
      await mkdir(dir, { recursive: true });
      for (const [name, key] of [["groups", "groups"], ["rules", "rules"], ["scopes", "scopes"], ["quarantine", "items"], ["principals", "principals"]] as const) await writeAtomic(join(dir, `${name}.json`), JSON.stringify({ [key]: snapshot[key] }) + "\n");
      const rows = snapshot.audit.slice(this.persistedAudit);
      if (rows.length) { await appendFile(join(dir, "audit.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n"); this.persistedAudit = snapshot.audit.length; }
    });
    return this.writes;
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
 * view is named, counted or hinted at. The router uses it for GET /api/sessions/:id too.
 */
export const MODERATORS_ONLY = { error: "moderators only" };
const INTERNAL_ONLY = { error: "internal clients only" };
/** A person asking for anyone's memory but their own: one constant body, no existence signal. */
const OWN_MEMORY_ONLY = { error: "a person may only ask for their own memory" };
/** Agent routes: creators are allowed too, so "moderators only" would be wrong — but the body is still one constant. */
const NOT_YOUR_AGENT = { error: "only the agent's creator or a moderator may do this" };

const PERSON_ID_RE = /^[a-z][a-z0-9_-]*$/;

/** Who an authenticated client is in the world: its principal id and the two gate roles. */
export function callerRoles(
  world: ScopeState,
  grants: readonly Grant[],
  client: string,
): { callerId: string; isModerator: boolean; isInternal: boolean } {
  const callerId = grantFor(grants, client)?.principal ?? client;
  const caller = world.principals.get(callerId);
  return {
    callerId,
    isModerator: caller?.kind === "person" && caller.tier === "moderator",
    isInternal: (INTERNAL_CLIENTS as readonly string[]).includes(client),
  };
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

// ------------------------------------------------------------------------------------ audit

function logAudit(deps: ScopesDeps, entry: Omit<AuditEvent, "id" | "at">): AuditEvent {
  const full: AuditEvent = structuredClone({ id: id("aud"), at: nowIso(), ...entry });
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

/**
 * Hot facts a scope may ever draw from: filed in one of the world's groups. Never the
 * moderators-only inbox, and never a fact outside every group (the scaffold's career/ and
 * projects/ notes), which no moderator has placed.
 */
function hotCandidates(deps: ScopesDeps): Fact[] {
  return deps.store.listFacts({ tier: "hot" }).filter((f) => inWorldGroup(deps, f));
}

/**
 * Up to this many facts, every one of them is a candidate for the judge: the retriever only orders
 * them. A keyword stub misses paraphrases ("Taylor Mason Capital" against facts that say "TMC"),
 * and one batched judge call over a pool this size is cheap. Above it, the retriever narrows.
 */
export const JUDGE_ALL_UP_TO = 40;

/** The retriever's hits from `pool`, in its order; for a small pool, the rest of the pool after them. */
function withSmallPool(hits: readonly Fact[], pool: readonly Fact[]): Fact[] {
  if (pool.length > JUDGE_ALL_UP_TO) return [...hits];
  const seen = new Set(hits.map((f) => f.id));
  return [...hits, ...pool.filter((f) => !seen.has(f.id))];
}

function inWorldGroup(deps: ScopesDeps, fact: Fact): boolean {
  return !folderAllows([INBOX], fact.folder) && deps.world.groups.some((g) => folderAllows([g.id], fact.folder));
}

/**
 * P(yes) of the noul answer with this id. A missing or malformed answer is uncertainty, and
 * uncertainty must land on the cautious side, so the caller picks the fallback: 1 for "does it
 * fall under the exclusion?" (no answer excludes) and 0 for "does it help?" (no answer stays out).
 */
function noulP(answers: readonly Answer[], id: string, fallback: 0 | 1): number {
  const a = answers.find((x) => x.id === id);
  return a?.type === "noul" && !a.unavailable && Number.isFinite(a.p) ? a.p : fallback;
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
  const pool = base.filter((f) => inWorldGroup(deps, f) && allowedByRule(rule, f));
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
    candidates = withSmallPool(hits.map((h) => poolById.get(h.fact.id)).filter((f): f is Fact => f !== undefined), pool);
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
  const scope: Scope = { principal: principal.id, fact_ids: [...fact_ids], built_at: nowIso(), rule_updated_at: rule.updated_at };
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
export function scopeFacts(deps: ScopesDeps, principalId: string): Fact[] {
  const creator = deps.world.principals.get(principalId);
  if (creator?.kind === "person" && creator.tier === "moderator") return deps.store.listFacts({ tier: "hot" });
  const scope = deps.world.scopes.get(principalId);
  if (!scope) return [];
  const creatorIds = creator?.kind === "agent" && creator.created_by ? new Set(scopeFacts(deps, creator.created_by).map((f) => f.id)) : undefined;
  return scope.fact_ids.map((fid) => deps.store.getFact(fid)).filter((f): f is Fact => f !== undefined && f.tier === "hot" && (!creatorIds || creatorIds.has(f.id)));
}

/**
 * Builds the world's 0:00 scopes (`initial_scopes`) with the real pipeline: the configured judge
 * and retriever, audited like any other build. A failed build leaves that principal without a
 * scope, so handoffs for them fail closed (404 to the internal caller) instead of serving a guess.
 */
export type InitialScopeResult = { principal: string; facts: number; ms: number } | { principal: string; error: string };

export async function buildInitialScopes(deps: ScopesDeps): Promise<InitialScopeResult[]> {
  const out: InitialScopeResult[] = [];
  for (const id of deps.world.initialScopes) {
    if (deps.world.scopes.has(id)) continue;
    const principal = deps.world.principals.get(id);
    const rule = deps.world.rules.get(id);
    if (!principal || !rule) {
      out.push({ principal: id, error: "no such principal or rule" });
      continue;
    }
    const t0 = performance.now();
    try {
      const { scope } = await buildScope(deps, principal, rule, "server");
      deps.bus.emit({ type: "scope.updated", principal: id, reason: "built", added: scope.fact_ids, removed: [], size: scope.fact_ids.length });
      out.push({ principal: id, facts: scope.fact_ids.length, ms: Math.round(performance.now() - t0) });
    } catch (err) {
      out.push({ principal: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

// -------------------------------------------------------------------------------- refiling
//
// INTEGRATION.md `POST /api/facts/:id/file` (moderator): move a fact to another group and/or set
// its labels, e.g. the announced Stonewall terms to market/public at 1:20. A scope whose rule now
// excludes the fact loses it in code; then the fact goes through the same living-scope checks as a
// new fact (exclusions in code, then one batched judge call), so it joins only the scopes it now
// fits. An agent still gains it only through its creator's scope.

export async function refileFact(deps: ScopesDeps, callerId: string, factId: string, body: unknown): Promise<Fact> {
  const fact = deps.store.getFact(factId);
  if (!fact) throw new HttpError(404, `no fact "${factId}"`);
  if (!isRecord(body)) throw new HttpError(400, "body must be { group, labels? }");
  const { group, labels } = body;
  if (typeof group !== "string" || !GROUP_RE.test(group)) throw new HttpError(400, 'body.group must be a group path like "market/public"');
  if (group !== INBOX && !deps.world.groups.some((g) => g.id === group)) throw new HttpError(400, `no group "${group}"`);
  if (labels !== undefined && (!Array.isArray(labels) || !labels.every((l) => typeof l === "string" && LABEL_RE.test(l)))) {
    throw new HttpError(400, "body.labels must be lowercase slugs");
  }
  const next: Fact = { ...fact, folder: group, updated: nowIso().slice(0, 10) };
  if (Array.isArray(labels)) {
    if (labels.length > 0) next.labels = [...new Set(labels as string[])];
    else delete next.labels;
  }
  const saved = await deps.store.putFact(next);
  logAudit(deps, {
    kind: "fact.filed",
    actor: callerId,
    fact_ids: [saved.id],
    detail: `${saved.id} filed from ${fact.folder} to ${saved.folder}${saved.labels?.length ? ` with labels ${saved.labels.join(", ")}` : ""}.`,
  });
  deps.bus.emit({ type: "fact.filed", fact_id: saved.id, from: fact.folder, group: saved.folder, labels: saved.labels ?? [] });

  // Leave every scope whose rule now excludes it (every scope, for the moderators-only inbox).
  for (const scope of deps.world.scopes.values()) {
    const i = scope.fact_ids.indexOf(saved.id);
    if (i === -1) continue;
    const rule = deps.world.rules.get(scope.principal);
    if (!folderAllows([INBOX], saved.folder) && rule && allowedByRule(rule, saved)) continue;
    scope.fact_ids.splice(i, 1);
    logAudit(deps, { kind: "fact.left_scope", actor: callerId, principal: scope.principal, fact_ids: [saved.id], detail: `${saved.id} was filed to ${saved.folder} and left ${scope.principal}'s scope.` });
    deps.bus.emit({ type: "scope.updated", principal: scope.principal, reason: "fact_filed", added: [], removed: [saved.id], size: scope.fact_ids.length });
  }
  // Then it joins the scopes it now fits, with the checks a new fact gets.
  await onFactSaved(deps, saved);
  return saved;
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
export function attachLivingScopes(deps: ScopesDeps): { unsubscribe(): void; drain(): Promise<void> } {
  const pending = new Set<Promise<void>>();
  const unsubscribe = deps.bus.subscribe((e) => {
    if (e.type === "fact.saved") {
      const work = onFactSaved(deps, e.fact).then(() => deps.world.flush()).catch((err: unknown) => console.error(`[scopes] living update for ${e.fact.id} failed: ${String(err)}`));
      pending.add(work); void work.finally(() => pending.delete(work));
    } else if (e.type === "fact.retired") { onFactRetired(deps, e.id); const work = deps.world.flush(); pending.add(work); void work.finally(() => pending.delete(work)); }
  });
  return { unsubscribe, async drain() { while (pending.size) await Promise.all([...pending]); } };
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
  if (fact.tier !== "hot") { onFactRetired(deps, fact.id); return; }
  if (!inWorldGroup(deps, fact)) return; // the inbox (moderators only until filed) or no group at all: joins no scope

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
  const scope = deps.world.scopes.get(c.principal.id);
  const currentRule = deps.world.rules.get(c.principal.id);
  const canonical = deps.store.getFact(fact.id);
  if (!scope || !currentRule || currentRule.updated_at !== c.rule.updated_at || !canonical || canonical.tier !== "hot" || canonical.folder !== fact.folder || canonical.statement !== fact.statement || !allowedByRule(currentRule, canonical)) return;
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
  const task = body.task;
  const raw = body.exclude ?? body.exclusions ?? { groups: [], labels: [] };
  const exclude = isRecord(raw) ? { groups: raw.groups ?? [], labels: raw.labels ?? [], text: Array.isArray(raw.text) ? raw.text.join("; ") : raw.text } : raw;
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
    `${who.name} (${who.id}), ${role}. Standing task: ${(rule?.task ?? "none set").replace(/[.\s]+$/, "")}. ` +
    `Any facts handed over with this profile are the complete stored context for this request; work from them and the request alone.`
  );
}

export async function runHandoff(deps: ScopesDeps, client: string, body: unknown): Promise<HandoffResult> {
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
  // A moderator sees everything and has no scope record: their universe is every hot fact, the
  // moderators-only inbox included. Everyone else needs a built scope.
  const isModerator = who.kind === "person" && who.tier === "moderator";
  const scope = deps.world.scopes.get(principal);

  const budget = budget_tokens ?? DEFAULT_BUDGET_TOKENS;
  const request = task.trim();

  // 1. Permission: only facts inside the fixed scope are ever candidates. An agent uses its own
  // scope (⊆ its creator's by construction); what is outside was never considered.
  const inScope = scopeFacts(deps, principal);

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
    candidates = withSmallPool(r.result.map((h) => byId.get(h.fact.id)).filter((f): f is Fact => f !== undefined), inScope);
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
      needsNoContext = noulP(needs.result, "needs", 0) < TRIAGE_THRESHOLDS.NEEDS_CONTEXT;
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
  const reply = async (_res: ServerResponse, status: number, body: unknown) => { await state.flush(); sendJson(_res, status, body); };
  const { callerId, isModerator, isInternal } = callerRoles(state, deps.grants, client);

  // ---- GET /api/groups (moderator, internal): triage reads it to file facts.
  if (path === ROUTES.groups && method === "GET") {
    const own = state.principals.get(callerId);
    if (!isModerator && !isInternal && !own) return await reply(res, 403, MODERATORS_ONLY), true;
    const visible = new Set(scopeFacts(deps, callerId).map((f) => f.folder));
    const groups = state.groups.filter((g) => isModerator || isInternal || visible.has(g.id)).map((g) => ({ id: g.id, display: g.display ?? g.id.split("/").map((part) => part.replace(/-/g, " ")).join(" / "), name: g.display ?? g.id, ...(isModerator || isInternal ? { description: g.description, aliases: g.aliases } : {}) }));
    return await reply(res, 200, { groups }), true;
  }

  if (path === ROUTES.groups && method === "POST") {
    if (!isModerator) return await reply(res, 403, MODERATORS_ONLY), true;
    const body = await readJsonBody(req);
    if (!isRecord(body) || typeof body.name !== "string" || !body.name.trim()) throw new HttpError(400, "group name required");
    const gid = typeof body.id === "string" ? body.id : body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!GROUP_RE.test(gid)) throw new HttpError(400, "invalid group id");
    if (state.groups.some((g) => g.id === gid)) throw new HttpError(409, "group already exists");
    const group: Group = { id: gid, display: body.name.trim(), description: typeof body.description === "string" ? body.description : "" };
    state.groups.push(group);
    // A newly created bucket is private until Compliance explicitly edits a rule to admit it.
    for (const [principal, rule] of state.rules) {
      const owner = state.principals.get(principal);
      if (owner?.kind === "agent" && state.principals.get(owner.created_by ?? "")?.tier !== "moderator") continue; // the creator's cap already excludes it; do not put hidden group names in a member-editable agent rule
      if (rule.exclude.groups.includes(gid)) continue;
      state.rules.set(principal, { ...rule, exclude: { ...rule.exclude, groups: [...rule.exclude.groups, gid] }, updated_at: nowIso() });
    }
    deps.bus.emit({ type: "group.created", group: { id: group.id, name: group.display ?? group.id, description: group.description } });
    return await reply(res, 200, { ...group, name: group.display }), true;
  }
  // ---- /api/principals: GETs for moderators and internal clients (ingest resolves who is who,
  // the dispatcher reads an agent's record); writes stay moderator-only. Both gates run before
  // anything is read or looked up.
  if ((path === ROUTES.principals || path.startsWith(`${ROUTES.principals}/`)) && !path.endsWith("/rule")) {
    const alias = /^\/api\/principals\/([^/]+)\/scope$/.exec(path);
    if (alias && method === "GET") {
      if (!isModerator && !isInternal) return await reply(res, 403, MODERATORS_ONLY), true;
      const target = decodeURIComponent(alias[1]); const rule = state.rules.get(target); const scope = state.scopes.get(target);
      return await reply(res, 200, { fact_ids: [...(scope?.fact_ids ?? [])], rule: rule ? { task: rule.task, exclusions: { groups: [...rule.exclude.groups], labels: [...rule.exclude.labels], text: rule.exclude.text ? [rule.exclude.text] : [] } } : null }), true;
    }
    if (method === "GET") {
      if (!isModerator && !isInternal) return await reply(res, 403, MODERATORS_ONLY), true;
      if (path === ROUTES.principals) {
        return await reply(res, 200, { principals: [...state.principals.values()].map((p) => ({ ...p, ...(p.created_by ? { creator: p.created_by } : {}) })) }), true;
      }
      const m = /^\/api\/principals\/([^/]+)$/.exec(path);
      if (m) {
        const target = decodeURIComponent(m[1]);
        const principal = state.principals.get(target);
        if (!principal) throw new HttpError(404, `no principal "${target}"`);
        return await reply(res, 200, principal), true;
      }
      return false;
    }
    if (!isModerator) return await reply(res, 403, MODERATORS_ONLY), true;
    if (method === "POST" && path === ROUTES.principals) {
      return await reply(res, 200, await addPerson(deps, callerId, await readJsonBody(req))), true;
    }
    const m = /^\/api\/principals\/([^/]+)\/tier$/.exec(path);
    if (method === "POST" && m) {
      return await reply(res, 200, changeTier(deps, callerId, decodeURIComponent(m[1]), await readJsonBody(req))), true;
    }
    return false;
  }

  // ---- /api/scope-rules/:principal (moderator; the creator for their own agents; GET also for
  // internal clients, so the dispatcher can read an agent's task before a run).
  if (path.startsWith(`${ROUTES.scopeRules}/`) || /^\/api\/principals\/[^/]+\/rule$/.test(path)) {
    const target = decodeURIComponent(path.startsWith(`${ROUTES.scopeRules}/`) ? path.slice(ROUTES.scopeRules.length + 1) : path.split("/")[3]);
    const targetPrincipal = state.principals.get(target);
    const isCreator = targetPrincipal?.kind === "agent" && targetPrincipal.created_by === callerId;
    // A member asking about anything that is not their own agent gets the same bytes whether the
    // target exists or not. Members never read their own rule: exclusions are never shown to them.
    if (method === "GET") {
      if (!isModerator && !isCreator && !isInternal) return await reply(res, 403, MODERATORS_ONLY), true;
      const rule = state.rules.get(target);
      if (!rule) throw new HttpError(404, `no scope rule for "${target}"`);
      return await reply(res, 200, rule), true;
    }
    if (!isModerator && !isCreator) return await reply(res, 403, MODERATORS_ONLY), true;
    if (method === "PUT") {
      if (!targetPrincipal) throw new HttpError(404, `no principal "${target}"`);
      const rule = parseRuleBody(await readJsonBody(req), target, callerId);
      const { scope, added, removed } = await buildScope(deps, targetPrincipal, rule, callerId);
      state.rules.set(target, rule);
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
      return await reply(res, 200, path.endsWith("/rule") ? { build_id: target } : rule), true;
    }
    return false;
  }

  // ---- /api/scopes/:principal and /api/scopes/:principal/facts (moderator, internal).
  if (path.startsWith(`${ROUTES.scopes}/`)) {
    if (!isModerator && !isInternal) return await reply(res, 403, MODERATORS_ONLY), true;
    if (method !== "GET") return false;
    const m = /^\/api\/scopes\/([^/]+)(\/facts)?$/.exec(path);
    if (!m) return false;
    const target = decodeURIComponent(m[1]);
    const scope = state.scopes.get(target);
    if (!scope) throw new HttpError(404, `no scope for "${target}"`);
    if (m[2]) {
      const facts = scopeFacts(deps, target);
      return await reply(res, 200, { facts }), true;
    }
    return await reply(res, 200, { ...scope, fact_ids: scopeFacts(deps, target).map((fact) => fact.id) }), true;
  }

  // ---- /api/agents (POST: any person for themselves; DELETE: the creator or a moderator).
  if (path === ROUTES.agents && method === "POST") {
    const created = await createAgent(deps, callerId, isModerator, await readJsonBody(req));
    return await reply(res, 200, { ...created, build_id: created.id }), true;
  }
  if (path.startsWith(`${ROUTES.agents}/`) && method === "DELETE") {
    const target = decodeURIComponent(path.slice(ROUTES.agents.length + 1));
    const targetPrincipal = state.principals.get(target);
    const isCreator = targetPrincipal?.kind === "agent" && targetPrincipal.created_by === callerId;
    if (!isModerator && !isCreator) return await reply(res, 403, NOT_YOUR_AGENT), true;
    if (!targetPrincipal || targetPrincipal.kind !== "agent") throw new HttpError(404, `no agent "${target}"`);
    state.principals.delete(target);
    state.rules.delete(target);
    state.scopes.delete(target);
    logAudit(deps, { kind: "agent.deleted", actor: callerId, principal: target, detail: `Agent "${targetPrincipal.name}" deleted.` });
    deps.bus.emit({ type: "principal.changed", principal: targetPrincipal, change: "agent_deleted", by: callerId });
    return await reply(res, 200, { ok: true }), true;
  }

  // ---- POST /api/facts/:id/file (moderator): refile a fact into a group, with labels.
  {
    const m = /^\/api\/facts\/([^/]+)\/file$/.exec(path);
    if (m && method === "POST") {
      if (!isModerator) return await reply(res, 403, MODERATORS_ONLY), true;
      return await reply(res, 200, await refileFact(deps, callerId, decodeURIComponent(m[1]), await readJsonBody(req))), true;
    }
  }

  // ---- /api/quarantine (GET: moderator. POST: internal. :id/release: moderator).
  if (path === ROUTES.quarantine && method === "GET") {
    if (!isModerator) return await reply(res, 403, MODERATORS_ONLY), true;
    const items = [...state.quarantine.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    const enriched = await Promise.all(items.filter((item) => item.state === "held").map(async (item) => { const session = await deps.store.getSession(item.session_id); return { ...item, kind: session?.kind ?? "note", source: session?.title ?? "Captured item", author: item.principal ?? session?.principal ?? "", reason: item.excerpt, at: item.created_at }; }));
    return await reply(res, 200, { items: enriched }), true;
  }
  if (path === ROUTES.quarantine && method === "POST") {
    if (!isInternal) return await reply(res, 403, INTERNAL_ONLY), true;
    return await reply(res, 200, { ...holdQuarantine(deps, client, await readJsonBody(req)), event_emitted: true }), true;
  }
  {
    const m = /^\/api\/quarantine\/([^/]+)\/release$/.exec(path);
    if (m && method === "POST") {
      if (!isModerator) return await reply(res, 403, MODERATORS_ONLY), true;
      const item = state.quarantine.get(decodeURIComponent(m[1]));
      if (!item) throw new HttpError(404, `no quarantine item "${decodeURIComponent(m[1])}"`);
      if (item.state === "released") throw new HttpError(409, `${item.id} was already released by ${item.released_by ?? "a moderator"}`);
      item.state = "released";
      item.released_by = callerId;
      item.released_at = nowIso();
      logAudit(deps, { kind: "quarantine.released", actor: callerId, ...(item.principal ? { principal: item.principal } : {}), detail: `${item.id} (session ${item.session_id}) released.` });
      deps.bus.emit({ type: "quarantine.released", item: structuredClone(item) });
      return await reply(res, 200, item), true;
    }
  }

  // ---- GET /api/audit?principal=&since= (moderator).
  if (path === ROUTES.audit && method === "GET") {
    if (!isModerator) return await reply(res, 403, MODERATORS_ONLY), true;
    const principal = url.searchParams.get("principal") ?? undefined;
    const since = url.searchParams.get("since") ?? undefined;
    if (since !== undefined && Number.isNaN(Date.parse(since))) throw new HttpError(400, "since must be an ISO 8601 timestamp");
    const sinceIso = since === undefined ? undefined : new Date(since).toISOString();
    const entries = state.audit
      .filter((e) => (principal === undefined || e.principal === principal) && (sinceIso === undefined || e.at >= sinceIso))
      .sort((a, b) => (a.at < b.at ? -1 : 1));
    return await reply(res, 200, { entries: entries.map((entry) => ({ ...entry, text: entry.detail })) }), true;
  }

  // ---- POST /api/handoff. Internal clients (the dispatcher) ask for anyone. A person asks for
  // their own memory only, through their own per-person token: the principal comes from the
  // token, never from the body, and the reply leaves out what was considered (`candidates`).
  // A person naming anyone else gets the same bytes whether that principal exists or not.
  if (path === ROUTES.handoff && method === "POST") {
    const body = await readJsonBody(req);
    if (isInternal) return await reply(res, 200, await runHandoff(deps, client, body)), true;
    const own = grantFor(deps.grants, client)?.principal;
    const caller = own !== undefined ? state.principals.get(own) : undefined;
    if (!caller || caller.kind !== "person") return await reply(res, 403, INTERNAL_ONLY), true;
    if (isRecord(body) && body.principal !== undefined && body.principal !== own) return await reply(res, 403, OWN_MEMORY_ONLY), true;
    const { candidates: _considered, ...mine } = await runHandoff(deps, client, { ...(isRecord(body) ? body : {}), principal: own });
    return await reply(res, 200, mine), true;
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
    if (!isModerator && !isCreator) return await reply(res, 403, NOT_YOUR_AGENT), true;
    if (!agent || agent.kind !== "agent") throw new HttpError(404, `no agent "${body.agent}"`);
    if (body.by !== callerId) throw new HttpError(403, `body.by must be the caller ("${callerId}")`);
    const dispatchId = id("dsp");
    deps.bus.emit({ type: "dispatch.requested", id: dispatchId, request: { agent: agent.id, by: callerId, ...(typeof body.task === "string" ? { task: body.task } : {}) } });
    return await reply(res, 200, { id: dispatchId }), true;
  }

  // ---- POST /api/events (internal): re-broadcast one RELAYED_EVENTS event.
  if (path === ROUTES.publish && method === "POST") {
    if (!isInternal) return await reply(res, 403, INTERNAL_ONLY), true;
    const body = await readJsonBody(req);
    if (!isRecord(body) || !isRecord(body.event)) throw new HttpError(400, "body must be { event }");
    const event = body.event;
    if (typeof event.type !== "string" || !(RELAYED_EVENTS as readonly string[]).includes(event.type)) {
      throw new HttpError(400, `event.type must be one of ${RELAYED_EVENTS.join("|")}`);
    }
    if (event.at !== undefined && typeof event.at !== "string") throw new HttpError(400, "event.at must be an ISO 8601 string");
    if (event.type === "agent.run" && isRecord(event.run)) {
      const minVersion = state.invalidRunVersions.get(String(event.run.id));
      if (minVersion !== undefined) {
        if (typeof event.run.restarts !== "number" || event.run.restarts < minVersion) return await reply(res, 200, { ok: true, ignored: true }), true;
        state.invalidRunVersions.delete(String(event.run.id));
      }
    }
    if (event.type === "agent.step" || event.type === "agent.inbox") {
      const payload = event.type === "agent.step" ? event.step : event.item;
      if (isRecord(payload) && state.invalidRunVersions.has(String(payload.run_id))) return await reply(res, 200, { ok: true, ignored: true }), true;
    }
    // The event shape beyond the type is lane B's; the server stamps `at` and re-broadcasts.
    const emitted = deps.bus.emit(event as Parameters<EventBus["emit"]>[0]);
    return await reply(res, 200, { ok: true, at: emitted.at }), true;
  }

  return false;
}

// -------------------------------------------------------------------------------- handlers

/** POST /api/principals (moderator): adds a person; members come with a rule and get a scope. */
async function addPerson(deps: ScopesDeps, callerId: string, body: unknown): Promise<Principal> {
  if (!isRecord(body)) throw new HttpError(400, "body must be an AddPersonBody object");
  const { name, tier } = body;
  const personId = body.id ?? (typeof name === "string" ? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : undefined);
  const rule = body.rule ?? (tier === "member" && body.id === undefined ? { task: "Use public market information for assigned work", exclude: { groups: ["deal"], labels: [] } } : undefined);
  if (typeof personId !== "string" || !PERSON_ID_RE.test(personId)) throw new HttpError(400, `id must match ${PERSON_ID_RE} (people go by first name)`);
  if (personId.startsWith("agt_")) throw new HttpError(400, "people never use the agt_ prefix");
  if (deps.world.principals.has(personId)) throw new HttpError(409, `principal "${personId}" already exists`);
  if (typeof name !== "string" || name.trim() === "") throw new HttpError(400, "name must be a non-empty string");
  if (typeof tier !== "string" || !(PRINCIPAL_TIERS as readonly string[]).includes(tier)) throw new HttpError(400, `tier must be ${PRINCIPAL_TIERS.join("|")}`);
  if (tier === "member" && rule === undefined) throw new HttpError(400, "a member needs a rule ({ task, exclude }); moderators see everything and need none");

  const principal: Principal = { id: personId, kind: "person", name: name.trim(), tier: tier as PrincipalTier };
  if (tier === "member") {
    const clean = parseRuleBody(rule, personId, callerId, "body.rule");
    await buildScope(deps, principal, clean, callerId);
    deps.world.rules.set(personId, clean);
  }
  deps.world.principals.set(personId, principal);
  logAudit(deps, { kind: "person.added", actor: callerId, principal: personId, detail: `${principal.name} added as a ${tier}.` });
  deps.bus.emit({ type: "principal.changed", principal, change: "added", by: callerId });

  if (tier === "member") {
    const scope = deps.world.scopes.get(personId)!;
    deps.bus.emit({ type: "scope.updated", principal: personId, reason: "built", added: [...scope.fact_ids], removed: [], size: scope.fact_ids.length });
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
  const created_by = body.created_by ?? callerId;
  const name = body.name;
  const rule = body.rule ?? { task: body.task, exclusions: body.exclusions };
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
  await buildScope(deps, agent, clean, callerId);
  deps.world.principals.set(agent.id, agent);
  deps.world.rules.set(agent.id, clean);
  logAudit(deps, { kind: "agent.created", actor: callerId, principal: agent.id, detail: `${creator.name} gets agent "${agent.name}"; its scope is built from the creator's only.` });
  const scope = deps.world.scopes.get(agent.id)!;
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
  const existing = [...deps.world.quarantine.values()].find((item) => item.session_id === session_id && item.state === "held");
  if (existing) return existing;
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
  deps.bus.emit({ type: "quarantine.flagged", session_id, quarantine_id: item.id, p, excerpt: item.excerpt });
  return item;
}
