// The console's HTTP client for Canon, following docs/INTEGRATION.md with a moderator's token.
// Routes marked PROPOSED are not in the contract yet; web/README.md lists them.

import { HttpError } from "../member/canon.ts";
import { subscribeEvents } from "../stream.ts";
import type { AgentRun, Fact } from "../member/contract.ts";
import { MOD_EVENT_TYPES } from "./contract.ts";
import type { AddItemAsModerator, AuditEntry, Group, Handoff, HeldItem, ModEvent, ModPrincipal, ModeratorApi, ScopeRule } from "./contract.ts";

export class CanonModClient implements ModeratorApi {
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

  private id(id: string): string {
    return encodeURIComponent(id);
  }

  me() { return this.call<ModPrincipal & { firm?: string }>("GET", "/api/me"); }

  async principals(): Promise<ModPrincipal[]> {
    const { principals } = await this.call<{ principals: Omit<ModPrincipal, "rule" | "fact_ids">[] }>("GET", "/api/principals");
    // The contract returns rule and scope per principal from GET /api/principals/:id/scope.
    return Promise.all(principals.map(async (p) => {
      try {
        const scope = await this.call<{ rule: ScopeRule; fact_ids: string[] }>("GET", `/api/principals/${this.id(p.id)}/scope`);
        return { ...p, rule: scope.rule, fact_ids: scope.fact_ids };
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return { ...p, rule: null, fact_ids: [] };
        throw e;
      }
    }));
  }

  /** PROPOSED: GET /api/groups. */
  async groups(): Promise<Group[]> { return (await this.call<{ groups: Group[] }>("GET", "/api/groups")).groups; }
  /** PROPOSED: POST /api/groups. */
  createGroup(name: string, description: string) { return this.call<Group>("POST", "/api/groups", { name, description }); }

  async facts(): Promise<Fact[]> {
    // A moderator's GET /api/facts returns everything; the inbox comes from GET /api/inbox.
    const [{ facts }, inbox] = await Promise.all([
      this.call<{ facts: Fact[] }>("GET", "/api/facts"),
      this.call<{ facts: Fact[] }>("GET", "/api/inbox").then((r) => r.facts),
    ]);
    return [...inbox.filter((f) => !facts.some((x) => x.id === f.id)), ...facts];
  }

  addPerson(name: string, tier: "moderator" | "member") { return this.call<ModPrincipal>("POST", "/api/principals", { name, tier }); }
  async setTier(id: string, tier: "moderator" | "member") { await this.call("POST", `/api/principals/${this.id(id)}/tier`, { tier }); }
  setRule(id: string, rule: ScopeRule) { return this.call<{ build_id: string }>("PUT", `/api/principals/${this.id(id)}/rule`, rule); }

  async fileFacts(ids: string[], group: string): Promise<void> {
    // Omitting labels preserves the fact's existing barriers; filing changes only its group.
    for (const id of ids) await this.call("POST", `/api/facts/${this.id(id)}/file`, { group });
  }

  editFact(id: string, statement: string) { return this.call<Fact>("PATCH", `/api/facts/${this.id(id)}`, { statement }); }
  async retireFact(id: string) { await this.call("POST", `/api/facts/${this.id(id)}/retire`); }
  addItem(body: AddItemAsModerator) { return this.call<{ item_id: string }>("POST", "/api/items", body); }
  async quarantine(): Promise<HeldItem[]> { return (await this.call<{ items: HeldItem[] }>("GET", "/api/quarantine")).items; }
  async release(id: string) { await this.call("POST", `/api/quarantine/${this.id(id)}/release`); }
  async agents(): Promise<AgentRun[]> { return (await this.call<{ agents: AgentRun[] }>("GET", "/api/agents")).agents; }
  async runAgent(id: string) {
    const agent = (await this.agents()).find((a) => a.id === id);
    if (!agent) throw new HttpError(404, "agent not found");
    await this.call("POST", `/api/agents/${this.id(id)}/run`, { task: agent.task });
  }
  /** PROPOSED: POST /api/agents/:id/stop. */
  async stopAgent(id: string) { await this.call("POST", `/api/agents/${this.id(id)}/stop`); }
  async handoffs(): Promise<Handoff[]> { return (await this.call<{ handoffs: Handoff[] }>("GET", "/api/handoffs")).handoffs; }
  async audit(): Promise<AuditEntry[]> { return (await this.call<{ entries: AuditEntry[] }>("GET", "/api/audit")).entries; }

  subscribe(onEvent: (ev: ModEvent) => void, onStatus: (s: "connecting" | "live" | "reconnecting") => void): () => void {
    let active = true;
    const emit = (event: ModEvent) => { if (active) onEvent(event); };
    const close = subscribeEvents<Record<string, any>>(this.server, this.token, [...MOD_EVENT_TYPES, "agent.run", "principal.changed", "handoff.served", "quarantine.flagged", "quarantine.released", "fact.retired", "audit.logged"], (event) => {
      void (async () => {
        const at = String(event.at ?? "");
        if (event.type === "fact.saved") {
          const fact = (await this.facts()).find((fact) => fact.id === event.fact?.id);
          if (fact) emit({ type: "fact.saved", at, fact });
        } else if (event.type === "fact.filed") {
          emit({ type: "fact.filed", at, fact_ids: event.fact_ids ?? [event.fact_id], group: event.group, from: Array.isArray(event.from) ? event.from : [event.from] });
        } else if (event.type === "principal.changed") {
          const principal = (await this.principals()).find((principal) => principal.id === event.principal?.id);
          if (principal) emit({ type: event.change === "tier_changed" ? "principal.tier" : "principal.added", at, principal });
          else emit({ type: "scope.changed", at, principal: "", added: [], removed: [] });
        } else if (event.type === "quarantine.flagged") {
          const item = (await this.quarantine()).find((item) => item.id === event.quarantine_id);
          if (item) emit({ type: "item.quarantined", at, item_id: item.id, source: item.source, reason: item.reason });
        } else if (event.type === "handoff.served" || event.type === "context.served") {
          const handoff = event.handoff ?? (await this.handoffs()).find((handoff) => handoff.at === at && handoff.principal === event.principal);
          if (handoff) emit({ type: "context.served", at, handoff });
        } else if (event.type.startsWith("agent.")) {
          const agents = await this.agents();
          const principal = event.run?.agent ?? event.run?.id;
          const runId = event.step?.run_id ?? event.item?.run_id ?? event.run?.id;
          const run = agents.find((agent) => agent.id === principal || (agent as AgentRun & { run?: { id: string } }).run?.id === runId);
          if (!run) return;
          const type = event.type === "agent.run" ? (run.status === "done" || run.status === "failed" || run.status === "stopped" ? "agent.finished" : "agent.started") : event.type;
          emit({ type, at, run } as ModEvent);
        } else if (["quarantine.released", "fact.retired", "audit.logged"].includes(event.type)) {
          emit({ type: "scope.changed", at, principal: "", added: [], removed: [] });
        } else emit(event as ModEvent);
      })().catch(() => { /* reconnect/current snapshots restore state after failed requests */ });
    }, onStatus);
    return () => { active = false; close(); };
  }
}
