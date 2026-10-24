// Typed fetch client for the Canon server. The distiller never imports server code: it reads
// sessions from the cold archive and writes decided facts over the REST contract in
// shared/src/types/api.ts, authenticated as the "distiller" client (CANON_TOKEN_DISTILLER).
//
// v2 routes (deals, lists, review queue, event relay) are lane A's and may not exist yet: they
// throw CanonApiError with status 404 against a v1 server, and the worker treats that as "not
// there yet" (see isMissingRoute), never as a crash.

import { RELAYED_EVENTS, ROUTES } from "@canon/shared";
import type {
  CapturedSession,
  Deal,
  DealsResponse,
  Folder,
  ListFactsResponse,
  ListsResponse,
  PostFactsBody,
  PostFactsResponse,
  PostReviewBody,
  PublishEventBody,
  Tier,
} from "@canon/shared";

const TIMEOUT_MS = 10_000;

export interface FactsQuery {
  folder?: Folder;
  tier?: Tier;
}

/** One event the distiller may relay: RELAYED_EVENTS only. */
export type RelayedEvent = PublishEventBody["event"];

/** The slice of the server the worker needs. worker.test.ts fakes this interface. */
export interface CanonClient {
  getSession(id: string): Promise<CapturedSession>;
  listFacts(query?: FactsQuery): Promise<ListFactsResponse["facts"]>;
  postFacts(body: PostFactsBody): Promise<PostFactsResponse>;
  /** v2: GET /api/deals. */
  getDeals(): Promise<Deal[]>;
  /** v2: GET /api/lists. The distiller is internal, so `watch` comes back too. */
  getLists(): Promise<ListsResponse>;
  /** v2: POST /api/review. Resolves to the new item's id when the server says it. */
  postReview(body: PostReviewBody): Promise<string | undefined>;
  /** v2: POST /api/events. Rejects any type outside RELAYED_EVENTS before sending. */
  publishEvent(event: RelayedEvent): Promise<void>;
}

export class CanonApiError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${url} -> HTTP ${status}: ${body.slice(0, 300) || "(empty body)"}`);
    this.name = "CanonApiError";
  }
}

/** True for a 404 or 405: the server does not have this route (a v1 server, or not built yet). */
export function isMissingRoute(err: unknown): boolean {
  return err instanceof CanonApiError && (err.status === 404 || err.status === 405);
}

export function createClient(opts: { baseUrl: string; token: string }): CanonClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${opts.token}`, accept: "application/json" };

  /** `allowEmpty`: an empty 2xx body resolves to undefined instead of failing the JSON parse. */
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown, allowEmpty = false): Promise<T> {
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
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(`${method} ${url} failed: ${why}. Is the server running (npm run dev -w server)?`, { cause: err });
    }
    const text = await res.text();
    if (!res.ok) throw new CanonApiError(method, url, res.status, text);
    if (allowEmpty && text.trim() === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${method} ${url} returned non-JSON: ${text.slice(0, 300)}`);
    }
  }

  return {
    getSession: (id) => call<CapturedSession>("GET", `${ROUTES.sessions}/${encodeURIComponent(id)}`),
    async listFacts(query = {}) {
      const qs = new URLSearchParams();
      if (query.folder) qs.set("folder", query.folder);
      if (query.tier) qs.set("tier", query.tier);
      const suffix = qs.size ? `?${qs}` : "";
      const res = await call<ListFactsResponse>("GET", ROUTES.facts + suffix);
      return res.facts ?? [];
    },
    postFacts: (body) => call<PostFactsResponse>("POST", ROUTES.facts, body),
    async getDeals() {
      const res = await call<DealsResponse | undefined>("GET", ROUTES.deals);
      return Array.isArray(res?.deals) ? res.deals : [];
    },
    async getLists() {
      const res = await call<ListsResponse | undefined>("GET", ROUTES.lists);
      const out: ListsResponse = { restricted: Array.isArray(res?.restricted) ? res.restricted : [] };
      if (Array.isArray(res?.watch)) out.watch = res.watch;
      return out;
    },
    async postReview(body) {
      // The contract does not pin the response yet: accept the item itself, { item }, or { id }.
      return reviewId(await call<unknown>("POST", ROUTES.review, body, true));
    },
    async publishEvent(event) {
      if (!(RELAYED_EVENTS as readonly string[]).includes(event?.type)) {
        throw new Error(`publishEvent: "${String(event?.type)}" is not a relayed event (${RELAYED_EVENTS.join(", ")})`);
      }
      const body: PublishEventBody = { event };
      await call<unknown>("POST", ROUTES.publish, body, true);
    },
  };
}

function reviewId(res: unknown): string | undefined {
  if (typeof res !== "object" || res === null) return undefined;
  const r = res as { id?: unknown; item?: { id?: unknown } };
  if (typeof r.id === "string") return r.id;
  if (typeof r.item?.id === "string") return r.item.id;
  return undefined;
}
