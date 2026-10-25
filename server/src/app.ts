// startServer(): wires store, bus, retriever, judge and router into one node:http server.
// Tests call it on port 0 with their own data dir; index.ts calls it with the env.

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { dataDir as defaultDataDir } from "@canon/shared";
import type { Grant, Judge } from "@canon/shared";

import { loadGrants, loadTokens } from "./auth.ts";
import { EventBus } from "./events.ts";
import { createRetriever } from "./retrieval/index.ts";
import type { Retriever } from "./retrieval/index.ts";
import { createRouter } from "./router.ts";
import { createServerJudge } from "./scope-judge.ts";
import { ScopeState, attachLivingScopes, buildInitialScopes, onFactSaved } from "./scopes.ts";
import type { WorldFixtures } from "./scopes.ts";
import { loadDemoWorld } from "./world.ts";
import { FileStore } from "./store.ts";

export interface StartOptions {
  /** 0 picks a free port (tests). */
  port?: number;
  host?: string;
  dataDir?: string;
  grants?: Grant[];
  /** token → client. */
  tokens?: Map<string, string>;
  judge?: Judge;
  retriever?: Retriever;
  /** Scopes world state; defaults to the demo world in fixtures/world/ (world.ts). */
  world?: WorldFixtures;
  /** Build the world's 0:00 scopes (`initial_scopes`) before listening. Default true. */
  buildInitialScopes?: boolean;
  log?: (line: string) => void;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
  bus: EventBus;
  store: FileStore;
  server: Server;
  judge: Judge;
  retriever: Retriever;
  tokens: Map<string, string>;
  grants: Grant[];
  world: ScopeState;
  dataDir: string;
  /** The living-scope listener; tests await `drain()` before reading a scope a new fact should have joined. */
  living: LivingScopes;
  /** True when the world was restored from `<data dir>/world/` rather than seeded from the fixtures. */
  restored: boolean;
}

/** What attachLivingScopes() returns: the in-flight living-scope updates, drained before shutdown. */
export type LivingScopes = ReturnType<typeof attachLivingScopes>;

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const dir = opts.dataDir ?? defaultDataDir();
  const restored = existsSync(join(dir, "world", "principals.json"));
  const tokens = opts.tokens ?? loadTokens();
  const grants = opts.grants ?? loadGrants();
  const judge = opts.judge ?? createServerJudge();
  const retriever = opts.retriever ?? createRetriever();

  const store = new FileStore(dir);
  const loaded = await store.loadAll();
  if (loaded.skipped) console.warn(`[store] ${loaded.skipped} file(s) skipped in ${dir}; see warnings above`);

  const bus = new EventBus();

  // Only hot facts are retrievable. Re-index whenever the hot set changes; the keyword stub makes
  // this instant, and Moss gets the same hook.
  const reindex = () =>
    retriever.index(store.listFacts({ tier: "hot" })).catch((err: unknown) => {
      console.error(`[retrieval] ${retriever.name} index failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  await reindex();
  bus.subscribe((e) => {
    if (e.type === "fact.saved" || e.type === "fact.retired") void reindex();
  });

  const world = new ScopeState(opts.world ?? loadDemoWorld().fixtures, dir);
  // Living scopes (PRD #11): new hot facts join the scopes whose checks they clear; retired facts leave.
  const living = attachLivingScopes({ world, store, bus, grants, judge, retriever });
  // The 0:00 scopes come from the real pipeline (this judge and retriever), never from a snapshot.
  if (opts.buildInitialScopes ?? true) {
    for (const r of await buildInitialScopes({ world, store, bus, grants, judge, retriever })) {
      if ("error" in r) console.error(`[scopes] initial scope for ${r.principal} not built: ${r.error}`);
      else (opts.log ?? console.info)(`[scopes] initial scope for ${r.principal}: ${r.facts} facts in ${r.ms} ms (${judge.name}, ${retriever.name})`);
    }
  }

  for (const scope of world.scopes.values()) {
    for (const fid of [...scope.fact_ids]) if (!store.getFact(fid) || store.getFact(fid)?.tier !== "hot") {
      scope.fact_ids = scope.fact_ids.filter((id) => id !== fid);
      const entry = { id: `aud_${Math.random().toString(16).slice(2, 10)}`, at: new Date().toISOString(), kind: "fact.left_scope" as const, actor: "server", principal: scope.principal, fact_ids: [fid], detail: "Fact no longer present in the hot store." };
      world.audit.push(entry); bus.emit({ type: "audit.logged", entry });
    }
  }
  // Re-offer only captures from the crash window. Existing joins are idempotent.
  for (const fact of store.listFacts({ tier: "hot" })) {
    const session = await store.getSession(fact.source.session);
    if (session?.ended_at && Date.parse(session.ended_at) >= Date.now() - 60_000) await onFactSaved({ world, store, bus, grants, judge, retriever }, fact);
  }
  await world.flush();
  const router = createRouter({ store, bus, grants, judge, retriever, tokens, world, startedAt: Date.now(), log: opts.log });
  const server = createServer((req, res) => void router(req, res));
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${host}:${port}`,
    bus,
    store,
    server,
    judge,
    retriever,
    tokens,
    grants,
    world,
    dataDir: dir,
    living,
    restored,
    close: async () => {
      await living.drain();
      living.unsubscribe();
      await world.flush();
      return new Promise<void>((resolve, reject) => {
        server.closeAllConnections(); // SSE clients would otherwise hold the server open
        server.close((err) => {
          if (err) reject(err);
          else Promise.resolve(retriever.close?.()).then(resolve, reject);
        });
      });
    },
  };
}
