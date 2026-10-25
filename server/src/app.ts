// startServer(): wires store, bus, retriever, judge and router into one node:http server.
// Tests call it on port 0 with their own data dir; index.ts calls it with the env.

import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { dataDir as defaultDataDir } from "@canon/shared";
import type { Grant, Judge } from "@canon/shared";

import { loadGrants, loadTokens } from "./auth.ts";
import { EventBus } from "./events.ts";
import { createRetriever } from "./retrieval/index.ts";
import type { Retriever } from "./retrieval/index.ts";
import { createRouter } from "./router.ts";
import { createServerJudge } from "./scope-judge.ts";
import { WorldPersister } from "./persist.ts";
import { ScopeState, attachLivingScopes, buildInitialScopes, reconcileScopes } from "./scopes.ts";
import type { LivingScopes, WorldFixtures } from "./scopes.ts";
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
  /**
   * Scopes world state. Default: the world persisted in the data dir (`world/`), else the demo
   * world in fixtures/world/ (world.ts). An explicit value wins (tests).
   */
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
  persister: WorldPersister;
  living: LivingScopes;
  /** True when the world was restored from the data dir rather than seeded from fixtures. */
  restored: boolean;
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const dir = opts.dataDir ?? defaultDataDir();
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

  // The world: what is on disk wins over the fixtures, so people added, rules edited, agents
  // created and scopes built since the last start are all still there (PIPELINE-PRD §4.4).
  const persisted = opts.world ? undefined : await WorldPersister.load(dir);
  const restored = persisted !== undefined;
  const world = new ScopeState(opts.world ?? persisted ?? loadDemoWorld().fixtures);
  const persister = new WorldPersister(dir);
  world.attachPersister(persister);
  const scopesDeps = { world, store, bus, grants, judge, retriever };
  // Living scopes (PRD #11): new hot facts join the scopes whose checks they clear; retired facts leave.
  const living = attachLivingScopes(scopesDeps);
  // The 0:00 scopes come from the real pipeline (this judge and retriever), never from a snapshot;
  // a scope restored from disk is left as it is.
  if (opts.buildInitialScopes ?? true) {
    for (const r of await buildInitialScopes(scopesDeps)) {
      if ("error" in r) console.error(`[scopes] initial scope for ${r.principal} not built: ${r.error}`);
      else (opts.log ?? console.info)(`[scopes] initial scope for ${r.principal}: ${r.facts} facts in ${r.ms} ms (${judge.name}, ${retriever.name})`);
    }
  }
  if (restored) {
    // Facts in no scope at all may have been saved right before a shutdown cut their living update short.
    const inSomeScope = new Set([...world.scopes.values()].flatMap((s) => s.fact_ids));
    const orphans = store.listFacts({ tier: "hot" }).filter((f) => !inSomeScope.has(f.id));
    const r = await reconcileScopes(scopesDeps, orphans);
    if (r.dropped || r.reoffered) (opts.log ?? console.info)(`[scopes] restored world: ${r.dropped} stale fact id(s) dropped, ${r.reoffered} unscoped fact(s) re-offered`);
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
    persister,
    living,
    restored,
    close: async () => {
      // Nothing is lost at shutdown (PIPELINE-PRD rule 9): in-flight living-scope updates finish
      // and every queued world write lands before the listener goes away. Bounded, so a hung
      // judge cannot keep the process alive.
      await Promise.race([living.drain(), new Promise<void>((r) => setTimeout(r, 10_000).unref())]);
      await persister.drain();
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections(); // SSE clients would otherwise hold the server open
        server.close((err) => {
          if (err) reject(err);
          else Promise.resolve(retriever.close?.()).then(resolve, reject);
        });
      });
    },
  };
}
