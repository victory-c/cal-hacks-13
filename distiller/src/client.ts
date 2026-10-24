// Typed fetch client for the Bullwark server. The distiller never imports server code: it reads
// sessions from the cold archive and writes decided facts over the REST contract in
// shared/src/types/api.ts, authenticated as the "distiller" client (CANON_TOKEN_DISTILLER).
//
// The scopes routes the worker uses (groups, quarantine, event relay) are lane A's and may not
// exist yet: they throw CanonApiError with status 404 against today's server, and the worker
// treats that as "not there yet" (see isMissingRoute), never as a crash.

import { GROUP_NEW, GROUP_RE, GROUP_UNSURE, INBOX, RELAYED_EVENTS, ROUTES } from "@canon/shared";
import type { CapturedSession, Folder, Group, ListFactsResponse, PostFactsBody, PostFactsResponse, PostQuarantineBody, PublishEventBody, Tier } from "@canon/shared";

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
  /** GET /api/groups, checked by parseGroups(): a body it cannot use throws. */
  getGroups(): Promise<Group[]>;
  /** POST /api/quarantine. Resolves to the new QuarantineItem's id when the server says it. */
  postQuarantine(body: PostQuarantineBody): Promise<string | undefined>;
  /** POST /api/events. Rejects any type outside RELAYED_EVENTS before sending. */
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

/** True for a 404 or 405: the server does not have this route (not built yet). */
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
    getGroups: async () => parseGroups(await call<unknown>("GET", ROUTES.groups), `GET ${ROUTES.groups}`),
    async postQuarantine(body) {
      // PostQuarantineResponse is the QuarantineItem; { item } and an empty 200 are accepted too.
      return itemId(await call<unknown>("POST", ROUTES.quarantine, body, true));
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

// ---------------------------------------------------------------------------------------------
// Groups, checked. Filing against a list we misread (a group id we cannot write as a folder, a
// group whose aliases we never saw) proves nothing, so anything we cannot use throws: the worker
// then files every fact in the inbox (loadContext's groupsKnown false) instead of quietly filing
// against a partial list. Also used by cli.ts.

/**
 * A GroupsResponse ({ groups }) or a bare Group[]. Every group needs an id that is a group path
 * (GROUP_RE) and is not a sentinel answer ("new", "unsure"), or the whole list is refused. An
 * `inbox` entry is dropped: it is the fallback, never a pick. A missing description is "";
 * missing or malformed aliases are [] (non-strings dropped). A repeated id keeps the first.
 */
export function parseGroups(body: unknown, where: string): Group[] {
  const raw = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.groups) ? body.groups : undefined;
  if (!raw) throw new Error(`${where} is not a group list: need { groups: Group[] } or Group[] (see shared/src/types/scopes.ts)`);
  const out: Group[] = [];
  raw.forEach((g: unknown, i) => {
    const group = isRecord(g) ? g : {};
    const { id } = group;
    if (typeof id !== "string" || !GROUP_RE.test(id) || id === GROUP_NEW || id === GROUP_UNSURE) {
      throw new Error(`${where}: groups[${i}] needs an id like deal/falcon (lowercase slug path, not "new" or "unsure")`);
    }
    if (id === INBOX || out.some((o) => o.id === id)) return;
    out.push({ id, description: typeof group.description === "string" ? group.description : "", aliases: strings(group.aliases).filter((a) => a.trim()) });
  });
  return out;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
}

function itemId(res: unknown): string | undefined {
  if (typeof res !== "object" || res === null) return undefined;
  const r = res as { id?: unknown; item?: { id?: unknown } };
  if (typeof r.id === "string") return r.id;
  if (typeof r.item?.id === "string") return r.item.id;
  return undefined;
}
