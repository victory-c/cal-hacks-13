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
import { ScopeState, attachLivingScopes, loadWorldFixtures } from "./scopes.ts";
import type { WorldFixtures } from "./scopes.ts";
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
  /** Scopes world state; defaults to the fixtures in distiller/fixtures/world/. */
  world?: WorldFixtures;
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

  const world = new ScopeState(opts.world ?? loadWorldFixtures());
  // Living scopes (PRD #11): new hot facts join the scopes whose checks they clear; retired facts leave.
  attachLivingScopes({ world, store, bus, grants, judge, retriever });

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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections(); // SSE clients would otherwise hold the server open
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
