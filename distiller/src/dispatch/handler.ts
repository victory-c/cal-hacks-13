// The dispatcher worker's event handler, apart from index.ts so tests drive it with fakes:
//   dispatch.requested   -> plan + start runs (once per request id)
//   fact.saved           -> routing.routeFact (wall check in code, then ONE judge ask) -> inboxes
//   deal.status_changed  -> refresh the walls, routing.routeDealStatus (urgent) -> inboxes
//   entitlement.changed  -> refresh the walls; a revoked grant cancels the runs that relied on it
// Events stamped before the worker started (the server's SSE replay on connect) are skipped, so a
// restart never re-dispatches old tasks. One bad event is logged; the loop never dies.

import type { CanonEvent, Deal, Entitlement, Judge } from "@canon/shared";
import type { DispatchClient } from "./client.ts";
import type { Dispatcher } from "./dispatcher.ts";
import { errorMessage, log, warn } from "./log.ts";
import { routeDealStatus, routeEntitlementChange, routeFact } from "./routing.ts";
import type { WallView } from "./routing.ts";

export interface HandlerOptions {
  dispatcher: Pick<Dispatcher, "dispatch" | "deliver" | "routable">;
  client: Pick<DispatchClient, "getDeals" | "getEntitlements">;
  judge: Judge;
  /** Skip events stamped more than this before the handler was created. Default 5000. */
  replayGraceMs?: number;
  /** Re-read deals and entitlements when the cache is older than this. Default 30 000. */
  wallsMaxAgeMs?: number;
}

export interface DispatchHandler {
  (event: CanonEvent): Promise<void>;
  /** Resolves when every in-flight handler call has finished (tests, SIGINT). */
  settle(): Promise<void>;
}

export function createDispatchHandler(opts: HandlerOptions): DispatchHandler {
  const cutoff = Date.now() - (opts.replayGraceMs ?? 5000);
  const maxAge = opts.wallsMaxAgeMs ?? 30_000;
  const seen = new Set<string>();
  const inflight = new Set<Promise<void>>();
  let walls: { deals: Deal[]; entitlements: Entitlement[]; at: number } | undefined;

  const view = async (fresh = false): Promise<WallView> => {
    if (fresh || !walls || Date.now() - walls.at > maxAge) {
      const [deals, entitlements] = await Promise.all([opts.client.getDeals(), opts.client.getEntitlements()]);
      walls = { deals, entitlements, at: Date.now() };
    }
    return { deals: walls.deals, entitlements: walls.entitlements };
  };

  const handle = async (event: CanonEvent): Promise<void> => {
    switch (event.type) {
      case "dispatch.requested": {
        if (seen.has(event.id)) return;
        seen.add(event.id);
        const runs = await opts.dispatcher.dispatch(event.request);
        log(`dispatch ${event.id}: started ${runs.map((r) => `${r.id} ${r.agent}@${r.side}`).join(", ") || "nothing"}`);
        return;
      }
      case "fact.saved": {
        if (event.fact.tier !== "hot") return; // only hot facts are handed over, so only they are routed
        const runs = opts.dispatcher.routable();
        if (!runs.some((r) => r.state === "running" || r.state === "waiting" || r.state === "queued")) return;
        const route = await routeFact(event.fact, runs, opts.judge, await view());
        const n = opts.dispatcher.deliver(route.items);
        log(
          `fact ${event.fact.id} (${event.fact.wall ?? "unlabeled"}): ${route.walled.length} run(s) walled off in code, ` +
            `${route.eligible.length} asked in ${route.asked ? "one" : "no"} ${opts.judge.name} call, ${n} inbox item(s)`,
        );
        return;
      }
      case "deal.status_changed": {
        const v = await view(true);
        const items = routeDealStatus(event, opts.dispatcher.routable(), v);
        const n = opts.dispatcher.deliver(items);
        log(`deal ${event.deal}: ${event.from} -> ${event.to}; ${n} urgent inbox item(s)`);
        return;
      }
      case "entitlement.changed": {
        await view(true);
        const n = opts.dispatcher.deliver(routeEntitlementChange(event, opts.dispatcher.routable()));
        if (n) log(`entitlement ${event.entitlement.principal}/${event.entitlement.deal} revoked: ${n} run(s) cancelled`);
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
