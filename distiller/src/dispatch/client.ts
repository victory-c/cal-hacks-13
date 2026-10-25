// The dispatcher's own client for the Bullwark server, separate from the distiller's (../client.ts)
// because it speaks the scopes routes and authenticates as the internal `dispatcher` client
// (CANON_TOKEN_DISPATCHER). The dispatcher never imports server code: an agent's scope rule, its
// scope facts and its handoff come over the REST contract in shared/src/types/api.ts, every run
// change goes out through POST /api/events, and an agent's outputs go back in as its creator's
// memory through POST /api/sessions.
//
// Henry's scope routes may not exist yet. A route that answers 404, or a 401 because the server
// does not know the dispatcher token, is logged ONCE per route and the call degrades to the safe
// default named on each method (never a wider view: no scope means no facts), so the worker keeps
// running. Anything else (500, network) throws and the caller decides.

import { ROUTES, subscribeEvents } from "@canon/shared";
import type {
  CanonEvent,
  CapturedSession,
  Fact,
  HandoffBody,
  HandoffResult,
  PostSessionResponse,
  PublishEventBody,
  ScopeFactsResponse,
  ScopeRule,
} from "@canon/shared";
import { errorMessage, warn } from "./log.ts";

const TIMEOUT_MS = 15_000;

/** One RELAYED_EVENTS event, as POST /api/events takes it. */
export type RelayedEvent = PublishEventBody["event"];

/** What the dispatcher and the worker need from the server. Tests and the offline world fake this. */
export interface DispatchClient {
  /** True for the offline world (offline.ts). Logged and labelled as simulated. */
  readonly simulated: boolean;
  /** GET /api/scope-rules/:principal. null when there is none (or no route): the agent cannot run. */
  getScopeRule(principal: string): Promise<ScopeRule | null>;
  /** GET /api/scopes/:principal/facts: every fact in the principal's scope. null when the route is missing: no facts. */
  getScopeFacts(principal: string): Promise<Fact[] | null>;
  /** Durable cancellation, also checked when the SSE replay no longer contains Stop. */
  getStopGeneration?(agent: string): Promise<number>;
  /** POST /api/handoff as the agent's principal (the brief's facts). null when the route is missing. */
  handoff(body: HandoffBody): Promise<HandoffResult | null>;
  /** POST /api/events. A missing route drops the event (the dispatcher logs it locally). */
  publishEvent(event: RelayedEvent): Promise<void>;
  /**
   * POST /api/sessions: an agent's outputs, as its creator's memory. null when the route refuses
   * us. `signal` aborts the request (the dispatcher stops a save when the run is stopped); an
   * aborted save rejects, and the server may or may not have taken it.
   */
  postSession(session: CapturedSession, signal?: AbortSignal): Promise<PostSessionResponse | null>;
}

export class DispatchApiError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${url} -> HTTP ${status}: ${body.slice(0, 300) || "(empty body)"}`);
    this.name = "DispatchApiError";
  }
}

/** Sentinel: the route is missing (404) or the server does not know our token (401). */
const UNAVAILABLE = Symbol("unavailable");

export function createDispatchClient(opts: { baseUrl: string; token: string }): DispatchClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${opts.token}`, accept: "application/json" };
  const warned = new Set<string>();

  /** Logged once per route; `route` is the route's pattern, never a principal id. */
  const unavailable = (method: string, route: string, status: number) => {
    const key = `${method} ${route}`;
    if (warned.has(key)) return;
    warned.add(key);
    // Never the token's value: worker logs are read by people who should not hold it.
    const why =
      status === 401
        ? "the server does not know the dispatcher token (the server's CANON_CLIENT_TOKENS needs a dispatcher=<token> pair matching CANON_TOKEN_DISPATCHER)"
        : "the server has no such route yet, or nothing there";
    warn(`${key}: HTTP ${status}, ${why}; degrading safely and carrying on (logged once)`);
  };

  async function call<T>(method: "GET" | "POST", path: string, route: string, body?: unknown, signal?: AbortSignal): Promise<T | typeof UNAVAILABLE> {
    const url = base + path;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), signal]) : AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`${method} ${url} failed: ${errorMessage(err)}. Is the server running (npm run dev -w server)?`, { cause: err });
    }
    const text = await res.text();
    if (res.status === 404 || res.status === 401) {
      unavailable(method, route, res.status);
      return UNAVAILABLE;
    }
    if (!res.ok) throw new DispatchApiError(method, url, res.status, text);
    if (text.trim() === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${method} ${url} returned non-JSON: ${text.slice(0, 300)}`);
    }
  }

  const id = (principal: string) => encodeURIComponent(principal);

  return {
    simulated: false,
    async getStopGeneration(agent) {
      const r = await call<{ generation: number }>("GET", `${ROUTES.agents}/${id(agent)}/control`, `${ROUTES.agents}/:agent/control`);
      if (r === UNAVAILABLE || !Number.isSafeInteger(r.generation) || r.generation < 0) throw new Error("Could not verify the agent's Stop control");
      return r.generation;
    },
    async getScopeRule(principal) {
      const r = await call<ScopeRule>("GET", `${ROUTES.scopeRules}/${id(principal)}`, `${ROUTES.scopeRules}/:principal`);
      return r === UNAVAILABLE || !r ? null : r;
    },
    async getScopeFacts(principal) {
      const r = await call<ScopeFactsResponse>("GET", `${ROUTES.scopes}/${id(principal)}/facts`, `${ROUTES.scopes}/:principal/facts`);
      if (r === UNAVAILABLE) return null;
      return Array.isArray(r?.facts) ? r.facts : [];
    },
    async handoff(body) {
      const r = await call<HandoffResult>("POST", ROUTES.handoff, ROUTES.handoff, body);
      return r === UNAVAILABLE || !r ? null : r;
    },
    async publishEvent(event) {
      const payload: PublishEventBody = { event };
      await call("POST", ROUTES.publish, ROUTES.publish, payload);
    },
    async postSession(session, signal) {
      const r = await call<PostSessionResponse>("POST", ROUTES.sessions, ROUTES.sessions, session, signal);
      return r === UNAVAILABLE ? null : (r ?? { id: session.id, updated: false });
    },
  };
}

/**
 * GET /events through the shared SSE client (reconnects with backoff, never throws). Returns
 * unsubscribe(). The server replays its last events to every new subscriber; the worker skips
 * those by time (see handler.ts).
 */
export function subscribe(
  opts: { baseUrl: string; token: string },
  onEvent: (e: CanonEvent) => void,
  hooks: { onOpen?: () => void; onError?: (err: unknown) => void } = {},
): () => void {
  const url = opts.baseUrl.replace(/\/+$/, "") + ROUTES.events;
  return subscribeEvents(url, onEvent, { headers: { authorization: `Bearer ${opts.token}` }, ...hooks });
}
