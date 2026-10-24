// Typed fetch client for the Canon server. The distiller never imports server code: it reads
// sessions from the cold archive and writes decided facts over the REST contract in
// shared/src/types/api.ts, authenticated as the "distiller" client (CANON_TOKEN_DISTILLER).

import { ROUTES } from "@canon/shared";
import type { CapturedSession, Folder, ListFactsResponse, PostFactsBody, PostFactsResponse, Tier } from "@canon/shared";

const TIMEOUT_MS = 10_000;

export interface FactsQuery {
  folder?: Folder;
  tier?: Tier;
}

/** The slice of the server the worker needs. worker.test.ts fakes this interface. */
export interface CanonClient {
  getSession(id: string): Promise<CapturedSession>;
  listFacts(query?: FactsQuery): Promise<ListFactsResponse["facts"]>;
  postFacts(body: PostFactsBody): Promise<PostFactsResponse>;
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

export function createClient(opts: { baseUrl: string; token: string }): CanonClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${opts.token}`, accept: "application/json" };

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
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
  };
}
