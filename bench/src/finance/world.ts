// One synthetic world per setup: the REAL server (server/src/app.ts startServer) on a free port
// with a fresh seeded data dir and the setup's judge injected. Everything after startup goes over
// HTTP exactly as production traffic would — scope rebuilds as the moderator, agent creation as
// the member, handoffs as the internal dispatcher — so the pipeline being measured is
// server/src/scopes.ts runHandoff, never a bench-side reimplementation.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "@canon/server/src/app.ts";
import type { RunningServer } from "@canon/server/src/app.ts";
import { seedDataDir } from "@canon/server/src/seed.ts";
import { ROUTES, timed } from "@canon/shared";
import type { CapturedSession, Fact, HandoffResult, Judge, Principal, ScopeRule } from "@canon/shared";

import type { AgentSpec } from "./types.ts";

/** Clients the harness acts as. Their tokens come from the server's own token table. */
const MODERATOR_CLIENT = "maya";
const DISPATCHER_CLIENT = "dispatcher";
const STORE_READER_CLIENT = "distiller"; // reads every folder: the shared-memory "one store" view

export interface ScopeBuildTiming {
  principal: string;
  /** Wall-clock of the rebuild round-trip; a member's PUT also rebuilds their agents. */
  ms: number;
}

export interface WorldHealth {
  judge: string;
  retriever: string;
}

export class FinanceWorld {
  readonly url: string;
  readonly health: WorldHealth;
  readonly scopeBuilds: ScopeBuildTiming[];
  /** Member scope rules (the walls), fetched as the moderator. */
  readonly rules: Map<string, ScopeRule>;
  private readonly server: RunningServer;
  private readonly dataDir: string;
  private readonly tokenByClient: Map<string, string>;

  private constructor(server: RunningServer, dataDir: string, health: WorldHealth, rules: Map<string, ScopeRule>, scopeBuilds: ScopeBuildTiming[]) {
    this.server = server;
    this.dataDir = dataDir;
    this.url = server.url;
    this.health = health;
    this.rules = rules;
    this.scopeBuilds = scopeBuilds;
    this.tokenByClient = new Map([...server.tokens].map(([token, client]) => [client, token]));
  }

  /**
   * Seeds a throwaway data dir from server/fixtures/, starts the server with `judge`, and (when
   * `rebuildScopes`) rebuilds every member scope through PUT /api/scope-rules so the scopes being
   * measured come from this judge, not from the fixture snapshot. Rebuild times are measured.
   */
  static async start(opts: { judge: Judge; rebuildScopes: boolean }): Promise<FinanceWorld> {
    const dir = await mkdtemp(join(tmpdir(), "bench-finance-"));
    let server: RunningServer | undefined;
    try {
      await seedDataDir(dir);
      server = await startServer({ dataDir: dir, judge: opts.judge, port: 0, log: () => {} });
      const world = new FinanceWorld(server, dir, { judge: server.judge.name, retriever: server.retriever.name }, new Map(), []);
      await world.loadRules();
      if (opts.rebuildScopes) await world.rebuildScopes();
      return world;
    } catch (err) {
      await server?.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.server.close();
    await rm(this.dataDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private token(client: string): string {
    const token = this.tokenByClient.get(client);
    if (!token) throw new Error(`world: the server has no token for client "${client}" (CANON_CLIENT_TOKENS)`);
    return token;
  }

  private async call(method: string, path: string, client: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token(client)}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} as ${client}: HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text === "" ? undefined : (JSON.parse(text) as unknown);
  }

  /** Member rules via the API (as the moderator): the exclusions the leak check measures against. */
  private async loadRules(): Promise<void> {
    const { principals } = (await this.call("GET", ROUTES.principals, MODERATOR_CLIENT)) as { principals: Principal[] };
    for (const p of principals) {
      if (p.kind !== "person" || p.tier !== "member") continue;
      const rule = (await this.call("GET", `${ROUTES.scopeRules}/${encodeURIComponent(p.id)}`, MODERATOR_CLIENT)) as ScopeRule;
      this.rules.set(p.id, rule);
    }
  }

  /** PUT each member's own rule back: the server rebuilds their scope (and their agents') live. */
  private async rebuildScopes(): Promise<void> {
    for (const [principal, rule] of this.rules) {
      const { ms } = await timed(() =>
        this.call("PUT", `${ROUTES.scopeRules}/${encodeURIComponent(principal)}`, MODERATOR_CLIENT, { task: rule.task, exclude: rule.exclude }),
      );
      this.scopeBuilds.push({ principal, ms });
    }
  }

  /** The handoff under measurement, as the internal dispatcher. `httpMs` is the round-trip. */
  async handoff(principal: string, task: string): Promise<{ result: HandoffResult; httpMs: number }> {
    const { result, ms } = await timed(() => this.call("POST", ROUTES.handoff, DISPATCHER_CLIENT, { principal, task }));
    return { result: result as HandoffResult, httpMs: ms };
  }

  /** An agent-escalation attack: the member creates the agent; the server builds its capped scope. */
  async createAgent(createdBy: string, spec: AgentSpec): Promise<Principal> {
    return (await this.call("POST", ROUTES.agents, createdBy, { created_by: createdBy, name: spec.name, rule: spec.rule })) as Principal;
  }

  /** Posts a case's setup session as its own client. Facts appear only if a distiller is attached. */
  async postSession(session: CapturedSession): Promise<void> {
    await this.call("POST", ROUTES.sessions, session.client, session);
  }

  /** Every hot fact in the store (as the all-folder reader): the shared-memory baseline's context. */
  async allFacts(): Promise<Fact[]> {
    const { facts } = (await this.call("GET", `${ROUTES.facts}?tier=hot`, STORE_READER_CLIENT)) as { facts: Fact[] };
    return facts;
  }
}
