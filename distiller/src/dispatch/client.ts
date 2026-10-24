// The dispatcher's own client for the Canon server, separate from the distiller's (../client.ts)
// because it speaks the v2 routes and authenticates as the internal `dispatcher` client
// (CANON_TOKEN_DISPATCHER). The dispatcher never imports server code: slices, exit checks,
// agent principals, deals and entitlements all come over the REST contract in
// shared/src/types/api.ts, and every run change goes out through POST /api/events.
//
// Henry's v2 routes may not exist yet (today's server is v1). A v2 route that answers 404, or a
// 401 because the server does not know the dispatcher token, is logged ONCE per route and the
// call degrades to a safe default (see each method), so the worker keeps running. Anything
// else (500, network) throws and the caller decides.

import { ROUTES, subscribeEvents } from "@canon/shared";
import type {
  CanonEvent,
  Deal,
  DealsResponse,
  Entitlement,
  EntitlementsResponse,
  ExitCheckBody,
  ExitCheckResult,
  HandoffBody,
  HandoffResult,
  Principal,
  PublishEventBody,
} from "@canon/shared";
import { errorMessage, warn } from "./log.ts";

const TIMEOUT_MS = 15_000;

/** One RELAYED_EVENTS event, as POST /api/events takes it. */
export type RelayedEvent = PublishEventBody["event"];

/** What the dispatcher, the planner and the worker need from the server. Tests fake this. */
export interface DispatchClient {
  /** True for the offline world (offline.ts). Logged as simulated. */
  readonly simulated: boolean;
  /** POST /api/handoff as the agent's principal. null when the route is missing: an empty slice. */
  handoff(body: HandoffBody): Promise<HandoffResult | null>;
  /** POST /api/exit-check. null when the route is missing: the caller fails closed. */
  exitCheck(body: ExitCheckBody): Promise<ExitCheckResult | null>;
  /** POST /api/events. A missing route drops the event (the dispatcher logs it locally). */
  publishEvent(event: RelayedEvent): Promise<void>;
  /** POST /api/principals for an agent (acts_for + side). A missing route is skipped. */
  registerPrincipal(principal: Principal): Promise<void>;
  /** GET /api/entitlements. A missing route is [] (deny by default: every run goes public). */
  getEntitlements(): Promise<Entitlement[]>;
  /** GET /api/deals. A missing route is []. */
  getDeals(): Promise<Deal[]>;
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

  const unavailable = (method: string, path: string, status: number) => {
    const key = `${method} ${path}`;
    if (warned.has(key)) return;
    warned.add(key);
    const why =
      status === 401
        ? `the server does not know the dispatcher token (add dispatcher=${opts.token} to CANON_CLIENT_TOKENS)`
        : "the server has no such route yet (v1 server?)";
    warn(`${key}: HTTP ${status}, ${why}; degrading and carrying on (logged once)`);
  };

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T | typeof UNAVAILABLE> {
    const url = base + path;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`${method} ${url} failed: ${errorMessage(err)}. Is the server running (npm run dev -w server)?`, { cause: err });
    }
    const text = await res.text();
    if (res.status === 404 || res.status === 401) {
      unavailable(method, path, res.status);
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

  return {
    simulated: false,
    async handoff(body) {
      const r = await call<HandoffResult>("POST", ROUTES.handoff, body);
      return r === UNAVAILABLE ? null : r;
    },
    async exitCheck(body) {
      const r = await call<ExitCheckResult>("POST", ROUTES.exitCheck, body);
      return r === UNAVAILABLE ? null : r;
    },
    async publishEvent(event) {
      const payload: PublishEventBody = { event };
      await call("POST", ROUTES.publish, payload);
    },
    async registerPrincipal(principal) {
      await call("POST", ROUTES.principals, principal);
    },
    async getEntitlements() {
      const r = await call<EntitlementsResponse>("GET", ROUTES.entitlements);
      return r === UNAVAILABLE ? [] : (r?.entitlements ?? []);
    },
    async getDeals() {
      const r = await call<DealsResponse>("GET", ROUTES.deals);
      return r === UNAVAILABLE ? [] : (r?.deals ?? []);
    },
  };
}

/**
 * GET /events through the shared SSE client (reconnects with backoff, never throws). Returns
 * unsubscribe(). The server replays its last events to every new subscriber; the worker skips
 * those by time (see index.ts).
 */
export function subscribe(
  opts: { baseUrl: string; token: string },
  onEvent: (e: CanonEvent) => void,
  hooks: { onOpen?: () => void; onError?: (err: unknown) => void } = {},
): () => void {
  const url = opts.baseUrl.replace(/\/+$/, "") + ROUTES.events;
  return subscribeEvents(url, onEvent, { headers: { authorization: `Bearer ${opts.token}` }, ...hooks });
}
