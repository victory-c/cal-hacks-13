// The worker's event handler: session.captured → fetch → distill → Jev decides → POST /api/facts.
// Built as a factory over an injected client/distiller/judge so worker.test.ts drives it with
// fakes and no network. One bad session is logged and skipped; the loop never dies.

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
  const processed = new Set<string>(); // "<id>:<revision>" keys; an unchanged re-send is a no-op
  const pending = new Map<string, Pending>(); // live-mode debounce, one per session id
  const inflight = new Set<Promise<void>>();

  const track = (p: Promise<void>): Promise<void> => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
    return p;
  };
  const run = (event: Captured) => track(processSession(event, opts, processed));

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

async function processSession(event: Captured, opts: HandlerOptions, processed: Set<string>): Promise<void> {
  const { id } = event.session;
  // Keyed by the fetched content, not the event's message count: a re-imported memo keeps its id
  // and usually its one message, so a corrected file must still be distilled again. The check and
  // the add run with no await between them, so two copies of one event distill once.
  let key: string | undefined;
  try {
    const fetched = await timed(() => opts.client.getSession(id));
    const session = fetched.result;
    key = `${id}:${sessionRevision(session)}`;
    if (processed.has(key)) {
      log(`session ${id}: unchanged since it was distilled (${session.messages.length} messages), skipping`);
      return;
    }
    processed.add(key);
    log(`session ${id}: fetched ${session.messages.length} messages in ${fetched.ms} ms`);

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

    const posted = await timed(() => opts.client.postFacts({ facts: decided.result }));
    log(`session ${id}: saved ${posted.result.saved.length}, retired ${posted.result.retired.length} in ${posted.ms} ms`);
  } catch (err) {
    // Let a later re-post of the same session retry; do not take the loop down.
    if (key) processed.delete(key);
    warn(`session ${id}: failed, skipping: ${errorMessage(err)}`);
  }
}

function summarize(decisions: Array<{ tier: string; folder: string; action: string }>): string {
  const hot = decisions.filter((d) => d.tier === "hot").length;
  const inbox = decisions.filter((d) => d.folder === "inbox").length;
  const retire = decisions.filter((d) => d.action !== "add").length;
  return `${hot} hot, ${decisions.length - hot} cold, ${inbox} inbox, ${retire} merge/supersede`;
}
