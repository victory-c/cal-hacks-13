// Request dispatch: auth, CORS, one log line per request, JSON errors. Routes are the ones in
// ROUTES (shared/src/types/api.ts); the handlers live in api.ts and mcp.ts.

import type { IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { ROUTES, canRead, folderAllows, grantFor } from "@canon/shared";
import type { CanonEvent, Folder } from "@canon/shared";

import * as api from "./api.ts";
import type { ApiDeps } from "./api.ts";
import { authenticate } from "./auth.ts";
import { attachSse } from "./events.ts";
import { HttpError, applyCors, readJsonBody, sendJson } from "./http.ts";
import { createMcpServer } from "./mcp.ts";

export interface RouterDeps extends ApiDeps {
  tokens: Map<string, string>;
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
      // tokenless caller never sees `private/` (CLAUDE.md: nothing external reads it). A valid
      // token narrows GET /api/facts to the client's read grant; an unknown token is still a 401.
      if (method === "GET" && (path === ROUTES.events || path === ROUTES.facts || path === ROUTES.grants)) {
        const viewer = optionalAuth(req, deps.tokens);
        if (viewer === "unknown") return sendJson(res, 401, UNKNOWN_TOKEN);
        if (path === ROUTES.events) {
          attachSse(res, deps.bus, viewer ? undefined : publicEvent, viewer?.client === "distiller" ? undefined : withoutExtractionPlan);
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

        if (method === "POST" && path === ROUTES.sessions) return sendJson(res, 200, await api.postSession(deps, client, await readJsonBody(req)));
        if (method === "GET" && path.startsWith(`${ROUTES.sessions}/`)) {
          const id = decodeURIComponent(path.slice(ROUTES.sessions.length + 1));
          return sendJson(res, 200, await api.getSession(deps, client, id));
        }
        if (method === "POST" && path === ROUTES.facts) return sendJson(res, 200, await api.postFacts(deps, client, await readJsonBody(req)));
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

/** What a tokenless caller (the dashboard, a curl) may see: every folder but `private/`. */
const publicFolder = (folder: Folder): boolean => !folderAllows(["private"], folder);

/** The tokenless SSE view: the same rule applied to the one event that carries a whole fact. */
const publicEvent = (e: CanonEvent): boolean => e.type !== "fact.saved" || publicFolder(e.fact.folder);

/** Plans summarize raw transcripts and may mention facts not in the emitted batch. */
function withoutExtractionPlan(event: CanonEvent): CanonEvent {
  if (event.type !== "distill.finished") return event;
  const { plan: _plan, ...safe } = event;
  return safe;
}

/** A token's view of GET /api/facts is its read grant; undefined when the client has no grant. */
function grantView(deps: RouterDeps, client: string): ((folder: Folder) => boolean) | undefined {
  const grant = grantFor(deps.grants, client);
  return grant ? (folder) => canRead(grant, folder) : undefined;
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
