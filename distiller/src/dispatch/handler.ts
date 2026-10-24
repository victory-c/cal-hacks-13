// The dispatcher worker's event handler, apart from index.ts so tests drive it with fakes:
//   dispatch.requested   -> plan + start runs (once per request id)
//   fact.saved           -> routing.routeFact (wall check in code, then ONE judge ask) -> inboxes
//   deal.status_changed  -> routing.routeDealStatus (urgent) -> inboxes, then refresh the walls
//   entitlement.changed  -> a revoked grant cancels the runs that relied on it, then refresh the walls
// Events stamped more than the grace before the worker started (the server's SSE replay on
// connect) are skipped. A request inside the grace that this worker already ran is skipped by its
// id: the worker keeps those ids on disk (fileLedger), so a quick restart does not run it twice.
// One bad event is logged; the loop never dies.
//
// Handlers run concurrently, so a walls read can be overtaken by a wall change that arrives while
// it is in flight. Every wall change bumps a generation first; a read it overtook is never kept or
// used (it is read again), and a fact whose judge call it overtook is checked against the walls
// again, in code, before anything is delivered.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { CanonEvent, Deal, Entitlement, Judge } from "@canon/shared";
import type { DispatchClient } from "./client.ts";
import type { Dispatcher } from "./dispatcher.ts";
import { errorMessage, log, warn } from "./log.ts";
import { MAX_WALL_READS, canSee, isActive, routeDealStatus, routeEntitlementChange, routeFact } from "./routing.ts";
import type { WallView } from "./routing.ts";

/** dispatch.requested ids already handled. */
export interface RequestLedger {
  has(id: string): boolean;
  add(id: string): void;
}

export interface HandlerOptions {
  dispatcher: Pick<Dispatcher, "dispatch" | "deliver" | "routable" | "noteWallChange">;
  client: Pick<DispatchClient, "getDeals" | "getEntitlements">;
  judge: Judge;
  /** Skip events stamped more than this before the handler was created. Default 5000. */
  replayGraceMs?: number;
  /** Re-read deals and entitlements when the cache is older than this. Default 30 000. */
  wallsMaxAgeMs?: number;
  /** Request ids already run. Default: in memory only. The worker passes fileLedger(). */
  ledger?: RequestLedger;
}

export interface DispatchHandler {
  (event: CanonEvent): Promise<void>;
  /** Resolves when every in-flight handler call has finished (tests, SIGINT). */
  settle(): Promise<void>;
}

export function createDispatchHandler(opts: HandlerOptions): DispatchHandler {
  const cutoff = Date.now() - (opts.replayGraceMs ?? 5000);
  const maxAge = opts.wallsMaxAgeMs ?? 30_000;
  const ledger = opts.ledger ?? memoryLedger();
  const inflight = new Set<Promise<void>>();
  let walls: { deals: Deal[]; entitlements: Entitlement[]; at: number } | undefined;
  /** Bumped by every wall change, before anything else is done with it. */
  let wallsGen = 0;

  /** The walls from the cache, or a fresh read that no wall change overtook. */
  const view = async (fresh = false): Promise<WallView> => {
    if (!fresh && walls && Date.now() - walls.at <= maxAge) return { deals: walls.deals, entitlements: walls.entitlements };
    for (let attempt = 1; ; attempt++) {
      const gen = wallsGen;
      const [deals, entitlements] = await Promise.all([opts.client.getDeals(), opts.client.getEntitlements()]);
      if (gen === wallsGen) {
        walls = { deals, entitlements, at: Date.now() };
        return { deals, entitlements };
      }
      // A wall change arrived while this read was in flight: it may hold the state from before.
      if (attempt >= MAX_WALL_READS) throw new Error(`the walls changed during ${MAX_WALL_READS} reads in a row`);
    }
  };

  /**
   * After a wall change has been routed: re-read the walls. A failed refresh drops the cache, so
   * the next fact.saved re-reads them and, if that fails too, routes nothing (fails closed).
   */
  const refresh = async (what: string): Promise<void> => {
    try {
      await view(true);
    } catch (err) {
      walls = undefined;
      warn(`${what}: routed from the event, but the walls could not be refreshed (${errorMessage(err)}); the next fact re-reads them`);
    }
  };

  /** Synchronous, first thing on every wall change: reads and judge calls in flight now are stale. */
  const wallChanged = () => {
    wallsGen++;
    opts.dispatcher.noteWallChange();
  };

  const handle = async (event: CanonEvent): Promise<void> => {
    switch (event.type) {
      case "dispatch.requested": {
        if (ledger.has(event.id)) return;
        ledger.add(event.id);
        const runs = await opts.dispatcher.dispatch(event.request);
        log(`dispatch ${event.id}: started ${runs.map((r) => `${r.id} ${r.agent}@${r.side}`).join(", ") || "nothing"}`);
        return;
      }
      case "fact.saved": {
        const fact = event.fact;
        if (fact.tier !== "hot") return; // only hot facts are handed over, so only they are routed
        const runs = opts.dispatcher.routable();
        if (!runs.some(isActive)) return;
        let gen = wallsGen;
        const route = await routeFact(fact, runs, opts.judge, await view());
        // The judge's answers do not depend on the walls, but who may see the fact does: if a wall
        // changed while we read or asked, check every item again against the walls as they are now.
        let items = route.items;
        for (let attempt = 1; gen !== wallsGen; attempt++) {
          if (attempt > MAX_WALL_READS) throw new Error(`the walls changed during ${MAX_WALL_READS} checks in a row; fact ${fact.id} routed nowhere`);
          gen = wallsGen;
          const now = await view();
          items = items.filter((i) => {
            const run = runs.find((r) => r.run_id === i.run_id);
            return run !== undefined && canSee(run, fact.wall, now);
          });
        }
        const n = opts.dispatcher.deliver(items);
        log(
          `fact ${fact.id} (${fact.wall ?? "unlabeled"}): ${route.walled.length} run(s) walled off in code, ` +
            `${route.eligible.length} asked in ${route.asked ? "one" : "no"} ${opts.judge.name} call, ${n} inbox item(s)`,
        );
        return;
      }
      // Wall changes route from the event itself, before any I/O: a cancel never waits on, or is
      // lost to, a refresh of the walls. The cache is patched from the event at once, so a fact
      // routed meanwhile already sees the new wall.
      case "deal.status_changed": {
        wallChanged();
        if (walls) walls.deals = walls.deals.map((d) => (d.id === event.deal ? { ...d, status: event.to } : d));
        const n = opts.dispatcher.deliver(routeDealStatus(event, opts.dispatcher.routable(), { deals: walls?.deals ?? [] }));
        log(`deal ${event.deal}: ${event.from} -> ${event.to}; ${n} urgent inbox item(s)`);
        await refresh(`deal ${event.deal}`);
        return;
      }
      case "entitlement.changed": {
        wallChanged();
        const { principal, deal } = event.entitlement;
        if (walls) {
          const others = walls.entitlements.filter((e) => !(e.principal === principal && e.deal === deal));
          walls.entitlements = event.granted ? [...others, event.entitlement] : others;
        }
        const n = opts.dispatcher.deliver(routeEntitlementChange(event, opts.dispatcher.routable()));
        if (n) log(`entitlement ${principal}/${deal} revoked: ${n} run(s) cancelled`);
        await refresh(`entitlement ${principal}/${deal}`);
        return;
      }
      default:
        return;
    }
  };

  const handler = (async (event: CanonEvent) => {
    // An unparseable `at` is NaN, which never compares true: fail open and handle it.
    if (Date.parse(event.at) < cutoff) return;
    const p = handle(event).catch((err) => warn(`${event.type}: failed, skipping: ${errorMessage(err)}`));
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
    await p;
  }) as DispatchHandler;

  handler.settle = async () => {
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
  };
  return handler;
}

function memoryLedger(): RequestLedger {
  const ids = new Set<string>();
  return { has: (id) => ids.has(id), add: (id) => void ids.add(id) };
}

/**
 * A RequestLedger kept in a file (one JSON string per line), so a restarted worker skips the
 * requests it already ran even when the server's replay hands them back inside the grace. Only
 * the last `keep` ids are kept (the server replays a bounded buffer). A failed write is logged
 * once; the id still counts for this process.
 */
export function fileLedger(path: string, keep = 1000): RequestLedger {
  let ids: string[] = [];
  try {
    ids = readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          const id: unknown = JSON.parse(line);
          return typeof id === "string" ? [id] : [];
        } catch {
          return [];
        }
      });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") warn(`${path}: could not read the dispatch ledger (${errorMessage(err)}); starting empty`);
  }
  if (ids.length > keep) {
    ids = ids.slice(-keep);
    try {
      writeFileSync(path, ids.map((id) => `${JSON.stringify(id)}\n`).join(""), "utf8");
    } catch {
      // trimming is housekeeping; the next add() reports a write problem
    }
  }
  const seen = new Set(ids);
  let warned = false;
  return {
    has: (id) => seen.has(id),
    add: (id) => {
      seen.add(id);
      try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify(id)}\n`, "utf8");
      } catch (err) {
        if (warned) return;
        warned = true;
        warn(`${path}: could not record dispatch ${id} (${errorMessage(err)}); a restart within the replay grace may run it again`);
      }
    },
  };
}
