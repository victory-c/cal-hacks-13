// Principal views use the same canonical scope as hooks, MCP and agent sandboxes.
import { AGENT_MEMORY_DIR, folderAllows, newSessionId, nowIso, SOURCE_KINDS } from "@canon/shared";
import type { AgentRun, AgentStep, Fact, Principal, SaveDecision, SourceKind } from "@canon/shared";
import type { IncomingMessage, ServerResponse } from "node:http";
import { postSession } from "./api.ts";
import { HttpError, isRecord, readJsonBody, sendJson } from "./http.ts";
import { layerOf, setPin } from "./memory-layers.ts";
import { callerRoles, scopeFacts, visibleGroups } from "./scopes.ts";
import type { ScopesDeps } from "./scopes.ts";

export function principalFor(deps: ScopesDeps, client: string): Principal | undefined {
  const { callerId } = callerRoles(deps.world, deps.grants, client);
  return deps.grants.some((g) => g.client === client && g.principal === callerId) ? deps.world.principals.get(callerId) : undefined;
}
export async function memberFacts(deps: ScopesDeps, principal: Principal, query: URLSearchParams) {
  const visible = scopeFacts(deps, principal.id).filter((fact) => (!query.get("group") || fact.folder === query.get("group")) && (!query.get("label") || fact.labels?.includes(query.get("label")!)) && (!query.get("q") || fact.statement.toLowerCase().includes(query.get("q")!.toLowerCase())));
  const now = Date.now();
  const facts = await Promise.all(visible.map(async (fact) => {
    const session = await deps.store.getSession(fact.source.session);
    // A single source can contain facts filed on both sides of the wall. Its raw headline was
    // never scope-judged, so only its author and Compliance may see it.
    const ownsSource = principal.tier === "moderator" || session?.principal === principal.id;
    const kind = session?.kind === "ai_session" ? "session" : session?.kind;
    // Their own memory layers: top of mind or background, why, and how much they have used it.
    const layer = layerOf(deps.world.layers, principal, fact, now);
    return { id: fact.id, statement: fact.statement, group: fact.folder, labels: fact.labels ?? [], source: ownsSource && session?.title ? session.title : kind ? `${kind} · ${fact.source.client}` : fact.source.client, author: fact.author ?? session?.principal ?? "", happened_at: fact.happened ?? session?.started_at ?? `${fact.updated}T00:00:00.000Z`, learned_at: fact.updated, status: fact.tier, layer: layer.layer, layer_reason: layer.reason, uses: layer.uses, last_used: layer.last_used, ...(kind ? { source_kind: kind } : {}), ...(ownsSource && session?.title ? { source_title: session.title } : {}) };
  }));
  return { facts };
}

/**
 * One agent as its creator's member view draws it (GET /api/agents). Everything here is inside
 * the creator's own scope: the agent's scope is a subset of theirs, its memory groups are picked
 * from the groups they can see, and what it wrote is withheld once any fact it read has left the
 * agent's scope (then `refresh` asks for a new run, naming nothing).
 */
export function agentView(deps: ScopesDeps, p: Principal) {
  const run = deps.world.agentRuns.get(p.id) as Partial<AgentRun> | undefined;
  const runId = String(run?.id ?? "");
  const steps = (deps.world.agentSteps.get(runId) ?? []) as unknown as AgentStep[];
  const rule = deps.world.rules.get(p.id);
  const active = run?.state === "queued" || run?.state === "running" || run?.state === "waiting";
  const status = run?.state === "cancelled" ? "stopped" : active ? "running" : run?.state ?? "ready";
  const held = new Set(deps.world.scopes.get(p.id)?.fact_ids ?? []);
  const fresh = (step: AgentStep) => !step.fact_ids || step.fact_ids.every((id) => held.has(id));
  const saved = steps.filter((step) => step.kind === "file" && typeof step.content === "string" && step.file);
  const isNote = (step: AgentStep) => step.file!.startsWith(`${AGENT_MEMORY_DIR}/`);
  // A file saved twice (a restart, a re-run in the same record) shows once, latest wins.
  const latest = (list: AgentStep[]) => [...new Map(list.map((step) => [step.file!, step])).values()];
  const documents = latest(saved.filter((step) => !isNote(step) && fresh(step))).map((step) => ({ file: step.file!, title: documentTitle(step.content!, step.file!), text: step.content!, at: step.at }));
  const memories = saved.filter((step) => isNote(step) && fresh(step)).map((step) => ({ file: step.file!, text: step.content!, at: step.at }));
  const creator = p.created_by ?? "";
  const agentFolders = scopeFacts(deps, p.id).map((fact) => fact.folder);
  const creatorSetRule = rule?.set_by === creator;
  const memory_groups = visibleGroups(deps, creator).map((g) => {
    const count = agentFolders.filter((folder) => folder === g.id).length;
    // The creator's own rule says exactly what they chose; a rule Compliance set last is shown by
    // what the agent holds, so its exclusions are never read back to the member.
    const included = creatorSetRule && rule ? !folderAllows(rule.exclude.groups, g.id) : count > 0;
    return { id: g.id, name: g.display ?? g.id, included, count };
  });
  return {
    id: p.id, name: p.name, creator, created_by: creator, task: rule?.task ?? "", status,
    run_task: run?.task ?? null, started_at: run?.started_at ?? null, finished_at: run?.ended_at ?? null, runtime: run?.runtime ?? null,
    steps: steps.map((step, n) => ({ id: `${runId}:${n}`, text: step.text, kind: step.kind, ...(step.file ? { file: step.file } : {}), status: active && n === steps.length - 1 ? "running" : "done", at: step.at })),
    files: [...new Set(steps.filter((step) => step.file).map((step) => step.file!))],
    inbox: deps.world.agentInbox.get(runId) ?? [], docs: [], schedule: "Only when I press Run",
    // Withdrawn: a fact the finished run held has left its scope, so its trace is gone (router.ts).
    documents, memories, refresh: saved.some((step) => !fresh(step)) || (run as { withdrawn?: boolean } | undefined)?.withdrawn === true,
    // The documents themselves; a run that carried no document text (an older dispatcher) still
    // shows its result lines, as before.
    outputs: documents.length
      ? documents.map((d) => ({ type: "summary", title: d.title, lines: d.text.split("\n").filter((line) => line.trim()).map((text) => ({ text, source: "" })) }))
      : steps.filter((step) => step.kind === "result").map((step) => ({ type: "summary", title: "Agent result", lines: [{ text: step.text, source: "" }] })),
    leave_out: creatorSetRule ? rule?.exclude.text ?? "" : "", memory_groups,
    fact_count: held.size, pending: 0, ...(run ? { run } : {}),
  };
}

/** A document's first markdown heading, else its file name without folder or extension. */
export function documentTitle(text: string, file: string): string {
  const heading = /^#{1,3}\s+(.+?)\s*#*\s*$/m.exec(text)?.[1];
  return heading ?? file.replace(/^.*\//, "").replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
}

export async function handleMemberRoute(deps: ScopesDeps, client: string, method: string, path: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const who = principalFor(deps, client);
  const { callerId, isModerator, isInternal } = callerRoles(deps.world, deps.grants, client);
  const reply = async (status: number, body: unknown) => { await deps.world.flush(); sendJson(res, status, body); return true; };
  if (method === "GET" && path === "/api/me") {
    if (!who) throw new HttpError(404, "this token has no principal");
    const rule = deps.world.rules.get(who.id);
    return reply(200, { id: who.id, kind: who.kind, name: who.name, ...(who.tier ? { tier: who.tier } : {}), ...(who.created_by ? { creator: who.created_by } : {}), ...(who.tier !== "moderator" && rule ? { task: rule.task } : {}), firm: deps.world.firm });
  }
  if (method === "POST" && path === "/api/items") {
    if (!who || who.kind !== "person") throw new HttpError(403, "person token required");
    const body = await readJsonBody(req);
    if (!isRecord(body) || typeof body.text !== "string" || !body.text.trim() || typeof body.kind !== "string" || !(SOURCE_KINDS as readonly string[]).includes(body.kind) || typeof body.source !== "string") throw new HttpError(400, "body must be { kind, source, text, author? }");
    if (body.author !== undefined && body.author !== who.id && !isModerator) throw new HttpError(403, "items are captured as their author");
    const author = typeof body.author === "string" ? body.author : who.id;
    if (!deps.world.principals.has(author)) throw new HttpError(404, "no such principal");
    const at = nowIso(); const id = newSessionId();
    // A moderator may attribute an item; the trusted ingest client uses the same capture validation.
    await postSession({ ...deps, startedAt: 0 }, isModerator && author !== who.id ? "ingest" : client, { id, client: "ingest", principal: author, kind: body.kind as SourceKind, external: true, title: body.source, started_at: at, ended_at: at, messages: [{ role: "user", content: body.text, at }] });
    deps.bus.emit({ type: "item.captured", item_id: id, kind: body.kind, source: body.source, author });
    return reply(200, { item_id: id });
  }
  // POST /api/facts/:id/layer { layer: "top" | "background" | "auto" }: the caller's own override
  // for a memory in their scope. "top" keeps it top of mind, "background" leaves it out unless a
  // request asks about it, "auto" hands it back to Bullwark. Changes nobody else's view.
  const layered = /^\/api\/facts\/([^/]+)\/layer$/.exec(path);
  if (layered && method === "POST") {
    if (!who || who.kind !== "person") throw new HttpError(403, "person token required");
    const id = decodeURIComponent(layered[1]);
    if (!scopeFacts(deps, who.id).some((fact) => fact.id === id)) throw new HttpError(404, "no such fact");
    const body = await readJsonBody(req);
    const layer = isRecord(body) ? body.layer : undefined;
    if (layer !== "top" && layer !== "background" && layer !== "auto") throw new HttpError(400, 'body must be { layer: "top" | "background" | "auto" }');
    setPin(deps.world.layers, who.id, id, layer);
    return reply(200, (await memberFacts(deps, who, new URLSearchParams())).facts.find((fact) => fact.id === id));
  }
  const mutation = /^\/api\/facts\/([^/]+)(\/retire)?$/.exec(path);
  if (mutation && (method === "PATCH" || method === "POST" && mutation[2])) {
    if (!who) throw new HttpError(403, "person token required");
    const fact = scopeFacts(deps, who.id).find((fact) => fact.id === decodeURIComponent(mutation[1]));
    if (!fact) throw new HttpError(404, "no such fact");
    if (mutation[2]) {
      await deps.store.putFact({ ...fact, tier: "cold" });
      deps.bus.emit({ type: "fact.retired", id: fact.id, superseded_by: fact.id });
      return reply(200, { ok: true });
    }
    const body = await readJsonBody(req);
    if (!isRecord(body) || typeof body.statement !== "string" || !body.statement.trim()) throw new HttpError(400, "statement must be non-empty");
    const saved = await deps.store.putFact({ ...fact, statement: body.statement.trim(), updated: nowIso().slice(0, 10) });
    const decision: SaveDecision = { action: "add", folder: saved.folder, tier: saved.tier, keep_p: saved.jev_keep, folder_p: 1, judge: deps.judge.name };
    deps.bus.emit({ type: "fact.saved", fact: saved, decision });
    return reply(200, (await memberFacts(deps, who, new URLSearchParams())).facts.find((fact) => fact.id === saved.id));
  }
  if (method === "GET" && path === "/api/inbox") {
    if (!isModerator) throw new HttpError(403, "moderators only");
    const facts = await memberFacts(deps, who!, new URLSearchParams({ group: "inbox" }));
    return reply(200, facts);
  }
  if (method === "GET" && path === "/api/handoffs") {
    if (!isModerator) throw new HttpError(403, "moderators only");
    return reply(200, { handoffs: deps.world.handoffs.map((handoff) => ({ id: handoff.id, at: handoff.at, principal: handoff.principal, request: handoff.task, candidates: (handoff.candidates as Array<{ fact_id: string; p?: number; cut: string | null; tokens?: number }>).map((candidate) => ({ fact_id: candidate.fact_id, statement: deps.store.getFact(candidate.fact_id)?.statement ?? "", p: candidate.p ?? 0, decision: candidate.cut === null ? "kept" : candidate.cut === "budget" ? "cut_budget" : candidate.cut === "background" ? "cut_background" : "cut_relevance", tokens_est: candidate.tokens ?? 0 })), tokens_est: handoff.tokens, budget_est: handoff.budget_tokens, timings_ms: { search: handoff.retrieval_ms ?? null, judge: handoff.judge_ms ?? null, total: handoff.latency_ms ?? null }, simulated: deps.judge.name === "fake" || deps.retriever.name !== "moss" })) });
  }
  if (method === "GET" && path === "/api/agents") {
    if (!who && !isInternal) throw new HttpError(403, "person token required");
    const agents = [...deps.world.principals.values()].filter((p) => p.kind === "agent" && (isModerator || isInternal || p.created_by === callerId)).map((p) => agentView(deps, p));
    return reply(200, { agents });
  }
  const control = /^\/api\/agents\/([^/]+)\/(stop|control)$/.exec(path);
  if (control && (method === "POST" && control[2] === "stop" || method === "GET" && control[2] === "control")) {
    const target = deps.world.principals.get(decodeURIComponent(control[1]));
    if (control[2] === "control") {
      if (!isInternal) throw new HttpError(403, "internal clients only");
    } else if (!isModerator && (target?.kind !== "agent" || target.created_by !== callerId)) {
      throw new HttpError(403, "only the agent's creator or a moderator may do this");
    }
    if (!target || target.kind !== "agent") throw new HttpError(404, "no such agent");
    const generation = (deps.world.agentStops.get(target.id) ?? 0) + (control[2] === "stop" ? 1 : 0);
    if (control[2] === "stop") {
      deps.world.agentStops.set(target.id, generation);
      // Persist before broadcasting: reconnect recovery must see the same cancellation.
      await deps.world.flush();
      deps.bus.emit({ type: "dispatch.stop_requested", agent: target.id, by: callerId, generation });
    }
    return reply(200, { generation, ...(control[2] === "stop" ? { status: "stop_requested" } : {}) });
  }
  const run = /^\/api\/agents\/([^/]+)\/run$/.exec(path);
  if (run && method === "POST") {
    const target = deps.world.principals.get(decodeURIComponent(run[1]));
    if (!isModerator && target?.created_by !== callerId) throw new HttpError(403, "only the agent's creator or a moderator may do this");
    if (!target || target.kind !== "agent") throw new HttpError(404, "no such agent");
    const body = await readJsonBody(req);
    if (!isRecord(body) || (body.task !== undefined && (typeof body.task !== "string" || !body.task.trim()))) throw new HttpError(400, "task must be a non-empty string");
    const id = `dsp_${newSessionId().slice(4)}`;
    deps.bus.emit({ type: "dispatch.requested", id, request: { agent: target.id, by: callerId, stop_generation: deps.world.agentStops.get(target.id) ?? 0, ...(typeof body.task === "string" ? { task: body.task.trim() } : {}) } });
    return reply(200, { id });
  }
  return false;
}
