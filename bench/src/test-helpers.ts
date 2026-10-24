// Helpers for *.test.ts only. Local HTTP on port 0, env scoping, warning capture. Same shape as
// shared/src/test-helpers.ts, which is not exported from the package on purpose.

import { createServer } from "node:http";
import type { IncomingMessage, RequestListener, Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Local HTTP server on a free port. Always `await close()` so the test runner can exit. */
export async function serve(handler: RequestListener): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** Sets env vars for the duration of `fn` (undefined deletes), then restores them exactly. */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Captures console.warn lines emitted while `fn` runs. */
export async function captureWarnings<T>(fn: () => Promise<T> | T): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

/** A fetch stand-in that answers from a queue and records every call. */
export function fakeFetch(replies: Array<(req: { url: string; init: RequestInit }) => Response>): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit; body: unknown }> } {
  const calls: Array<{ url: string; init: RequestInit; body: unknown }> = [];
  const queue = [...replies];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init.body === "string" ? safeJson(init.body) : undefined;
    calls.push({ url, init, body });
    const next = queue.shift();
    if (!next) throw new Error(`fakeFetch: unexpected request #${calls.length} ${init.method ?? "GET"} ${url}`);
    return next({ url, init });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
