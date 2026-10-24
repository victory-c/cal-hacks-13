// The worker's event handler: session.captured → fetch → GET /api/groups (once per item) →
// distill with that group list → Jev triage against the same list and every stored fact (one
// request) → POST /api/facts (facts in their groups, or in inbox), then the quarantine item when the item
// was held (POST /api/quarantine) and the relayed events (POST /api/events: triage.decided per
// draft, quarantine.flagged per held item).
// Built as a factory over an injected client/distiller/judge so worker.test.ts drives it with
// fakes and no network. Per-session queues keep corrections ordered; stale results never save.
// One bad session is logged and skipped; the loop never dies.
//
// Against a server without the scopes routes (today's: they 404) the worker says so once per
// route and keeps going. Without GET /api/groups it files every fact in inbox, which only
// moderators see: filing in a group the server never listed could put a fact where the wrong
// people see it (and today's server only lets the distiller write its old folders and inbox).
//
// A scopes route that exists but fails for a moment (a 5xx, a timeout) does not lose what it was
// given: the quarantine item and events it did not take are held and retried (with backoff, on
// the next capture, and once more on settle()), without sending the facts again.

import { createHash } from "node:crypto";

import { ROUTES, timed } from "@canon/shared";
import type { CanonEvent, CapturedSession, Fact, Group, Judge, PostQuarantineBody } from "@canon/shared";
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
   * First wait before retrying a quarantine item and events a route failed to take; doubles per
   * try, up to a minute. Default 5000.
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
  const processed = new RevisionLedger(); // last revision distilled per session; an unchanged re-send is a no-op
  const pending = new Map<string, Pending>(); // live-mode debounce, one per session id
  const inflight = new Set<Promise<void>>();
  const chains = new Map<string, Promise<void>>();
  const latestRun = new Map<string, number>(); // per session: the newest run started
  let runs = 0;
  const warnOnce = onceWarner(); // one line per missing scopes route for the worker's whole life
  const held: Held[] = []; // quarantine items and events a failing route did not take
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retrying: Promise<void> | undefined;

  const track = (p: Promise<void>): Promise<void> => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
    return p;
  };
  const run = (event: Captured) => {
    const { id } = event.session;
    const seq = ++runs;
    latestRun.set(id, seq);
    // Fetch and claim now, so an arriving correction invalidates work already running. A fetch
    // that a newer run overtook never claims: its response may land last but holds older content.
    const fetched = fetchSession(id, opts, processed, () => latestRun.get(id) === seq);
    const previous = chains.get(id) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      const next = await fetched;
      if (!next) return;
      // A newer revision claimed while this one waited in the queue: skip the model calls too.
      if (!processed.isLatest(id, next.claim)) {
        log(`session ${id}: a newer revision is queued, skipping this one`);
        return;
      }
      await processSession(next.session, next.claim, opts, processed, warnOnce, hold);
    });
    chains.set(id, job);
    return track(job.finally(() => {
      if (chains.get(id) === job) chains.delete(id);
    }));
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
        if (r.quarantined || r.events) log(`session ${id}: retry ${h.tries}: filed ${r.quarantined} quarantine items, relayed ${r.events} events`);
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

/**
 * What the distiller reads from a session, hashed: every message (role, text, time) plus the
 * principal, kind and external flag. Not the times or meta, which a re-send may restamp.
 */
export function sessionRevision(session: CapturedSession): string {
  const content = [session.messages.map((m) => [m.role, m.content, m.at ?? null]), session.principal ?? null, session.kind ?? null, session.external ?? null];
  return createHash("sha1").update(JSON.stringify(content)).digest("hex").slice(0, 12);
}

type RevisionClaim = { revision: string };

/**
 * The one revision per session that was last handed to the distiller, so an unchanged re-send is
 * a no-op and any change is distilled again. Only the latest counts, not every past one: a memo
 * imported as A, corrected to B, then restored to A distills A again, because the archive now
 * holds A while the store last saw B. claim() checks and records with no await in between, so two
 * copies of one event distill once.
 */
export class RevisionLedger {
  readonly #last = new Map<string, RevisionClaim>();

  /** A unique claim for changed content; an unchanged re-send returns undefined. */
  claim(id: string, session: CapturedSession): RevisionClaim | undefined {
    const revision = sessionRevision(session);
    if (this.#last.get(id)?.revision === revision) return undefined;
    const claim = { revision }; // Identity distinguishes A → B → A from the original A.
    this.#last.set(id, claim);
    return claim;
  }

  /**
   * A failed distill: forget it so a re-post runs again, unless a newer revision was claimed since.
   * Never puts back the one before, which may have failed too.
   */
  release(id: string, claim: RevisionClaim): void {
    if (this.isLatest(id, claim)) this.#last.delete(id);
  }

  isLatest(id: string, claim: RevisionClaim): boolean {
    return this.#last.get(id) === claim;
  }
}

async function fetchSession(id: string, opts: HandlerOptions, processed: RevisionLedger, isCurrent: () => boolean) {
  // Compare fetched content: a corrected memo usually keeps its id and message count.
  try {
    const fetched = await timed(() => opts.client.getSession(id));
    const session = fetched.result;
    if (!isCurrent()) {
      log(`session ${id}: a newer capture arrived while fetching; leaving it to that run`);
      return;
    }
    const claim = processed.claim(id, session);
    if (!claim) {
      log(`session ${id}: unchanged since it was distilled (${session.messages.length} messages), skipping`);
      return;
    }
    log(`session ${id}: fetched ${session.messages.length} messages in ${fetched.ms} ms`);

    return { session, claim };
  } catch (err) {
    warn(`session ${id}: failed, skipping: ${errorMessage(err)}`);
  }
}

async function processSession(
  session: CapturedSession,
  claim: RevisionClaim,
  opts: HandlerOptions,
  processed: RevisionLedger,
  warnOnce: WarnOnce,
  hold: (box: Unsent) => void,
): Promise<void> {
  const { id } = session;
  try {
    // The group list, once per item: the writer suggests a group from it and triage files against
    // the same list. Without one (404, failing, unusable) the writer gets none and every fact goes
    // to inbox. The writer's group is a hint in the drafts; triage still decides.
    const known = await loadGroups(opts.client, warnOnce);
    const distilled = await timed(() => opts.distiller.distill(session, { groups: known.groups }));
    const { drafts, plan, simulated } = distilled.result;
    log(`session ${id}: ${opts.distiller.name} distilled ${drafts.length} drafts in ${distilled.ms} ms${simulated ? " (simulated)" : ""}`);
    if (plan) log(`session ${id}: plan: ${plan}`);

    // Every captured item gets the injection question, drafts or not. The store only matters when
    // there is something to file.
    const ctx: TriageContext = { ...known, existing: drafts.length ? await loadFacts(opts.client) : [] };
    const triaged = await timed(() => triage({ session, drafts, ...ctx }, opts.judge));
    const result = triaged.result;
    const against = ctx.groupsKnown ? `${ctx.groups.length} groups` : "no group list";
    log(`session ${id}: ${opts.judge.name} triaged ${drafts.length} drafts against ${ctx.existing.length} facts and ${against} in ${triaged.ms} ms (${summarizeTriage(result)})`);
    if (result.quarantine) log(`session ${id}: quarantined: ${result.quarantine.item.excerpt} (${result.quarantine.summary})`);
    if (drafts.length === 0 && !result.quarantine) {
      log(`session ${id}: nothing to save`);
      return;
    }

    if (!processed.isLatest(id, claim)) {
      log(`session ${id}: newer revision recorded, dropping stale result`);
      return;
    }
    const delivered = await timed(() => deliver(opts.client, result, warnOnce));
    const d = delivered.result;
    log(
      `session ${id}: saved ${d.saved.length}, retired ${d.retired.length}, filed ${d.quarantined} quarantine items, relayed ${d.events} events in ${delivered.ms} ms${d.unsent ? `; held for retry: ${describeUnsent(d.unsent)}` : ""}`,
    );
    // The facts are saved, so the session stays processed; only what a route failed to take is retried.
    if (d.unsent) hold(d.unsent);
  } catch (err) {
    // Let a later re-post of the same session retry; do not take the loop down.
    processed.release(id, claim);
    warn(`session ${id}: failed, skipping: ${errorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Scopes context and delivery. Exported for cli.ts (--post) and the tests.

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

export interface KnownGroups {
  /** The server's groups; [] when it gave none. What the writer suggests from and triage files against. */
  groups: Group[];
  /** False unless the server gave a group list the client could use: then every fact goes to inbox. */
  groupsKnown: boolean;
}

export interface TriageContext extends KnownGroups {
  existing: Fact[];
}

const NO_GROUPS = "every fact is filed in inbox (moderators only) until the server lists its groups";

/**
 * GET /api/groups. Missing, failing or malformed degrades to no list (groupsKnown false), never a
 * failed item: client.ts throws on a body it cannot use, and that counts as no list too.
 */
export async function loadGroups(client: CanonClient, warnOnce: WarnOnce): Promise<KnownGroups> {
  const groups = await optional(() => client.getGroups(), `GET ${ROUTES.groups}`, NO_GROUPS, warnOnce);
  return { groups: groups.ok ? groups.value : [], groupsKnown: groups.ok };
}

/**
 * Every stored fact, hot and cold (an existing route, so a failure fails the item and it is
 * retried). Not only hot: a kept fact below KEEP_HOT is stored cold, and the exact-duplicate and
 * group rules must still see its group and labels, or a copy of it could be filed somewhere its
 * readers were never meant to be. Triage sets retired facts aside itself.
 */
export async function loadFacts(client: CanonClient): Promise<Fact[]> {
  return client.listFacts();
}

/** Groups and facts together, for cli.ts (--post). */
export async function loadContext(client: CanonClient, warnOnce: WarnOnce): Promise<TriageContext> {
  const [known, existing] = await Promise.all([loadGroups(client, warnOnce), loadFacts(client)]);
  return { ...known, existing };
}

export interface Delivered extends Sent {
  saved: string[];
  retired: string[];
}

type QuarantineFlagged = Extract<RelayedEvent, { type: "quarantine.flagged" }>;

/**
 * The quarantine item and events not yet filed for one triage result. Facts are never in here:
 * they go first, and once the server saved them they are not sent again.
 */
export interface Unsent {
  session_id: string;
  /** The quarantine item and its quarantine.flagged event, which waits for the id the server gives back. */
  quarantine?: { item: PostQuarantineBody; event: QuarantineFlagged };
  events: RelayedEvent[];
}

export interface Sent {
  /** Quarantine items the server accepted. */
  quarantined: number;
  /** Events the server accepted for relay. */
  events: number;
  /**
   * What a route that exists failed to take (a 5xx, a timeout, a dropped connection): kept for
   * redeliver(). A route that is missing (404/405, not built yet) is skipped, never kept.
   */
  unsent?: Unsent;
}

/**
 * Files one triage result: facts first (an existing route, so a failure here fails the session
 * and it is retried whole), then the quarantine item, then the events (redeliver()).
 */
export async function deliver(client: CanonClient, result: TriageResult, warnOnce: WarnOnce): Promise<Delivered> {
  const facts = triagedFacts(result);
  const posted = facts.length ? await client.postFacts({ facts }) : { saved: [], retired: [] };
  const sent = await redeliver(client, outbox(result), warnOnce);
  return { saved: posted.saved, retired: posted.retired, ...sent };
}

/** The quarantine item and events one triage result files, none sent yet. */
function outbox(result: TriageResult): Unsent {
  const at = new Date().toISOString();
  const box: Unsent = { session_id: result.session_id, events: [] };
  if (result.quarantine) {
    const { item } = result.quarantine;
    const event: QuarantineFlagged = { type: "quarantine.flagged", at, session_id: result.session_id, quarantine_id: "", p: item.p, excerpt: item.excerpt };
    box.quarantine = { item, event };
  }
  for (const d of result.drafts) {
    const event: RelayedEvent = { type: "triage.decided", at, session_id: result.session_id, statement: d.draft.statement, decision: d.decision };
    if (d.fact) event.fact_id = d.fact.id;
    box.events.push(event);
  }
  return box;
}

const QUARANTINE = `POST ${ROUTES.quarantine}`;
const PUBLISH = `POST ${ROUTES.publish}`;
const NO_QUARANTINE = "the quarantine item is not filed (nothing from the item is written either way)";
const NO_RELAY = "triage events are not relayed to the dashboard";

/**
 * Sends what `box` holds: the quarantine item, then its quarantine.flagged event with the id the
 * server gave back, then the events. A missing route is warned once and skipped for good
 * (quarantine_id is "" when the route is missing or names no id). A route that exists but fails
 * keeps its items, and the rest of that route's items wait behind them, in `unsent`.
 */
export async function redeliver(client: CanonClient, box: Unsent, warnOnce: WarnOnce): Promise<Sent> {
  const left: Unsent = { session_id: box.session_id, events: [] };
  const out: Sent = { quarantined: 0, events: 0 };
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
    const { item, event } = box.quarantine;
    const r = await attempt(QUARANTINE, NO_QUARANTINE, () => client.postQuarantine(item));
    if (r.ok) {
      out.quarantined++;
      events.push({ ...event, quarantine_id: r.value ?? "" });
    } else if (r.missing) events.push(event);
    else left.quarantine = box.quarantine;
  }
  for (const event of [...events, ...box.events]) {
    const r = await attempt(PUBLISH, NO_RELAY, () => client.publishEvent(event));
    if (r.ok) out.events++;
    else if (!r.missing) left.events.push(event);
  }
  if (left.quarantine || left.events.length) out.unsent = left;
  return out;
}

/** "1 quarantine item (and its event), 3 events": what an Unsent holds, for the logs. */
export function describeUnsent(box: Unsent): string {
  const parts = [box.quarantine ? "1 quarantine item (and its event)" : "", box.events.length ? `${box.events.length} event${box.events.length === 1 ? "" : "s"}` : ""];
  return parts.filter(Boolean).join(", ");
}

type Optional<T> = { ok: true; value: T } | { ok: false; missing: boolean };

async function optional<T>(fn: () => Promise<T>, route: string, consequence: string, warnOnce: WarnOnce): Promise<Optional<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (isMissingRoute(err)) {
      warnOnce(route, `server has no ${route} yet: ${consequence}`);
      return { ok: false, missing: true };
    }
    const why = errorMessage(err);
    warnOnce(`${route} ${why}`, `${route} failed: ${why}; ${consequence}`);
    return { ok: false, missing: false };
  }
}
