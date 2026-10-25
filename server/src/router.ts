// Request dispatch: auth, CORS, one log line per request, JSON errors. Routes are the ones in
// ROUTES (shared/src/types/api.ts); the handlers live in api.ts and mcp.ts.

import type { IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { INTERNAL_CLIENTS, ROUTES, canRead, folderAllows, grantFor } from "@canon/shared";
import type { CanonEvent, Folder } from "@canon/shared";

import * as api from "./api.ts";
import type { ApiDeps } from "./api.ts";
import { authenticate } from "./auth.ts";
import { attachSse } from "./events.ts";
import type { EventFilter } from "./events.ts";
import { HttpError, applyCors, readJsonBody, sendJson } from "./http.ts";
import { handleMemberRoute, memberFacts, principalFor } from "./member.ts";
import { createMcpServer } from "./mcp.ts";
import { MODERATORS_ONLY, callerRoles, handleScopesRoute } from "./scopes.ts";
import type { ScopeState } from "./scopes.ts";

export interface RouterDeps extends ApiDeps {
  tokens: Map<string, string>;
  world: ScopeState;
  log?: (line: string) => void;
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createRouter(deps: RouterDeps): Handler {
  deps.bus.subscribe((event) => {
    if (event.type === "scope.updated" && event.removed.length) {
      for (const agent of deps.world.principals.values()) {
        if (agent.kind !== "agent" || agent.id !== event.principal && agent.created_by !== event.principal) continue;
        const run = deps.world.agentRuns.get(agent.id); if (!run) continue;
        const runId = String(run.id);
        deps.world.invalidRunVersions.set(runId, Number(run.restarts ?? 0) + 1);
        deps.world.agentSteps.delete(runId); deps.world.agentInbox.delete(runId);
        deps.world.agentRuns.set(agent.id, { ...run, state: "restarting" });
      }
    }
    if (event.type === "handoff.served") deps.world.handoffs.unshift({ id: `handoff_${event.event_id}`, ...event });
    if (event.type === "agent.run") deps.world.agentRuns.set(event.run.agent, structuredClone(event.run) as unknown as Record<string, unknown>);
    if (event.type === "agent.step") { const steps = deps.world.agentSteps.get(event.step.run_id) ?? []; steps.push(structuredClone(event.step) as unknown as Record<string, unknown>); deps.world.agentSteps.set(event.step.run_id, steps); }
    if (event.type === "agent.inbox") { const items = deps.world.agentInbox.get(event.item.run_id) ?? []; items.push(structuredClone(event.item) as unknown as Record<string, unknown>); deps.world.agentInbox.set(event.item.run_id, items); }
    if (event.type === "scope.stage") deps.bus.emit({ type: "scope.build", principal: event.principal, build_id: event.principal, stage: ({ exclusions: "exclusions", moss: "candidates", jev: "judged", done: "done" } as const)[event.stage], ms: event.ms, remaining: event.remaining, counts: { remaining: event.remaining } });
    if (event.type === "scope.updated") deps.bus.emit({ type: "scope.changed", principal: event.principal, added: [...event.added], removed: [...event.removed] });
  });
  const log = deps.log ?? ((line: string) => console.info(line));

  return async (req, res) => {
    const t0 = performance.now();
    const method = req.method ?? "GET";
    // Node's parser accepts absolute-form targets (`GET http://x:99999/`) that the WHATWG parser
    // rejects; a throw here would be an unhandled rejection in app.ts and take the process down.
    let url: URL | undefined;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      url = undefined;
    }
    // An unparseable target is never logged or echoed: an absolute-form URL still carries its
    // query string, and /events takes the bearer token there (?token=).
    const path = url?.pathname ?? "<unparseable url>";
    res.on("finish", () => log(`${method} ${path} ${res.statusCode} ${Math.round(performance.now() - t0)}ms`));
    applyCors(res);
    if (!url) return sendJson(res, 400, { error: "bad request URL" });

    try {
      if (method === "OPTIONS" && (path.startsWith("/api/") || path === ROUTES.mcp)) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (method === "GET" && path === ROUTES.health) {
        const auth = optionalAuth(req, deps.tokens);
        if (auth === "unknown") return sendJson(res, 401, UNKNOWN_TOKEN);
        const who = auth ? principalFor(deps, auth.client) : undefined;
        if (who && who.tier !== "moderator") {
          const facts = deps.world.scopes.get(who.id)?.fact_ids.filter((id) => deps.store.getFact(id)?.tier === "hot") ?? [];
          return sendJson(res, 200, { ok: true, facts: facts.length, uptime_s: Math.round((Date.now() - deps.startedAt) / 1000), judge: deps.judge.name, retriever: deps.retriever.name });
        }
        return sendJson(res, 200, api.health(deps));
      }

      // The dashboard has no token, so these three read-only routes accept a missing one, but a
      // tokenless caller only sees the scaffold folders: never `private/` (CLAUDE.md: nothing
      // external reads it), `inbox` or a scope group. A valid token narrows GET /api/facts to the
      // client's read grant; an unknown token is still a 401. Only internal clients and
      // moderators get the full event stream: anyone else could read a deal off fact.saved.
      if (method === "GET" && (path === ROUTES.events || path === ROUTES.facts || path === ROUTES.grants)) {
        const eventToken = path === ROUTES.events ? url.searchParams.get("token") : null;
        if (eventToken && !req.headers.authorization) req.headers.authorization = `Bearer ${eventToken}`;
        const viewer = optionalAuth(req, deps.tokens);
        if (viewer === "unknown") return sendJson(res, 401, UNKNOWN_TOKEN);
        if (path === ROUTES.grants) {
          const who = viewer ? principalFor(deps, viewer.client) : undefined;
          if (who && who.tier !== "moderator") return sendJson(res, 403, MODERATORS_ONLY);
          return sendJson(res, 200, api.grants(deps));
        }
        const who = viewer ? principalFor(deps, viewer.client) : undefined;
        if (path === ROUTES.facts && who) return sendJson(res, 200, await memberFacts(deps, who, url.searchParams));
        const visible = viewer ? grantView(deps, viewer.client) : publicFolder;
        if (!visible) return sendJson(res, 403, { error: `no grants for client "${viewer?.client}"` });
        if (path === ROUTES.events) {
          // Moderators and internal workers see the whole stream; only the distiller sees raw
          // extraction plans, which summarize transcripts and may mention facts outside a batch.
          if (viewer?.client === "distiller") attachSse(res, deps.bus);
          else if (viewer && seesEverything(deps, viewer.client)) attachSse(res, deps.bus, withoutExtractionPlan);
          else if (who) attachSse(res, deps.bus, principalEvents(deps, who.id));
          else attachSse(res, deps.bus, eventView(deps, visible, viewer?.client));
          return;
        }
        return sendJson(res, 200, api.listFacts(deps, url.searchParams, visible));
      }

      // Everything below needs a client token.
      if (path.startsWith("/api/") || path === ROUTES.mcp) {
        const auth = authenticate(req, deps.tokens);
        if (!auth) return sendJson(res, 401, UNKNOWN_TOKEN);
        const { client } = auth;

        if (await handleMemberRoute(deps, client, method, path, url, req, res)) return;
        // Scopes surface (A2): tiers, rules, scopes, agents, quarantine, audit, handoff, dispatch.
        if (await handleScopesRoute(deps, client, method, path, url, req, res)) return;

        if (method === "GET" && path === ROUTES.sessions) {
          const { isInternal } = callerRoles(deps.world, deps.grants, client);
          if (!isInternal) return sendJson(res, 403, MODERATORS_ONLY);
          return sendJson(res, 200, { sessions: await deps.store.listSessions(url.searchParams.get("pending") === "1") });
        }
        const receipt = /^\/api\/sessions\/([^/]+)\/distilled$/.exec(path);
        if (method === "POST" && receipt) {
          const { isInternal } = callerRoles(deps.world, deps.grants, client);
          if (!isInternal) return sendJson(res, 403, MODERATORS_ONLY);
          const body = await readJsonBody(req) as { fingerprint?: unknown };
          if (typeof body?.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.fingerprint)) throw new HttpError(400, "invalid fingerprint");
          try { await deps.store.markDistilled(decodeURIComponent(receipt[1]), body.fingerprint); } catch (err) { throw new HttpError(409, String(err)); }
          return sendJson(res, 200, { ok: true });
        }
        if (method === "POST" && path === ROUTES.sessions) return sendJson(res, 200, await api.postSession(deps, client, await readJsonBody(req)));
        if (method === "GET" && path.startsWith(`${ROUTES.sessions}/`)) {
          // A raw session holds more than any one scope: moderators and internal clients only,
          // decided before the id is parsed so the same bytes come back whether it exists or not.
          const { isModerator, isInternal } = callerRoles(deps.world, deps.grants, client);
          if (!isModerator && !isInternal) return sendJson(res, 403, MODERATORS_ONLY);
          const id = decodeURIComponent(path.slice(ROUTES.sessions.length + 1));
          return sendJson(res, 200, await api.getSession(deps, id));
        }
        if (method === "POST" && path === ROUTES.facts) {
          const groups = deps.world.groups.map((g) => g.id);
          return sendJson(res, 200, await api.postFacts(deps, client, await readJsonBody(req), groups));
        }
        if (path === ROUTES.mcp && (method === "POST" || method === "GET" || method === "DELETE")) return handleMcp(deps, client, req, res);
      }

      sendJson(res, 404, { error: `no route for ${method} ${path}` });
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(`[server] ${method} ${path} failed:`, err);
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

const UNKNOWN_TOKEN = { error: "missing or unknown bearer token. Set Authorization: Bearer <token> from CANON_CLIENT_TOKENS." };

/** No header → null (public view); a header that maps to nobody → "unknown" (401); else the client. */
function optionalAuth(req: IncomingMessage, tokens: Map<string, string>): { client: string } | null | "unknown" {
  if (!req.headers.authorization) return null;
  return authenticate(req, tokens) ?? "unknown";
}

/**
 * What a tokenless caller (the scaffold dashboard, a curl) may see: the scaffold folders only.
 * Never `private/`, `inbox` (moderators only) or a scope group such as `deal/falcon`.
 */
const PUBLIC_FOLDERS = ["career", "projects", "team"];
const publicFolder = (folder: Folder): boolean => folderAllows(PUBLIC_FOLDERS, folder);

/** Internal workers and moderators read the whole event stream. */
function seesEverything(deps: RouterDeps, client: string): boolean {
  if ((INTERNAL_CLIENTS as readonly string[]).includes(client)) return true;
  const principal = grantFor(deps.grants, client)?.principal;
  const p = principal ? deps.world.principals.get(principal) : undefined;
  return p?.kind === "person" && p.tier === "moderator";
}

/** Plans summarize raw transcripts and may mention facts not in the emitted batch. */
function withoutExtractionPlan(event: CanonEvent): CanonEvent {
  if (event.type !== "distill.finished") return event;
  const { plan: _plan, ...safe } = event;
  return safe;
}

/**
 * Everyone else's stream (members, AI clients, the tokenless dashboard): the fact-read boundary on
 * replay and live events. A client token sees its own session and request metadata only; the
 * tokenless view also loses every free-text field that could name a deal (a session title, a
 * context task). No scope, triage, quarantine, audit or agent event passes.
 */
function eventView(deps: RouterDeps, visible: (folder: Folder) => boolean, client?: string): EventFilter {
  const readableFact = (id: string): boolean => {
    const fact = deps.store.getFact(id);
    return !!fact && visible(fact.folder);
  };
  const allowed = (event: CanonEvent): boolean => {
    switch (event.type) {
      case "fact.saved":
        // Re-check canonical state: a replayed fact may since have moved to another folder.
        return visible(event.fact.folder) && readableFact(event.fact.id);
      case "fact.retired":
        return readableFact(event.id) && readableFact(event.superseded_by);
      case "context.served":
        return (!client || event.client === client) && event.fact_ids.every(readableFact);
      case "session.captured":
        return !client || event.session.client === client;
      case "distill.started":
      case "distill.finished":
        return !client || deps.store.sessionClient(event.session_id) === client;
      case "access.denied":
        return (!client || event.client === client) && visible(event.folder);
      case "server.started":
        return true;
      default:
        return false;
    }
  };
  return (event) => {
    if (!allowed(event)) return false;
    switch (event.type) {
      case "distill.finished":
        return withoutExtractionPlan(event);
      case "fact.saved": {
        const { supersedes: factPrevious, ...fact } = event.fact;
        const { supersedes: decisionPrevious, triage: _triage, ...decision } = event.decision;
        return {
          ...event,
          fact: factPrevious && readableFact(factPrevious) ? { ...fact, supersedes: factPrevious } : fact,
          decision: decisionPrevious && readableFact(decisionPrevious)
            ? { ...decision, supersedes: decisionPrevious }
            : { ...decision, action: "add" },
        };
      }
      case "session.captured": {
        if (client) return event;
        const { title: _title, ...session } = event.session;
        return { ...event, session };
      }
      case "context.served":
        return client ? event : { ...event, task: "" };
      default:
        return event;
    }
  };
}

/**
 * A token's view of GET /api/facts is its read grant; undefined when the client has no grant.
 * The distiller also reads the server's listed groups, so triage sees every stored fact it files
 * against (duplicates and relations across groups).
 */
function grantView(deps: RouterDeps, client: string): ((folder: Folder) => boolean) | undefined {
  const grant = grantFor(deps.grants, client);
  if (!grant) return undefined;
  const groups = client === "distiller" ? deps.world.groups.map((g) => g.id) : [];
  return (folder) => canRead(grant, folder) || groups.includes(folder);
}

/**
 * Stateless Streamable HTTP: a fresh McpServer + transport per request, bound to this client's
 * grant, so no session table and nothing to leak between clients.
 */
async function handleMcp(deps: RouterDeps, client: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const grant = grantFor(deps.grants, client);
  if (!grant) return sendJson(res, 403, { error: `no grants for client "${client}"` });
  const body = req.method === "POST" ? await readJsonBody(req) : undefined;

  const server = createMcpServer({ client, grant, store: deps.store, retriever: deps.retriever, bus: deps.bus, judge: deps.judge, world: deps.world, grants: deps.grants });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

function principalEvents(deps: RouterDeps, principal: string): EventFilter {
  const ownsAgent = (id: string) => deps.world.principals.get(id)?.created_by === principal;
  const visibleFact = (id: string) => deps.world.scopes.get(principal)?.fact_ids.includes(id) ?? false;
  const ownsSession = (id: string) => deps.store.sessionPrincipal(id) === principal;
  return (event) => {
    switch (event.type) {
      case "fact.saved": {
        if (!visibleFact(event.fact.id)) return false;
        const { supersedes: _old, jev_keep: _score, ...fact } = event.fact;
        const { triage: _triage, supersedes: _prior, ...decision } = event.decision;
        return { ...event, fact: fact as typeof event.fact, decision: { ...decision, action: "add" } };
      }
      case "scope.updated": case "scope.changed": return event.principal === principal || ownsAgent(event.principal);
      case "scope.stage": case "scope.build": {
        if (event.principal !== principal && !ownsAgent(event.principal)) return false;
        const size = deps.world.scopes.get(event.principal)?.fact_ids.length ?? 0;
        return { ...event, remaining: size, ...(event.type === "scope.build" ? { counts: { remaining: size } } : {}) };
      }
      case "principal.changed": return event.principal.created_by === principal;
      case "session.captured": return ownsSession(event.session.id);
      case "item.captured": return event.author === principal;
      case "distill.started": case "distill.finished": return false;
      case "context.served": return deps.grants.some((g) => g.client === event.client && g.principal === principal);
      case "agent.run": return ownsAgent(event.run.agent) && !deps.world.invalidRunVersions.has(event.run.id);
      case "agent.step": case "agent.inbox": { const runId = event.type === "agent.step" ? event.step.run_id : event.item.run_id; return !deps.world.invalidRunVersions.has(runId) && [...deps.world.agentRuns.values()].some((run) => run.id === runId && ownsAgent(String(run.agent))); }
      default: return false;
    }
  };
}
