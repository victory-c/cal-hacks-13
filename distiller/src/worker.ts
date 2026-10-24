// The worker's event handler: session.captured → fetch → distill → Jev decides → POST /api/facts.
// Built as a factory over an injected client/distiller/judge so worker.test.ts drives it with
// fakes and no network. Per-session queues keep corrections ordered; stale results never save.
// One bad session is logged and skipped; the loop never dies.

import { createHash } from "node:crypto";

import { timed } from "@canon/shared";
import type { CanonEvent, CapturedSession, Judge } from "@canon/shared";
import type { CanonClient } from "./client.ts";
import { decideFacts } from "./decide.ts";
import type { Distiller } from "./engines/index.ts";
import { errorMessage, log, warn } from "./log.ts";

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
  const processed = new RevisionLedger(); // last revision distilled per session; an unchanged re-send is a no-op
  const pending = new Map<string, Pending>(); // live-mode debounce, one per session id
  const inflight = new Set<Promise<void>>();
  const chains = new Map<string, Promise<void>>();
  const latestRun = new Map<string, number>(); // per session: the newest run started
  let runs = 0;

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
      if (next) await processSession(next.session, next.claim, opts, processed);
    });
    chains.set(id, job);
    return track(job.finally(() => {
      if (chains.get(id) === job) chains.delete(id);
    }));
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

async function processSession(session: CapturedSession, claim: RevisionClaim, opts: HandlerOptions, processed: RevisionLedger): Promise<void> {
  const { id } = session;
  try {
    const distilled = await timed(() => opts.distiller.distill(session));
    const { drafts, plan, simulated } = distilled.result;
    log(`session ${id}: ${opts.distiller.name} distilled ${drafts.length} drafts in ${distilled.ms} ms${simulated ? " (simulated)" : ""}`);
    if (plan) log(`session ${id}: plan: ${plan}`);
    if (drafts.length === 0) {
      log(`session ${id}: nothing to save`);
      return;
    }

    const hot = await timed(() => opts.client.listFacts({ tier: "hot" }));
    const decided = await timed(() => decideFacts(drafts, hot.result, opts.judge));
    const counts = summarize(decided.result.map((d) => d.decision));
    log(`session ${id}: ${opts.judge.name} judged ${drafts.length} drafts against ${hot.result.length} hot facts in ${decided.ms} ms (${counts})`);

    if (!processed.isLatest(id, claim)) {
      log(`session ${id}: newer revision recorded, dropping stale result`);
      return;
    }
    const posted = await timed(() => opts.client.postFacts({ facts: decided.result }));
    log(`session ${id}: saved ${posted.result.saved.length}, retired ${posted.result.retired.length} in ${posted.ms} ms`);
  } catch (err) {
    // Let a later re-post of the same session retry; do not take the loop down.
    processed.release(id, claim);
    warn(`session ${id}: failed, skipping: ${errorMessage(err)}`);
  }
}

function summarize(decisions: Array<{ tier: string; folder: string; action: string }>): string {
  const hot = decisions.filter((d) => d.tier === "hot").length;
  const inbox = decisions.filter((d) => d.folder === "inbox").length;
  const retire = decisions.filter((d) => d.action !== "add").length;
  return `${hot} hot, ${decisions.length - hot} cold, ${inbox} inbox, ${retire} merge/supersede`;
}
