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
import { HttpError, applyCors, readJsonBody, sendJson } from "./http.ts";
import { createMcpServer } from "./mcp.ts";
import { handleScopesRoute } from "./scopes.ts";
import type { ScopeState } from "./scopes.ts";

export interface RouterDeps extends ApiDeps {
  tokens: Map<string, string>;
  world: ScopeState;
  log?: (line: string) => void;
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createRouter(deps: RouterDeps): Handler {
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
    const path = url?.pathname ?? String(req.url);
    res.on("finish", () => log(`${method} ${path} ${res.statusCode} ${Math.round(performance.now() - t0)}ms`));
    applyCors(res);
    if (!url) return sendJson(res, 400, { error: `bad request URL ${JSON.stringify(req.url)}` });

    try {
      if (method === "OPTIONS" && (path.startsWith("/api/") || path === ROUTES.mcp)) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (method === "GET" && path === ROUTES.health) return sendJson(res, 200, api.health(deps));

      // The dashboard has no token, so these three read-only routes accept a missing one, but a
      // tokenless caller only sees the scaffold folders: never `private/` (CLAUDE.md: nothing
      // external reads it), `inbox` or a scope group. A valid token narrows GET /api/facts to the
      // client's read grant; an unknown token is still a 401. Only internal clients and
      // moderators get the full event stream: anyone else could read a deal off fact.saved.
      if (method === "GET" && (path === ROUTES.events || path === ROUTES.facts || path === ROUTES.grants)) {
        const viewer = optionalAuth(req, deps.tokens);
        if (viewer === "unknown") return sendJson(res, 401, UNKNOWN_TOKEN);
        if (path === ROUTES.events) {
          attachSse(res, deps.bus, viewer && seesEverything(deps, viewer.client) ? undefined : publicEvent);
          return;
        }
        if (path === ROUTES.grants) return sendJson(res, 200, api.grants(deps));
        const visible = viewer ? grantView(deps, viewer.client) : publicFolder;
        if (!visible) return sendJson(res, 403, { error: `no grants for client "${viewer?.client}"` });
        return sendJson(res, 200, api.listFacts(deps, url.searchParams, visible));
      }

      // Everything below needs a client token.
      if (path.startsWith("/api/") || path === ROUTES.mcp) {
        const auth = authenticate(req, deps.tokens);
        if (!auth) return sendJson(res, 401, UNKNOWN_TOKEN);
        const { client } = auth;

        // Scopes surface (A2): tiers, rules, scopes, agents, quarantine, audit, handoff, dispatch.
        if (await handleScopesRoute(deps, client, method, path, url, req, res)) return;

        if (method === "POST" && path === ROUTES.sessions) return sendJson(res, 200, await api.postSession(deps, client, await readJsonBody(req)));
        if (method === "GET" && path.startsWith(`${ROUTES.sessions}/`)) {
          const id = decodeURIComponent(path.slice(ROUTES.sessions.length + 1));
          return sendJson(res, 200, await api.getSession(deps, client, id));
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

/**
 * The public SSE view: scaffold events with every free-text field that could name a deal removed
 * (a session title, a distill plan, a context task); a fact or a denial only for a public folder;
 * no scopes, triage, quarantine, audit or agent events at all.
 */
const publicEvent = (e: CanonEvent): boolean | CanonEvent => {
  switch (e.type) {
    case "server.started":
    case "distill.started":
    case "fact.retired":
      return true;
    case "session.captured": {
      const { title: _title, ...session } = e.session;
      return { ...e, session };
    }
    case "distill.finished": {
      const { plan: _plan, ...rest } = e;
      return rest;
    }
    case "context.served":
      return { ...e, task: "" };
    case "fact.saved":
      return publicFolder(e.fact.folder);
    case "access.denied":
      return publicFolder(e.folder);
    default:
      return false;
  }
};

/** Internal workers and moderators read the whole event stream. */
function seesEverything(deps: RouterDeps, client: string): boolean {
  if ((INTERNAL_CLIENTS as readonly string[]).includes(client)) return true;
  const principal = grantFor(deps.grants, client)?.principal;
  const p = principal ? deps.world.principals.get(principal) : undefined;
  return p?.kind === "person" && p.tier === "moderator";
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

  const server = createMcpServer({ client, grant, store: deps.store, retriever: deps.retriever, bus: deps.bus, judge: deps.judge });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
