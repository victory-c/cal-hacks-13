// The console's HTTP client for Canon, following docs/INTEGRATION.md with a moderator's token.
// Routes marked PROPOSED are not in the contract yet; web/README.md lists them.

import { HttpError } from "../member/canon.ts";
import type { AgentRun, Fact } from "../member/contract.ts";
import { MOD_EVENT_TYPES } from "./contract.ts";
import type { AddItemAsModerator, AuditEntry, Group, Handoff, HeldItem, ModEvent, ModPrincipal, ModeratorApi, ScopeRule } from "./contract.ts";

export class CanonModClient implements ModeratorApi {
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
    for (const id of ids) await this.call("POST", `/api/facts/${this.id(id)}/file`, { group, labels: [] });
  }

  editFact(id: string, statement: string) { return this.call<Fact>("PATCH", `/api/facts/${this.id(id)}`, { statement }); }
  async retireFact(id: string) { await this.call("POST", `/api/facts/${this.id(id)}/retire`); }
  addItem(body: AddItemAsModerator) { return this.call<{ item_id: string }>("POST", "/api/items", body); }
  async quarantine(): Promise<HeldItem[]> { return (await this.call<{ items: HeldItem[] }>("GET", "/api/quarantine")).items; }
  async release(id: string) { await this.call("POST", `/api/quarantine/${this.id(id)}/release`); }
  async agents(): Promise<AgentRun[]> { return (await this.call<{ agents: AgentRun[] }>("GET", "/api/agents")).agents; }
  async runAgent(id: string) { await this.call("POST", `/api/agents/${this.id(id)}/run`, {}); }
  /** PROPOSED: POST /api/agents/:id/stop. */
  async stopAgent(id: string) { await this.call("POST", `/api/agents/${this.id(id)}/stop`); }
  async handoffs(): Promise<Handoff[]> { return (await this.call<{ handoffs: Handoff[] }>("GET", "/api/handoffs")).handoffs; }
  async audit(): Promise<AuditEntry[]> { return (await this.call<{ entries: AuditEntry[] }>("GET", "/api/audit")).entries; }

  /** Same open question as the member client: EventSource cannot send an Authorization header. */
  subscribe(onEvent: (ev: ModEvent) => void, onStatus: (s: "connecting" | "live" | "reconnecting") => void): () => void {
    onStatus("connecting");
    const es = new EventSource(`${this.server}/events?token=${encodeURIComponent(this.token)}`);
    es.onopen = () => onStatus("live");
    es.onerror = () => onStatus("reconnecting");
    const handler = (e: MessageEvent<string>) => {
      try {
        onEvent(JSON.parse(e.data) as ModEvent);
      } catch {
        // dropped; the snapshot refetch on reconnect corrects state
      }
    };
    for (const t of MOD_EVENT_TYPES) es.addEventListener(t, handler as EventListener);
    return () => es.close();
  }
}
