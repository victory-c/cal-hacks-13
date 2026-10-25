// The member view's HTTP client for Canon, following docs/INTEGRATION.md: REST with a bearer
// token for reads and commands, SSE on /events for anything live. Routes marked PROPOSED are not
// in the contract yet; they are listed in web/README.md.

import { MEMBER_EVENT_TYPES } from "./contract.ts";
import type { AddItemBody, AgentBody, AgentRun, Fact, Me, MemberApi, MemberEvent } from "./contract.ts";
import { subscribeEvents } from "../stream.ts";

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
      credentials: "same-origin",
      headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
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
      const { groups } = await this.call<{ groups: { id: string; display?: string; name?: string }[] }>("GET", "/api/groups");
      return Object.fromEntries(groups.map((g) => [g.id, g.display ?? g.name ?? g.id]));
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
    // The unticked groups are exclusions like any other; Canon checks them in code before Jev runs.
    const groups = [...new Set([...body.exclusions.groups, ...(body.exclude_groups ?? [])])];
    return this.call("POST", "/api/agents", { name: body.name, task: body.task, exclusions: { ...body.exclusions, groups } });
  }

  async updateAgent(id: string, body: AgentBody): Promise<{ build_id: string }> {
    const path = encodeURIComponent(id);
    // A member edits the task and their own choice of groups. Canon preserves every other
    // exclusion server-side, including moderator-set barriers that are never returned to this client.
    return this.call("PUT", `/api/principals/${path}/rule`, {
      task: body.task,
      preserve_exclusions: true,
      ...(body.exclude_groups ? { exclude_groups: body.exclude_groups } : {}),
      exclude_text: body.exclusions.text.join("; "),
    });
  }

  /** PROPOSED: DELETE /api/agents/:id. */
  async deleteAgent(id: string): Promise<void> {
    await this.call("DELETE", `/api/agents/${encodeURIComponent(id)}`);
  }

  async runAgent(id: string, task?: string): Promise<void> {
    const agent = (await this.agents()).find((a) => a.id === id);
    if (!agent) throw new HttpError(404, "agent not found");
    // A one-off assignment runs inside the same fixed scope; it never widens what the agent sees.
    await this.call("POST", `/api/agents/${encodeURIComponent(id)}/run`, { task: task?.trim() || agent.task });
  }

  /** Requests cancellation; current agent telemetry reports when it has stopped. */
  async stopAgent(id: string): Promise<void> {
    await this.call("POST", `/api/agents/${encodeURIComponent(id)}/stop`);
  }

  subscribe(onEvent: (ev: MemberEvent) => void, onStatus: (s: "connecting" | "live" | "reconnecting") => void): () => void {
    let active = true;
    const emit = (event: MemberEvent) => { if (active) onEvent(event); };
    const close = subscribeEvents<Record<string, any>>(this.server, this.token, [...MEMBER_EVENT_TYPES, "agent.run", "principal.changed", "fact.retired"], (event) => {
      void (async () => {
        const at = String(event.at ?? "");
        if (event.type === "fact.saved") {
          // SSE carries canonical storage facts; only the current scoped REST projection is a
          // displayable memory. Replayed saves can refer to facts since revoked or retired.
          const fact = (await this.facts()).find((fact) => fact.id === event.fact?.id);
          if (fact) emit({ type: "fact.saved", at, fact });
        } else if (event.type === "fact.retired") {
          emit({ type: "scope.changed", at, principal: (await this.me()).id, added: [], removed: [] });
        } else if (event.type === "principal.changed") {
          emit({ type: "scope.changed", at, principal: "", added: [], removed: [] });
        } else if (event.type.startsWith("agent.")) {
          const agents = await this.agents();
          const principal = event.run?.agent ?? event.run?.id;
          const runId = event.step?.run_id ?? event.item?.run_id ?? event.run?.id;
          const run = agents.find((agent) => agent.id === principal || (agent as AgentRun & { run?: { id: string } }).run?.id === runId);
          if (!run) return;
          const type = event.type === "agent.run" ? (run.status === "done" || run.status === "failed" || run.status === "stopped" ? "agent.finished" : "agent.started") : event.type;
          emit({ type, at, run } as MemberEvent);
        } else emit(event as MemberEvent);
      })().catch(() => { /* a reconnect/current snapshot restores state after a failed refresh */ });
    }, onStatus);
    return () => { active = false; close(); };
  }
}
