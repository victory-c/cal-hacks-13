// EventBus: the in-process source of the SSE stream (task A5). Everything the dashboard, the
// distiller worker and the bench runner see goes through emit(). A ring buffer of the last
// EVENT_REPLAY_LIMIT events is replayed to each new subscriber, so a dashboard opened late
// still shows what happened.

import type { ServerResponse } from "node:http";

import { EVENT_REPLAY_LIMIT, formatSseEvent, nowIso } from "@canon/shared";
import type { CanonEvent } from "@canon/shared";

/** A CanonEvent whose `at` may be left out; emit() stamps it. */
export type EventInput = CanonEvent extends infer E ? (E extends { at: string } ? Omit<E, "at"> & { at?: string } : never) : never;

type Listener = (e: CanonEvent) => void;
/** True when a subscriber may see this event, false when not, or a redacted copy to send instead. */
export type EventFilter = (e: CanonEvent) => boolean | CanonEvent;

function viewOf(filter: EventFilter, e: CanonEvent): CanonEvent | undefined {
  const v = filter(e);
  return v === true ? e : v === false ? undefined : v;
}

const HEARTBEAT_MS = 15_000;

export class EventBus {
  private readonly ring: Array<{ id: number; event: CanonEvent }> = [];
  private readonly listeners = new Set<Listener>();
  private seq = 0;
  private delivering = false;
  private readonly pending: CanonEvent[] = [];

  constructor(private readonly limit: number = EVENT_REPLAY_LIMIT) {}

  emit(input: EventInput): CanonEvent {
    const event = structuredClone({ ...input, at: input.at ?? nowIso(), event_id: ++this.seq }) as CanonEvent;
    this.ring.push({ id: this.seq, event });
    if (this.ring.length > this.limit) this.ring.shift();
    this.pending.push(event);
    if (!this.delivering) {
      this.delivering = true;
      try { while (this.pending.length) {
        const next = this.pending.shift()!;
        for (const fn of this.listeners) { try { fn(next); } catch (err) { console.warn(`[events] listener threw on ${next.type}: ${String(err)}`); } }
      } } finally { this.delivering = false; }
    }
    return event;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Oldest first. */
  replay(): CanonEvent[] {
    return this.ring.map((r) => r.event);
  }

  get size(): number {
    return this.ring.length;
  }

  /** Writes one SSE frame per entry with the ring id as the SSE id. */
  private writeReplay(res: ServerResponse, filter: EventFilter): void {
    for (const r of this.ring) {
      const v = viewOf(filter, r.event);
      if (v) res.write(formatSseEvent(v, String(r.id)));
    }
  }

  /**
   * Turns `res` into an SSE stream: replay, then live events, with a comment heartbeat every 15 s
   * so proxies and browsers keep the connection open. Cleans up when the client goes away.
   * `filter` drops events this subscriber may not see, or returns a redacted copy to send instead
   * (the router passes one for tokenless callers and strips plans for everyone but the distiller); ids keep their ring positions, so Last-Event-ID still lines up.
   */
  attachSse(res: ServerResponse, filter: EventFilter = () => true): () => void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(": canon events\n\n");
    this.writeReplay(res, filter);
    // Live events after the replay carry the same monotonically increasing id.
    const unsubscribe = this.subscribe((e) => {
      const v = viewOf(filter, e);
      if (v) res.write(formatSseEvent(v, String(e.event_id)));
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    heartbeat.unref();
    const stop = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    res.on("close", stop);
    return stop;
  }
}

/** Convenience for the router. */
export function attachSse(res: ServerResponse, bus: EventBus, filter?: EventFilter): () => void {
  return bus.attachSse(res, filter);
}
