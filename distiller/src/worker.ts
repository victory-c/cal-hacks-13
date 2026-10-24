// The worker's event handler: session.captured → fetch → distill → Jev triage (one request) →
// POST /api/facts, then the review items (POST /api/review) and the relayed events
// (POST /api/events: triage.decided per draft, quarantine.flagged per held item).
// Built as a factory over an injected client/distiller/judge so worker.test.ts drives it with
// fakes and no network. One bad session is logged and skipped; the loop never dies.
//
// Against a v1 server the v2 routes 404. The worker says so once per route, triages with an
// empty deal list and labels nothing public (unlabeled facts are the safe default), and keeps going.

import { ROUTES, timed } from "@canon/shared";
import type { CanonEvent, Deal, Fact, Judge, ListsResponse } from "@canon/shared";
import { isMissingRoute } from "./client.ts";
import type { CanonClient, RelayedEvent } from "./client.ts";
import type { Distiller } from "./engines/index.ts";
import { errorMessage, log, warn } from "./log.ts";
import { summarizeTriage, triage, triagedFacts } from "./triage.ts";
import type { TriageResult } from "./triage.ts";

export interface HandlerOptions {
  client: CanonClient;
  distiller: Distiller;
  judge: Judge;
  /** DISTILL_LIVE=1: distill on every capture, not only when the session ended. */
  live: boolean;
  /** Debounce for live mode, per session id. Default 3000; tests pass 0. */
  debounceMs?: number;
  /**
   * The server replays its last 100 events to every new SSE subscriber and the client sends no
   * Last-Event-ID, so a restarted worker (tsx watch, crash, laptop sleep) sees ended sessions it
   * already distilled. A session.captured stamped more than this long before the handler was
   * created is a replay and is skipped. Default 5000.
   */
  replayGraceMs?: number;
}

export interface Handler {
  (event: CanonEvent): Promise<void>;
  /** Resolves once every queued or in-flight session has been processed (tests, SIGINT). */
  settle(): Promise<void>;
}

type Captured = Extract<CanonEvent, { type: "session.captured" }>;
type Pending = { timer: ReturnType<typeof setTimeout>; release: () => void };

export function createHandler(opts: HandlerOptions): Handler {
  const debounceMs = opts.debounceMs ?? 3000;
  const startedAt = Date.now();
  const replayCutoff = startedAt - (opts.replayGraceMs ?? 5000);
  const processed = new Set<string>(); // "<id>:<messages>" keys; a re-sent session is a no-op
  const pending = new Map<string, Pending>(); // live-mode debounce, one per session id
  const inflight = new Set<Promise<void>>();
  const warnOnce = onceWarner(); // one line per missing v2 route for the worker's whole life

  const track = (p: Promise<void>): Promise<void> => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
    return p;
  };
  const run = (event: Captured) => track(processSession(event, opts, processed, warnOnce));

  // A newer capture (or the final one) supersedes a waiting debounce; release its waiter.
  const cancelPending = (id: string) => {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    p.release();
  };

  const handler = (async (event: CanonEvent) => {
    if (event.type !== "session.captured") return;
    const { id, ended, messages } = event.session;

    // An unparseable `at` is NaN, which never compares true: fail open and process it.
    if (Date.parse(event.at) < replayCutoff) {
      log(`session ${id}: captured ${event.at}, before this worker started; replayed, skipping`);
      return;
    }

    if (ended) {
      cancelPending(id);
      await run(event);
      return;
    }
    if (!opts.live) {
      log(`session ${id}: ${messages} messages, not ended; waiting (DISTILL_LIVE=1 distills live)`);
      return;
    }
    cancelPending(id);
    let release!: () => void;
    const waiter = new Promise<void>((resolve) => (release = resolve));
    const timer = setTimeout(() => {
      pending.delete(id);
      void run(event).finally(release);
    }, debounceMs);
    pending.set(id, { timer, release });
    void track(waiter);
  }) as Handler;

  handler.settle = async () => {
    // Loop: a debounce that fires while we wait adds new in-flight work.
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
  };
  return handler;
}

async function processSession(event: Captured, opts: HandlerOptions, processed: Set<string>, warnOnce: WarnOnce): Promise<void> {
  const { id, messages } = event.session;
  const key = `${id}:${messages}`;
  if (processed.has(key)) {
    log(`session ${id}: already processed at ${messages} messages, skipping`);
    return;
  }
  processed.add(key);
  try {
    const fetched = await timed(() => opts.client.getSession(id));
    const session = fetched.result;
    log(`session ${id}: fetched ${session.messages.length} messages in ${fetched.ms} ms`);

    const distilled = await timed(() => opts.distiller.distill(session));
    const { drafts, plan, simulated } = distilled.result;
    log(`session ${id}: ${opts.distiller.name} distilled ${drafts.length} drafts in ${distilled.ms} ms${simulated ? " (simulated)" : ""}`);
    if (plan) log(`session ${id}: plan: ${plan}`);

    // Every captured item gets the injection question, drafts or not. The store, deals and lists
    // only matter when there is something to file.
    const ctx: TriageContext = drafts.length ? await loadContext(opts.client, warnOnce) : { existing: [], deals: [], lists: { restricted: [] }, labelPublic: false };
    const triaged = await timed(() => triage({ session, drafts, ...ctx }, opts.judge));
    const result = triaged.result;
    log(
      `session ${id}: ${opts.judge.name} triaged ${drafts.length} drafts against ${ctx.existing.length} facts and ${ctx.deals.length} deals in ${triaged.ms} ms (${summarizeTriage(result)})`,
    );
    if (result.quarantine) log(`session ${id}: quarantined: ${result.quarantine.excerpt ?? ""}`);
    if (drafts.length === 0 && !result.quarantine) {
      log(`session ${id}: nothing to save`);
      return;
    }

    const delivered = await timed(() => deliver(opts.client, result, warnOnce));
    const d = delivered.result;
    log(`session ${id}: saved ${d.saved.length}, retired ${d.retired.length}, filed ${d.reviews} review items, relayed ${d.events} events in ${delivered.ms} ms`);
  } catch (err) {
    // Let a later re-post of the same session retry; do not take the loop down.
    processed.delete(key);
    warn(`session ${id}: failed, skipping: ${errorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// v2 context and delivery. Exported for cli.ts (--post) and the tests.

/** Warns the first time a key is seen, then stays quiet: one line per missing route, not per session. */
export type WarnOnce = (key: string, msg: string) => void;

export function onceWarner(): WarnOnce {
  const seen = new Set<string>();
  return (key, msg) => {
    if (seen.has(key)) return;
    seen.add(key);
    warn(msg);
  };
}

export interface TriageContext {
  existing: Fact[];
  deals: Deal[];
  lists: ListsResponse;
  /** False unless both deals and lists came back: no name check, no public label. */
  labelPublic: boolean;
}

const NO_LISTS = "triaging with an empty deal list and no public labels (unlabeled facts are the safe default)";

/** Hot facts (required: a v1 route), deals and lists (v2: missing means degrade, not fail). */
export async function loadContext(client: CanonClient, warnOnce: WarnOnce): Promise<TriageContext> {
  const [existing, deals, lists] = await Promise.all([
    client.listFacts({ tier: "hot" }),
    optional(() => client.getDeals(), `GET ${ROUTES.deals}`, NO_LISTS, warnOnce),
    optional(() => client.getLists(), `GET ${ROUTES.lists}`, NO_LISTS, warnOnce),
  ]);
  return {
    existing,
    deals: deals.ok ? deals.value : [],
    lists: lists.ok ? lists.value : { restricted: [] },
    labelPublic: deals.ok && lists.ok,
  };
}

export interface Delivered {
  saved: string[];
  retired: string[];
  /** Review items the server accepted. */
  reviews: number;
  /** Events the server accepted for relay. */
  events: number;
}

/**
 * Files one triage result: facts first (a v1 route, so a failure here fails the session and it is
 * retried), then the review items, then the events. A missing v2 route is warned once and skipped
 * for the rest of this delivery; the facts already written are unlabeled or walled either way.
 */
export async function deliver(client: CanonClient, result: TriageResult, warnOnce: WarnOnce): Promise<Delivered> {
  const facts = triagedFacts(result);
  const posted = facts.length ? await client.postFacts({ facts }) : { saved: [], retired: [] };
  const out: Delivered = { saved: posted.saved, retired: posted.retired, reviews: 0, events: 0 };
  const gone = new Set<string>();
  const attempt = async <T>(route: string, consequence: string, fn: () => Promise<T>) => {
    if (gone.has(route)) return { ok: false as const };
    const r = await optional(fn, route, consequence, warnOnce);
    if (!r.ok && r.missing) gone.add(route);
    return r;
  };
  const review = `POST ${ROUTES.review}`;
  const publish = `POST ${ROUTES.publish}`;
  const noQueue = "review items are not filed (the facts stay unlabeled or quarantined, the safe side)";
  const noRelay = "triage events are not relayed to the dashboard";

  let quarantineId: string | undefined;
  if (result.quarantine) {
    const quarantine = result.quarantine;
    const r = await attempt(review, noQueue, () => client.postReview(quarantine));
    if (r.ok) {
      out.reviews++;
      quarantineId = r.value;
    }
  }
  for (const d of result.drafts) {
    const item = d.review;
    if (!item) continue;
    const r = await attempt(review, noQueue, () => client.postReview(item));
    if (r.ok) out.reviews++;
  }

  const at = new Date().toISOString();
  const events: RelayedEvent[] = [];
  if (result.quarantine) {
    // review_id is "" when the queue did not take the item (or did not say its id).
    events.push({ type: "quarantine.flagged", at, session_id: result.session_id, review_id: quarantineId ?? "", p: result.injection_p, excerpt: result.quarantine.excerpt ?? "" });
  }
  for (const d of result.drafts) {
    const event: RelayedEvent = { type: "triage.decided", at, session_id: result.session_id, statement: d.draft.statement, decision: d.decision };
    if (d.fact) event.fact_id = d.fact.id;
    events.push(event);
  }
  for (const event of events) {
    const r = await attempt(publish, noRelay, () => client.publishEvent(event));
    if (r.ok) out.events++;
  }
  return out;
}

type Optional<T> = { ok: true; value: T } | { ok: false; missing: boolean };

async function optional<T>(fn: () => Promise<T>, route: string, consequence: string, warnOnce: WarnOnce): Promise<Optional<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (isMissingRoute(err)) {
      warnOnce(route, `server has no ${route} yet (a v1 server?): ${consequence}`);
      return { ok: false, missing: true };
    }
    const why = errorMessage(err);
    warnOnce(`${route} ${why}`, `${route} failed: ${why}; ${consequence}`);
    return { ok: false, missing: false };
  }
}
