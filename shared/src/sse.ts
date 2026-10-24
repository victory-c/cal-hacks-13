// Dependency-free Server-Sent Events: a Node client (fetch + ReadableStream) that reconnects,
// plus the server-side formatter. The dashboard, the distiller worker and the bench runner all
// read GET /events through subscribeEvents(); the server writes with formatSseEvent().

import type { CanonEvent } from "./types/events.ts";

export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}

export interface SubscribeOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  onOpen?: () => void;
  /** Called on every failure (HTTP error, dropped stream, non-JSON event). The client keeps going. */
  onError?: (err: unknown) => void;
  /** First reconnect delay; doubles per failed attempt up to 10 s. Default 1000. */
  retryMs?: number;
  /**
   * Reconnect when no bytes arrive for this long. The server's `: ping` heartbeat every 15 s
   * counts, so a healthy idle stream never trips it; a silently dead TCP connection (laptop
   * sleep, SIGKILL, wifi flip) does. Default 45_000 (3x the heartbeat).
   */
  idleMs?: number;
}

const MAX_RETRY_MS = 10_000;
const DEFAULT_IDLE_MS = 45_000;

/** Server side: one event as wire text. `JSON.stringify` has no raw newlines, so one data line. */
export function formatSseEvent(e: CanonEvent, id?: string): string {
  const head = id === undefined ? "" : `id: ${id}\n`;
  return `${head}event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}

/**
 * Parses complete events out of `buffer` and returns what is left unconsumed (a partial line, or
 * field lines of an event whose blank terminator has not arrived). Feed the rest back in with
 * the next chunk. Stateless, so chunk boundaries anywhere are fine.
 */
export function parseSseChunk(buffer: string): { events: SseMessage[]; rest: string } {
  const events: SseMessage[] = [];
  let consumed = 0;
  let pos = 0;
  let event: string | undefined;
  let id: string | undefined;
  let data: string[] = [];

  for (;;) {
    const nl = buffer.indexOf("\n", pos);
    if (nl < 0) break;
    let line = buffer.slice(pos, nl);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    pos = nl + 1;

    if (line === "") {
      // Blank line dispatches. Per the spec, no data lines means nothing to dispatch.
      if (data.length > 0) {
        const msg: SseMessage = { data: data.join("\n") };
        if (event !== undefined) msg.event = event;
        if (id !== undefined) msg.id = id;
        events.push(msg);
      }
      event = undefined;
      id = undefined;
      data = [];
      consumed = pos;
      continue;
    }
    if (line.startsWith(":")) continue; // comment / keep-alive

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        data.push(value);
        break;
      case "id":
        if (!value.includes("\0")) id = value;
        break;
      default:
        break; // "retry" and unknown fields are ignored
    }
  }
  return { events, rest: buffer.slice(consumed) };
}

/**
 * Connects to an SSE endpoint and calls `onEvent` for every JSON event. Reconnects with backoff
 * (on HTTP errors, a closed stream, or `idleMs` without bytes) until the returned unsubscribe()
 * is called or `opts.signal` aborts. Never throws.
 */
export function subscribeEvents(url: string, onEvent: (e: CanonEvent) => void, opts: SubscribeOptions = {}): () => void {
  const controller = new AbortController();
  const baseRetry = opts.retryMs ?? 1000;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  let stopped = false;
  let attempt = 0;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
  };
  if (opts.signal?.aborted) stop();
  else opts.signal?.addEventListener("abort", stop, { once: true });

  const report = (err: unknown) => {
    if (!stopped) opts.onError?.(err);
  };

  const deliver = (msg: SseMessage) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.data);
    } catch {
      report(new Error(`SSE event "${msg.event ?? "message"}" is not JSON: ${msg.data.slice(0, 120)}`));
      return;
    }
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") {
      report(new Error(`SSE event has no "type" field: ${msg.data.slice(0, 120)}`));
      return;
    }
    try {
      onEvent(parsed as CanonEvent);
    } catch (err) {
      report(err); // a bad handler must not tear down the connection
    }
  };

  /** One read with a deadline. Heartbeat comment lines are bytes too, so they reset it. */
  const readOrIdle = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`SSE ${url}: idle for ${idleMs} ms`)), idleMs);
    });
    try {
      return await Promise.race([reader.read(), idle]);
    } catch (err) {
      await reader.cancel().catch(() => {}); // frees the dead socket; the abandoned read resolves done
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  const connectOnce = async (): Promise<void> => {
    const res = await fetch(url, {
      headers: { accept: "text/event-stream", ...opts.headers },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`SSE ${url}: HTTP ${res.status}`);
    if (!res.body) throw new Error(`SSE ${url}: response has no body`);
    attempt = 0;
    opts.onOpen?.();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await readOrIdle(reader);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseChunk(buffer);
      buffer = rest;
      for (const msg of events) deliver(msg);
    }
    throw new Error(`SSE ${url}: stream closed by server`);
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      controller.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });

  void (async () => {
    while (!stopped) {
      try {
        await connectOnce();
      } catch (err) {
        if (stopped) break;
        report(err);
        attempt++;
        await sleep(Math.min(baseRetry * 2 ** (attempt - 1), MAX_RETRY_MS));
      }
    }
  })();

  return stop;
}
