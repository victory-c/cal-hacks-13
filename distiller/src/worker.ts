// The worker's event handler: session.captured → fetch → distill → Jev triage (one request) →
// POST /api/facts, then the review items (POST /api/review) and the relayed events
// (POST /api/events: triage.decided per draft, quarantine.flagged per held item).
// Built as a factory over an injected client/distiller/judge so worker.test.ts drives it with
// fakes and no network. One bad session is logged and skipped; the loop never dies.
//
// Against a v1 server the v2 routes 404. A v1 server checks folder grants only, never walls, so
// an unlabeled or deal-walled fact in team/ would reach any client that reads team/. The worker
// says so once per route, triages with an empty deal list, labels nothing public, files every
// fact in inbox (which no AI client reads), and keeps going.
//
// A v2 route that exists but fails for a moment (a 5xx, a timeout) does not lose what it was
// given: the review items and events it did not take are held and retried (with backoff, on the
// next capture, and once more on settle()), without sending the facts again.

import { ROUTES, timed } from "@canon/shared";
import type { CanonEvent, Deal, Fact, Judge, ListsResponse, PostReviewBody } from "@canon/shared";
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
  /**
   * First wait before retrying review items and events a route failed to take; doubles per try,
   * up to a minute. Default 5000.
   */
  retryMs?: number;
  /** How long held items are retried before the worker gives up on them and says so. Default 10 minutes. */
  retryForMs?: number;
}

export interface Handler {
  (event: CanonEvent): Promise<void>;
  /**
   * Resolves once every queued or in-flight session has been processed and anything held for
   * retry has had one more try (tests, SIGINT).
   */
  settle(): Promise<void>;
}

type Captured = Extract<CanonEvent, { type: "session.captured" }>;
type Pending = { timer: ReturnType<typeof setTimeout>; release: () => void };
type Held = { box: Unsent; tries: number; since: number };

const MAX_RETRY_MS = 60_000;

export function createHandler(opts: HandlerOptions): Handler {
  const debounceMs = opts.debounceMs ?? 3000;
  const retryMs = opts.retryMs ?? 5000;
  const retryForMs = opts.retryForMs ?? 10 * 60_000;
  const startedAt = Date.now();
  const replayCutoff = startedAt - (opts.replayGraceMs ?? 5000);
  const processed = new Set<string>(); // "<id>:<messages>" keys; a re-sent session is a no-op
  const pending = new Map<string, Pending>(); // live-mode debounce, one per session id
  const inflight = new Set<Promise<void>>();
  const warnOnce = onceWarner(); // one line per missing v2 route for the worker's whole life
  const held: Held[] = []; // review items and events a failing route did not take
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retrying: Promise<void> | undefined;

  const track = (p: Promise<void>): Promise<void> => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
    return p;
  };

  const scheduleRetry = () => {
    if (retryTimer || retrying || held.length === 0) return;
    const tries = Math.min(...held.map((h) => h.tries));
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void retryHeld();
    }, Math.min(MAX_RETRY_MS, retryMs * 2 ** tries));
    retryTimer.unref?.(); // the SSE stream keeps the worker up; this alone should not
  };

  // One pass over everything held. Facts are never in here, so nothing is written twice.
  const retryHeld = (): Promise<void> => {
    if (retrying) return retrying;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    const pass = async () => {
      for (const h of [...held]) {
        h.tries++;
        const id = h.box.session_id;
        const r = await redeliver(opts.client, h.box, warnOnce);
        if (r.reviews || r.events) log(`session ${id}: retry ${h.tries}: filed ${r.reviews} review items, relayed ${r.events} events`);
        if (r.unsent && Date.now() - h.since < retryForMs) {
          h.box = r.unsent;
          continue;
        }
        held.splice(held.indexOf(h), 1);
        if (r.unsent) warn(`session ${id}: gave up after ${h.tries} retries: ${describeUnsent(r.unsent)} not filed`);
      }
    };
    retrying = track(
      pass().finally(() => {
        retrying = undefined;
        scheduleRetry();
      }),
    );
    return retrying;
  };

  const hold = (box: Unsent) => {
    held.push({ box, tries: 0, since: Date.now() });
    scheduleRetry();
  };
  const run = (event: Captured) => track(processSession(event, opts, processed, warnOnce, hold));

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
    // The server is talking again (a re-post of the same capture lands here too): retry what is held.
    if (held.length) void retryHeld();

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
    // One more try now for anything held, rather than waiting for the timer.
    if (held.length) await retryHeld();
  };
  return handler;
}

async function processSession(event: Captured, opts: HandlerOptions, processed: Set<string>, warnOnce: WarnOnce, hold: (box: Unsent) => void): Promise<void> {
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
    log(
      `session ${id}: saved ${d.saved.length}, retired ${d.retired.length}, filed ${d.reviews} review items, relayed ${d.events} events in ${delivered.ms} ms${d.unsent ? `; held for retry: ${describeUnsent(d.unsent)}` : ""}`,
    );
    // The facts are saved, so the session stays processed; only what a route failed to take is retried.
    if (d.unsent) hold(d.unsent);
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
  /** False unless both deals and lists came back: no name check, no public label, every fact in inbox. */
  labelPublic: boolean;
}

const NO_LISTS =
  "triaging with an empty deal list: nothing is labeled public and every fact is filed in inbox, which no AI client reads (a server without these routes does not enforce walls)";

/**
 * Hot facts (required: a v1 route), deals and lists (v2: missing, failing or malformed means
 * degrade to labelPublic false, not fail; client.ts throws on a body it cannot use).
 */
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

export interface Delivered extends Sent {
  saved: string[];
  retired: string[];
}

type QuarantineFlagged = Extract<RelayedEvent, { type: "quarantine.flagged" }>;

/**
 * Review items and events not yet filed for one triage result. Facts are never in here: they go
 * first, and once the server saved them they are not sent again.
 */
export interface Unsent {
  session_id: string;
  /** The quarantine item and its quarantine.flagged event, which waits for the id the queue gives back. */
  quarantine?: { review: PostReviewBody; event: QuarantineFlagged };
  reviews: PostReviewBody[];
  events: RelayedEvent[];
}

export interface Sent {
  /** Review items the server accepted. */
  reviews: number;
  /** Events the server accepted for relay. */
  events: number;
  /**
   * What a route that exists failed to take (a 5xx, a timeout, a dropped connection): kept for
   * redeliver(). A route that is missing (404/405, a v1 server) is skipped, never kept.
   */
  unsent?: Unsent;
}

/**
 * Files one triage result: facts first (a v1 route, so a failure here fails the session and it is
 * retried whole), then the review items, then the events (redeliver()).
 */
export async function deliver(client: CanonClient, result: TriageResult, warnOnce: WarnOnce): Promise<Delivered> {
  const facts = triagedFacts(result);
  const posted = facts.length ? await client.postFacts({ facts }) : { saved: [], retired: [] };
  const sent = await redeliver(client, outbox(result), warnOnce);
  return { saved: posted.saved, retired: posted.retired, ...sent };
}

/** The review items and events one triage result files, none sent yet. */
function outbox(result: TriageResult): Unsent {
  const at = new Date().toISOString();
  const box: Unsent = { session_id: result.session_id, reviews: [], events: [] };
  if (result.quarantine) {
    const event: QuarantineFlagged = { type: "quarantine.flagged", at, session_id: result.session_id, review_id: "", p: result.injection_p, excerpt: result.quarantine.excerpt ?? "" };
    box.quarantine = { review: result.quarantine, event };
  }
  for (const d of result.drafts) if (d.review) box.reviews.push(d.review);
  for (const d of result.drafts) {
    const event: RelayedEvent = { type: "triage.decided", at, session_id: result.session_id, statement: d.draft.statement, decision: d.decision };
    if (d.fact) event.fact_id = d.fact.id;
    box.events.push(event);
  }
  return box;
}

const REVIEW = `POST ${ROUTES.review}`;
const PUBLISH = `POST ${ROUTES.publish}`;
const NO_QUEUE = "review items are not filed (the facts stay unlabeled or quarantined, the safe side)";
const NO_RELAY = "triage events are not relayed to the dashboard";

/**
 * Sends what `box` holds: the quarantine item, then its quarantine.flagged event with the id the
 * queue gave back, the label_unsure items, then the events. A missing route is warned once and
 * skipped for good (review_id is "" when the queue is missing or names no id). A route that exists
 * but fails keeps its items, and the rest of that route's items wait behind them, in `unsent`.
 */
export async function redeliver(client: CanonClient, box: Unsent, warnOnce: WarnOnce): Promise<Sent> {
  const left: Unsent = { session_id: box.session_id, reviews: [], events: [] };
  const out: Sent = { reviews: 0, events: 0 };
  const gone = new Set<string>();
  const failed = new Set<string>();
  const attempt = async <T>(route: string, consequence: string, fn: () => Promise<T>): Promise<Optional<T>> => {
    if (gone.has(route)) return { ok: false, missing: true };
    if (failed.has(route)) return { ok: false, missing: false };
    const r = await optional(fn, route, consequence, warnOnce);
    if (!r.ok) (r.missing ? gone : failed).add(route);
    return r;
  };

  const events: RelayedEvent[] = [];
  if (box.quarantine) {
    const { review, event } = box.quarantine;
    const r = await attempt(REVIEW, NO_QUEUE, () => client.postReview(review));
    if (r.ok) {
      out.reviews++;
      events.push({ ...event, review_id: r.value ?? "" });
    } else if (r.missing) events.push(event);
    else left.quarantine = box.quarantine;
  }
  for (const item of box.reviews) {
    const r = await attempt(REVIEW, NO_QUEUE, () => client.postReview(item));
    if (r.ok) out.reviews++;
    else if (!r.missing) left.reviews.push(item);
  }
  for (const event of [...events, ...box.events]) {
    const r = await attempt(PUBLISH, NO_RELAY, () => client.publishEvent(event));
    if (r.ok) out.events++;
    else if (!r.missing) left.events.push(event);
  }
  if (left.quarantine || left.reviews.length || left.events.length) out.unsent = left;
  return out;
}

/** "1 quarantine item, 2 review items, 3 events": what an Unsent holds, for the logs. */
export function describeUnsent(box: Unsent): string {
  const parts = [
    box.quarantine ? "1 quarantine item (and its event)" : "",
    box.reviews.length ? `${box.reviews.length} review item${box.reviews.length === 1 ? "" : "s"}` : "",
    box.events.length ? `${box.events.length} event${box.events.length === 1 ? "" : "s"}` : "",
  ];
  return parts.filter(Boolean).join(", ");
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
