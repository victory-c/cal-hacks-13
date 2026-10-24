// Helpers for *.test.ts only (mirrors shared/src/test-helpers.ts, which the package does not export).

import { createServer } from "node:http";
import type { IncomingMessage, RequestListener, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CapturedSession, Fact } from "@canon/shared";

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

/** Silences console.info/warn while `fn` runs and returns what was logged. */
export async function quiet<T>(fn: () => Promise<T> | T): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const info = console.info;
  const warn = console.warn;
  console.info = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.info = info;
    console.warn = warn;
  }
}

export function loadFixture(): CapturedSession {
  const path = fileURLToPath(new URL("../fixtures/session.sample.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as CapturedSession;
}

export function fakeFact(id: string, statement: string, extra: Partial<Fact> = {}): Fact {
  return {
    id,
    statement,
    folder: "projects",
    tier: "hot",
    jev_keep: 0.9,
    source: { client: "claude-code", session: "ses_00000001" },
    updated: "2026-10-24",
    ...extra,
  };
}
