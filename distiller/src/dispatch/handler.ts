// The dispatcher worker's event handler, apart from index.ts so tests and the offline CLI drive it
// with fakes:
//   dispatch.requested   -> run the agent (once per request id)
//   scope.updated        -> noteScopeChange first (synchronous), then removed facts -> urgent
//                           scope_narrowed (routing.routeNarrowing), then added facts -> collected
//                           for routeBatchMs across agents -> ONE judge ask for all their runs
//                           (routing.routeNewFacts) -> new_fact items
//   principal.changed    -> agent_created: remember the agent (its name and created_by);
//                           agent_deleted: urgent cancel for its runs, and a dispatch of it still
//                           reading the rule never starts one
// Events stamped more than the grace before the worker started (the server's SSE replay on
// connect) are not acted on; a replayed principal.changed still teaches the worker who created an
// agent. A request this worker already ran is skipped by its id: the ids are kept on disk
// (fileLedger), so a quick restart does not run it twice. One bad event is logged; the loop never
// dies.
//
// Added facts are routed only from the server's own read of the agent's scope: an id in the event
// that the scope read does not hold is never asked about or delivered. A narrowing heard while the
// judge was thinking drops that run's items: its restart rebuilds the folder from the whole current
// scope, so nothing that still belongs is lost. Scope-read discoveries join this same batch;
// the dispatcher remembers judged pairs, including declines.

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { CanonEvent, Judge, Principal } from "@canon/shared";
import type { DispatchClient } from "./client.ts";
import type { Dispatcher } from "./dispatcher.ts";
import { errorMessage, log, warn } from "./log.ts";
import { DELETED_TEXT, isActive, routeAgentDeleted, routeNarrowing, routeNewFacts } from "./routing.ts";
import type { ScopedNewFacts } from "./routing.ts";

/** dispatch.requested ids already handled. */
export interface RequestLedger {
  has(id: string): boolean;
  add(id: string): void;
}

export interface HandlerOptions {
  dispatcher: Pick<Dispatcher, "dispatch" | "deliver" | "routable" | "noteScopeChange"> & Partial<Pick<Dispatcher, "setScopeRouter" | "routeFacts">>;
  client: Pick<DispatchClient, "getScopeFacts">;
  judge: Judge;
  /** Skip events stamped more than this before the handler was created. Default 5000. */
  replayGraceMs?: number;
  /** Request ids already run. Default: in memory only. The worker passes fileLedger(). */
  ledger?: RequestLedger;
  /** Added facts heard within this window are routed in one judge call. Default DEFAULT_ROUTE_BATCH_MS. */
  routeBatchMs?: number;
}

/** How long the handler collects scope.updated added facts before the one routing call. */
export const DEFAULT_ROUTE_BATCH_MS = 25;

export interface DispatchHandler {
  (event: CanonEvent): Promise<void>;
  /** Resolves when every in-flight handler call has finished (tests, SIGINT). */
  settle(): Promise<void>;
}

/** Agent principals the worker has heard about, newest last; bounded like the ledger. */
const MAX_KNOWN_AGENTS = 1000;

export function createDispatchHandler(opts: HandlerOptions): DispatchHandler {
  const cutoff = Date.now() - (opts.replayGraceMs ?? 5000);
  const batchMs = Math.max(0, opts.routeBatchMs ?? DEFAULT_ROUTE_BATCH_MS);
  const ledger = opts.ledger ?? memoryLedger();
  const inflight = new Set<Promise<void>>();
  const agents = new Map<string, Principal>();
  const deleted = new Set<string>();
  /** Dispatches still reading their agent's scope rule, by agent: a deletion heard meanwhile marks them. */
  const starting = new Map<string, Set<{ deleted: boolean }>>();
  let noScopeRoute = false;

  const remember = (p: Principal) => {
    agents.delete(p.id);
    agents.set(p.id, p);
    if (agents.size > MAX_KNOWN_AGENTS) agents.delete(agents.keys().next().value as string);
  };

  /** One routing pass for every agent in the batch: their own scope reads, then ONE judge call. */
  const routeBatch = async (byAgent: ReadonlyMap<string, ReadonlySet<string>>): Promise<void> => {
    const runs = opts.dispatcher.routable().filter((r) => isActive(r) && byAgent.has(r.agent));
    if (runs.length === 0) return;
    const gens = new Map(runs.map((r) => [r.run_id, r.scope_gen]));
    const agentsWithRuns = [...new Set(runs.map((r) => r.agent))];
    const reads = await Promise.all(agentsWithRuns.map(async (agent) => ({ agent, scope: await opts.client.getScopeFacts(agent) })));
    const scoped: ScopedNewFacts[] = [];
    for (const { agent, scope } of reads) {
      if (scope === null) {
        if (!noScopeRoute) log(`scope.updated: the server has no scope facts route yet; new facts are not routed (logged once)`);
        noScopeRoute = true;
        continue;
      }
      const wanted = byAgent.get(agent)!;
      // Never route a fact the agent's scope does not hold, whatever the event said.
      const facts = opts.dispatcher.routeFacts ? scope : scope.filter((f) => wanted.has(f.id));
      if (facts.length) scoped.push({ agent, facts });
    }
    if (scoped.length === 0) return;
    if (opts.dispatcher.routeFacts) {
      const n = await opts.dispatcher.routeFacts(scoped, opts.judge, gens);
      log(`new facts: ${n} new_fact item(s) for ${runs.length} run(s)`);
      return;
    }
    const route = await routeNewFacts(scoped, runs, opts.judge);
    // A narrowing heard meanwhile: that run restarts from its whole current scope instead.
    const now = new Map(opts.dispatcher.routable().map((r) => [r.run_id, r.scope_gen]));
    const items = route.items.filter((i) => now.get(i.run_id) === gens.get(i.run_id));
    const n = opts.dispatcher.deliver(items);
    log(
      `new facts for ${scoped.map((s) => `${s.agent} (${s.facts.length})`).join(", ")}: ` +
        `${route.asked ? `one ${opts.judge.name} call (${route.questions} question(s))` : "no judge call"}, ${n} new_fact item(s) for ${runs.length} run(s)`,
    );
  };

  /**
   * One new fact joins many scopes at once, and the server sends one scope.updated per principal.
   * Added facts heard within routeBatchMs of each other are routed together, in one judge call.
   * Resolves when the batch this call joined has been routed (never rejects).
   */
  let pending: { byAgent: Map<string, Set<string>>; done: Promise<void> } | undefined;
  const routeAdded = (principal: string, added: readonly string[]): Promise<void> => {
    if (!opts.dispatcher.routable().some((r) => isActive(r) && r.agent === principal)) return Promise.resolve();
    if (!pending) {
      const batch = { byAgent: new Map<string, Set<string>>(), done: Promise.resolve() };
      batch.done = new Promise<void>((resolve) => setTimeout(resolve, batchMs))
        .then(() => {
          if (pending === batch) pending = undefined;
          return routeBatch(batch.byAgent);
        })
        .catch((err) => warn(`routing new facts failed, nothing routed: ${errorMessage(err)}`));
      pending = batch;
    }
    const ids = pending.byAgent.get(principal) ?? new Set<string>();
    for (const id of added) ids.add(id);
    pending.byAgent.set(principal, ids);
    return pending.done;
  };

  opts.dispatcher.setScopeRouter?.(routeAdded);

  const handle = async (event: CanonEvent, replayed: boolean): Promise<void> => {
    switch (event.type) {
      case "principal.changed": {
        const p = event.principal;
        if (p.kind !== "agent") return;
        if (event.change === "agent_deleted") {
          agents.delete(p.id);
          deleted.add(p.id);
          // A dispatch waiting on the rule has no run to cancel yet: it never starts one.
          for (const ticket of starting.get(p.id) ?? []) ticket.deleted = true;
          if (replayed) return;
          const n = opts.dispatcher.deliver(routeAgentDeleted(p.id, opts.dispatcher.routable()));
          log(`agent ${p.id} deleted by ${event.by}: ${n} run(s) cancelled`);
          return;
        }
        deleted.delete(p.id);
        remember(p);
        return;
      }
      case "dispatch.requested": {
        if (replayed || ledger.has(event.id)) return;
        ledger.add(event.id);
        const { agent } = event.request;
        if (deleted.has(agent)) {
          log(`dispatch ${event.id}: ${agent} was deleted; not run`);
          return;
        }
        // Deleted while the rule is read: the dispatcher asks the ticket right before the run
        // starts, so the run ends cancelled without reading the agent's scope or running a step.
        const ticket = { deleted: false };
        const tickets = starting.get(agent) ?? new Set<{ deleted: boolean }>();
        tickets.add(ticket);
        starting.set(agent, tickets);
        let run;
        try {
          run = await opts.dispatcher.dispatch(event.request, agents.get(agent), () => (ticket.deleted ? DELETED_TEXT : undefined));
        } finally {
          tickets.delete(ticket);
          if (tickets.size === 0 && starting.get(agent) === tickets) starting.delete(agent);
        }
        if (ticket.deleted) log(`dispatch ${event.id}: ${agent} was deleted while its rule was read; ${run.id} cancelled before it started`);
        else log(`dispatch ${event.id}: started ${run.id} for ${run.agent} (created by ${run.created_by})`);
        return;
      }
      case "scope.updated": {
        if (replayed) return;
        const removed = Array.isArray(event.removed) ? event.removed : [];
        const added = Array.isArray(event.added) ? event.added : [];
        // First, before any I/O: reads in flight for these runs are stale now.
        opts.dispatcher.noteScopeChange(event.principal, removed, added);
        if (removed.length) {
          const n = opts.dispatcher.deliver(routeNarrowing({ principal: event.principal, removed }, opts.dispatcher.routable()));
          if (n) log(`${event.principal}: scope narrowed (${event.reason}); ${n} run(s) restart in a fresh folder`);
        }
        if (added.length) await routeAdded(event.principal, added);
        return;
      }
      default:
        return;
    }
  };

  const handler = (async (event: CanonEvent) => {
    // An unparseable `at` is NaN, which never compares true: treat it as live.
    const replayed = Date.parse(event.at) < cutoff;
    const p = handle(event, replayed).catch((err) => warn(`${event.type}: failed, skipping: ${errorMessage(err)}`));
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
 * once; the id still counts for this process. Normal writes trim memory and compact the file
 * atomically after twice the retained history has accumulated.
 */
export function fileLedger(path: string, keep = 1000): RequestLedger {
  if (!Number.isInteger(keep) || keep < 1) throw new Error("ledger keep must be a positive integer");
  let ids: string[] = [];
  const compact = (kept: readonly string[]) => {
    const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, kept.map((id) => `${JSON.stringify(id)}\n`).join(""), { encoding: "utf8", flag: "wx" });
      renameSync(temp, path);
    } finally {
      try { unlinkSync(temp); } catch { /* Renamed, or never created. */ }
    }
  };
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
      compact(ids);
    } catch {
      // trimming is housekeeping; the next add() reports a write problem
    }
  }
  const seen = new Set(ids);
  let lines = ids.length;
  let warned = false;
  return {
    has: (id) => seen.has(id),
    add: (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      if (seen.size > keep) seen.delete(seen.values().next().value!);
      try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify(id)}\n`, "utf8");
        lines++;
        if (lines > 2 * keep) {
          compact([...seen]);
          lines = seen.size;
        }
      } catch (err) {
        if (warned) return;
        warned = true;
        warn(`${path}: could not record dispatch ${id} (${errorMessage(err)}); a restart within the replay grace may run it again`);
      }
    },
  };
}
