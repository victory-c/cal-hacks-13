// A fake Canon for the HTTP client tests: replaces global fetch with a route table, records every
// request, and serves /events as a stream the test pushes SSE frames into. Test-only helper.

import type { TestContext } from "node:test";

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
}

type Reply = unknown | ((req: Recorded) => unknown);

export interface FakeCanon {
  calls: Recorded[];
  /** Pushes one SSE frame onto the open /events stream. */
  push(type: string, data: unknown): void;
  /** Lets queued fetches and async event handlers settle. */
  settle(ms?: number): Promise<void>;
  close(): void;
}

/** A reply that is a Response is sent as is; anything else is JSON with status 200. */
export function fakeCanon(t: TestContext, routes: Record<string, Reply>): FakeCanon {
  const calls: Recorded[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const req: Recorded = {
      method: init.method ?? "GET",
      path,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      headers: { ...(init.headers as Record<string, string> | undefined) },
      credentials: init.credentials,
    };
    if (path === "/events") return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    calls.push(req);
    const key = `${req.method} ${path}`;
    if (!(key in routes)) return Response.json({ error: `no route for ${key}` }, { status: 404 });
    const reply = routes[key];
    const value = typeof reply === "function" ? (reply as (r: Recorded) => unknown)(req) : reply;
    return value instanceof Response ? value : Response.json(value);
  });
  return {
    calls,
    push(type, data) { controller?.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)); },
    settle: (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms)),
    close() { try { controller?.close(); } catch { /* already closed */ } },
  };
}
