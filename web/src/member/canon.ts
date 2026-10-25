// The member view's HTTP client for Canon, following docs/INTEGRATION.md: REST with a bearer
// token for reads and commands, SSE on /events for anything live. Routes marked PROPOSED are not
// in the contract yet; they are listed in web/README.md.

import { MEMBER_EVENT_TYPES } from "./contract.ts";
import type { AddItemBody, AgentBody, AgentRun, Fact, Me, MemberApi, MemberEvent } from "./contract.ts";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class CanonClient implements MemberApi {
  readonly mode = "canon" as const;

  constructor(private readonly server: string, private readonly token: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.server}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const msg = await res.json().then((j: { error?: string }) => j.error).catch(() => undefined);
      throw new HttpError(res.status, msg ?? `${method} ${path} → ${res.status}`);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  me(): Promise<Me> {
    return this.call("GET", "/api/me");
  }

  async facts(): Promise<Fact[]> {
    return (await this.call<{ facts: Fact[] }>("GET", "/api/facts")).facts;
  }

  /** PROPOSED: GET /api/groups. Until it exists, groups show a readable form of their id. */
  async groupNames(): Promise<Record<string, string>> {
    try {
      const { groups } = await this.call<{ groups: { id: string; display: string }[] }>("GET", "/api/groups");
      return Object.fromEntries(groups.map((g) => [g.id, g.display]));
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return {};
      throw e;
    }
  }

  editFact(id: string, statement: string): Promise<Fact> {
    return this.call("PATCH", `/api/facts/${encodeURIComponent(id)}`, { statement });
  }

  async retireFact(id: string): Promise<void> {
    await this.call("POST", `/api/facts/${encodeURIComponent(id)}/retire`);
  }

  addItem(body: AddItemBody): Promise<{ item_id: string }> {
    return this.call("POST", "/api/items", body);
  }

  async agents(): Promise<AgentRun[]> {
    return (await this.call<{ agents: AgentRun[] }>("GET", "/api/agents")).agents;
  }

  createAgent(body: AgentBody): Promise<{ id: string; build_id: string }> {
    return this.call("POST", "/api/agents", body);
  }

  async updateAgent(id: string, body: AgentBody): Promise<{ build_id: string }> {
    const path = encodeURIComponent(id);
    // PROPOSED: PATCH /api/agents/:id for name, docs and schedule; the rule goes through the contract route.
    await this.call("PATCH", `/api/agents/${path}`, { name: body.name, docs: body.docs, schedule: body.schedule });
    return this.call("PUT", `/api/principals/${path}/rule`, { task: body.task, exclusions: body.exclusions });
  }

  /** PROPOSED: DELETE /api/agents/:id. */
  async deleteAgent(id: string): Promise<void> {
    await this.call("DELETE", `/api/agents/${encodeURIComponent(id)}`);
  }

  async runAgent(id: string): Promise<void> {
    await this.call("POST", `/api/agents/${encodeURIComponent(id)}/run`, {});
  }

  /** PROPOSED: POST /api/agents/:id/stop. */
  async stopAgent(id: string): Promise<void> {
    await this.call("POST", `/api/agents/${encodeURIComponent(id)}/stop`);
  }

  /**
   * EventSource cannot send an Authorization header, so the token rides in the query string here.
   * The contract needs to say how /events authenticates (open question in web/README.md).
   */
  subscribe(onEvent: (ev: MemberEvent) => void, onStatus: (s: "connecting" | "live" | "reconnecting") => void): () => void {
    onStatus("connecting");
    const es = new EventSource(`${this.server}/events?token=${encodeURIComponent(this.token)}`);
    es.onopen = () => onStatus("live");
    es.onerror = () => onStatus("reconnecting");
    const handler = (e: MessageEvent<string>) => {
      try {
        onEvent(JSON.parse(e.data) as MemberEvent);
      } catch {
        // a malformed event is dropped; the next snapshot refetch corrects state
      }
    };
    for (const t of MEMBER_EVENT_TYPES) es.addEventListener(t, handler as EventListener);
    return () => es.close();
  }
}
