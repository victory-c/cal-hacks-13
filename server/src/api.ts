// REST handlers: the capture clients and the distiller write here, the dashboard reads here.
// Each function validates its input and throws HttpError; the router does the HTTP plumbing.

import { FACT_ID_RE, INTERNAL_CLIENTS, SESSION_ID_RE, TIERS, canWrite, grantFor, validateFact } from "@canon/shared";
import type {
  CapturedSession,
  Fact,
  Folder,
  Grant,
  GrantsResponse,
  HealthResponse,
  Judge,
  JudgeName,
  ListFactsResponse,
  MessageRole,
  PostFactsResponse,
  PostSessionResponse,
  SaveAction,
  SaveDecision,
  SessionMessage,
  Tier,
} from "@canon/shared";

import type { EventBus } from "./events.ts";
import { HttpError, isRecord } from "./http.ts";
import type { Retriever } from "./retrieval/index.ts";
import type { FileStore } from "./store.ts";

export interface ApiDeps {
  store: FileStore;
  bus: EventBus;
  grants: readonly Grant[];
  judge: Judge;
  retriever: Retriever;
  startedAt: number;
}

const ROLES: readonly MessageRole[] = ["user", "assistant", "system", "tool"];

export function health(deps: ApiDeps): HealthResponse {
  const { facts, sessions } = deps.store.counts();
  return { ok: true, facts, sessions, uptime_s: Math.round((Date.now() - deps.startedAt) / 1000), judge: deps.judge.name, retriever: deps.retriever.name };
}

export function grants(deps: ApiDeps): GrantsResponse {
  return { grants: [...deps.grants] };
}

// ---------------------------------------------------------------------- sessions

/** POST /api/sessions: cold archive upsert by the original capturing client. */
export async function postSession(deps: ApiDeps, client: string, body: unknown): Promise<PostSessionResponse> {
  const session = parseSession(body);
  if (session.client !== client) {
    throw new HttpError(403, `body.client is "${session.client}" but the token belongs to "${client}"`);
  }
  const existing = await deps.store.getSession(session.id);
  if (existing && existing.client !== client) {
    throw new HttpError(403, `${client} cannot update session ${session.id}`);
  }
  const { updated } = await deps.store.putSession(session);
  deps.bus.emit({
    type: "session.captured",
    session: { id: session.id, client, title: session.title, messages: session.messages.length, ended: !!session.ended_at },
  });
  return { id: session.id, updated };
}

/**
 * GET /api/sessions/:id. Raw transcripts are the most sensitive thing in the store and the cold
 * archive has no folder scoping, so only the session's own client and the internal workers
 * (the distiller) may read one.
 */
export async function getSession(deps: ApiDeps, client: string, id: string): Promise<CapturedSession> {
  if (!SESSION_ID_RE.test(id)) throw new HttpError(400, `session id must match ${SESSION_ID_RE}`);
  const session = await deps.store.getSession(id);
  if (!session) throw new HttpError(404, `no session ${id} in the archive`);
  if (session.client !== client && !(INTERNAL_CLIENTS as readonly string[]).includes(client)) {
    throw new HttpError(403, `${client} cannot read session ${id}: it was captured by "${session.client}"`);
  }
  return session;
}

/** Keeps the known keys of CapturedSession and rejects anything malformed with a precise message. */
function parseSession(body: unknown): CapturedSession {
  if (!isRecord(body)) throw new HttpError(400, "body must be a CapturedSession object");
  const { id, client, started_at, ended_at, title, messages, meta } = body;
  if (typeof id !== "string" || !SESSION_ID_RE.test(id)) throw new HttpError(400, `id must match ${SESSION_ID_RE}`);
  if (typeof client !== "string" || client.trim() === "") throw new HttpError(400, "client must be a non-empty string");
  if (typeof started_at !== "string" || started_at === "") throw new HttpError(400, "started_at must be an ISO 8601 string");
  if (ended_at !== undefined && typeof ended_at !== "string") throw new HttpError(400, "ended_at must be an ISO 8601 string");
  if (title !== undefined && typeof title !== "string") throw new HttpError(400, "title must be a string");
  if (!Array.isArray(messages)) throw new HttpError(400, "messages must be an array of { role, content }");
  if (meta !== undefined && !isRecord(meta)) throw new HttpError(400, "meta must be an object");

  const clean: SessionMessage[] = messages.map((m, i) => {
    if (!isRecord(m) || typeof m.role !== "string" || !ROLES.includes(m.role as MessageRole)) {
      throw new HttpError(400, `messages[${i}].role must be one of ${ROLES.join("|")}`);
    }
    if (typeof m.content !== "string") throw new HttpError(400, `messages[${i}].content must be a string`);
    const msg: SessionMessage = { role: m.role as MessageRole, content: m.content };
    if (typeof m.at === "string") msg.at = m.at;
    return msg;
  });

  const session: CapturedSession = { id, client, started_at, messages: clean };
  if (ended_at !== undefined) session.ended_at = ended_at;
  if (title !== undefined) session.title = title;
  if (meta !== undefined) session.meta = meta;
  return session;
}

// ------------------------------------------------------------------------- facts

/** GET /api/facts. `visible` is the caller's view (its read grant, or "everything but private/" with no token). */
export function listFacts(deps: ApiDeps, query: URLSearchParams, visible: (folder: Folder) => boolean = () => true): ListFactsResponse {
  const folder = query.get("folder") ?? undefined;
  const tier = query.get("tier") ?? undefined;
  if (tier !== undefined && !(TIERS as readonly string[]).includes(tier)) throw new HttpError(400, `tier must be ${TIERS.join("|")}`);
  const facts = deps.store.listFacts({ folder: folder as Folder | undefined, tier: tier as Tier | undefined });
  return { facts: facts.filter((f) => visible(f.folder)) };
}

const ACTIONS: readonly SaveAction[] = ["add", "merge", "supersede"];
const JUDGES: readonly JudgeName[] = ["jev", "claude", "fake"];

/**
 * Rebuilds a clean SaveDecision from the request body. It is broadcast to every dashboard on
 * fact.saved, so nothing unchecked (a typo'd action, a stray field) gets through.
 */
function parseDecision(raw: unknown, fact: Fact, where: string): SaveDecision {
  if (!isRecord(raw)) throw new HttpError(400, `${where} must be a SaveDecision object`);
  const { action, supersedes, tier, folder, keep_p, folder_p, judge } = raw;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) throw new HttpError(400, `${where}.action must be ${ACTIONS.join("|")}`);
  if (supersedes !== undefined && (typeof supersedes !== "string" || !FACT_ID_RE.test(supersedes))) throw new HttpError(400, `${where}.supersedes must match ${FACT_ID_RE}`);
  if (action !== "add" && supersedes === undefined) throw new HttpError(400, `${where}.supersedes is required when action is "${action}"`);
  if (tier !== fact.tier) throw new HttpError(400, `${where}.tier must equal fact.tier ("${fact.tier}")`);
  if (folder !== fact.folder) throw new HttpError(400, `${where}.folder must equal fact.folder ("${fact.folder}")`);
  for (const [name, p] of [["keep_p", keep_p], ["folder_p", folder_p]] as const) {
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw new HttpError(400, `${where}.${name} must be a number in [0, 1]`);
  }
  if (typeof judge !== "string" || !(JUDGES as readonly string[]).includes(judge)) throw new HttpError(400, `${where}.judge must be ${JUDGES.join("|")}`);
  const clean: SaveDecision = { tier: fact.tier, folder: fact.folder, action: action as SaveAction, keep_p: keep_p as number, folder_p: folder_p as number, judge: judge as JudgeName };
  if (typeof supersedes === "string") clean.supersedes = supersedes;
  return clean;
}

/**
 * POST /api/facts: the distiller files decided facts. All entries and existing facts they
 * mutate are authorized before any write. "supersede"/"merge" retires the old fact to cold
 * (Jev never deletes) and emits fact.retired; every new fact emits fact.saved.
 */
export async function postFacts(deps: ApiDeps, client: string, body: unknown): Promise<PostFactsResponse> {
  const grant = grantFor(deps.grants, client);
  if (!grant) throw new HttpError(403, `no grants for client "${client}"`);
  if (!isRecord(body) || !Array.isArray(body.facts)) throw new HttpError(400, "body must be { facts: [{ fact, decision }] }");

  const attribution = body.distillation;
  if (attribution !== undefined && (client !== "distiller" || !isRecord(attribution) ||
      typeof attribution.session_id !== "string" || !["droid", "claude", "heuristic"].includes(String(attribution.engine)) ||
      typeof attribution.duration_ms !== "number" || !Number.isFinite(attribution.duration_ms) || attribution.duration_ms < 0 ||
      (attribution.plan !== undefined && typeof attribution.plan !== "string"))) {
    throw new HttpError(400, "invalid internal distillation attribution");
  }

  const entries: Array<{ fact: Fact; decision: SaveDecision }> = body.facts.map((entry, i) => {
    if (!isRecord(entry)) throw new HttpError(400, `facts[${i}] must be { fact, decision }`);
    const v = validateFact(entry.fact);
    if (!v.ok) throw new HttpError(400, `facts[${i}].fact: ${v.errors.join("; ")}`);
    return { fact: v.fact, decision: parseDecision(entry.decision, v.fact, `facts[${i}].decision`) };
  });

  const requireWrite = (folder: Folder, existing = false) => {
    if (!canWrite(grant, folder)) {
      deps.bus.emit({ type: "access.denied", client, tool: "POST /api/facts", folder });
      throw new HttpError(403, existing ? `${client} cannot modify an existing fact` : `${client} cannot write ${folder}`);
    }
  };
  for (const { fact, decision } of entries) {
    requireWrite(fact.folder);
    // An allowed destination cannot authorize moving or overwriting a restricted fact by ID.
    const existing = deps.store.getFact(fact.id);
    if (existing) requireWrite(existing.folder, true);
    // Retirement is a write to the old fact's folder, regardless of the replacement's folder.
    const oldId = decision.action === "supersede" || decision.action === "merge" ? decision.supersedes : undefined;
    const old = oldId ? deps.store.getFact(oldId) : undefined;
    if (old) requireWrite(old.folder, true);
  }

  const saved: string[] = [];
  const retired: string[] = [];
  for (const { fact, decision } of entries) {
    let retiredId: string | undefined;
    const oldId = decision.action === "supersede" || decision.action === "merge" ? decision.supersedes : undefined;
    if (oldId) {
      const old = deps.store.getFact(oldId);
      if (old) {
        await deps.store.putFact({ ...old, tier: "cold" });
        retiredId = old.id;
        retired.push(old.id);
      } else {
        console.warn(`[api] ${fact.id} ${decision.action}s ${oldId}, which is not in the store; saving anyway`);
      }
    }
    await deps.store.putFact(fact);
    // Both ids must be canonical before event subscribers authorize their visibility.
    if (retiredId) deps.bus.emit({ type: "fact.retired", id: retiredId, superseded_by: fact.id });
    deps.bus.emit({ type: "fact.saved", fact, decision });
    saved.push(fact.id);
  }
  if (isRecord(attribution)) {
    deps.bus.emit({ type: "distill.finished", session_id: attribution.session_id as string,
      engine: attribution.engine as "droid" | "claude" | "heuristic", facts: saved.length,
      duration_ms: attribution.duration_ms as number,
      ...(typeof attribution.plan === "string" && entries.every(({fact}) => !fact.folder.startsWith("private")) ? { plan: attribution.plan } : {}) });
  }
  return { saved, retired };
}
