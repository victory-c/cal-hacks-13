// Entrypoint: `npm run dev -w server` (watch) or `npm start -w server`.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_PORTS, dataDir, env, loadEnv } from "@canon/shared";

import { startServer } from "./app.ts";
import type { RunningServer } from "./app.ts";
import { seedDataDir } from "./seed.ts";

loadEnv();

// One bad promise (a request handler, a judge call) must never take the whole server down.
process.on("unhandledRejection", (err) => console.error("[server] unhandled rejection:", err));

function fail(message: string): never {
  console.error(`[server] ${message}`);
  process.exit(1);
}

const port = Number(env("CANON_PORT", String(DEFAULT_PORTS.server)));
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`CANON_PORT must be a port number 0–65535 (got "${env("CANON_PORT")}")`);

/** A fresh clone has no data dir; the demo needs facts, so an empty store gets the fixtures. */
async function seedIfEmpty(dir: string): Promise<void> {
  let hasFacts = false;
  try {
    hasFacts = (await readdir(join(dir, "facts"), { recursive: true })).some((n) => n.endsWith(".md"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (hasFacts) return;
  const r = await seedDataDir(dir);
  console.info(`[server] no facts in ${dir}; seeded ${r.facts} facts + ${r.sessions} sessions from server/fixtures/`);
}

/** Startup failures are one line each, not a stack trace: at 4 AM the message has to say what to do. */
async function start(): Promise<RunningServer> {
  try {
    await seedIfEmpty(dataDir());
    return await startServer({ port, host: "127.0.0.1" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      return fail(`port ${port} is already in use. Stop the other process (lsof -i :${port}) or set CANON_PORT in .env.`);
    }
    return fail(`cannot start: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const running = await start();
const { facts, sessions } = running.store.counts();
running.bus.emit({ type: "server.started", facts, sessions });

const clients = [...new Set(running.tokens.values())].sort();
console.info(`[server] listening on ${running.url}`);
console.info(`[server] data dir   ${running.dataDir}  (${facts} facts, ${sessions} sessions)`);
console.info(`[server] judge      ${running.judge.name}${running.judge.name === "fake" ? " (simulated)" : ""}`);
console.info(`[server] retriever  ${running.retriever.name}${running.retriever.name === "keyword" ? " (stub)" : ""}`);
console.info(`[server] clients    ${clients.join(", ")}`);
console.info(`[server] MCP at ${running.url}/mcp · SSE at ${running.url}/events · health at ${running.url}/health`);

const shutdown = (signal: string) => {
  console.info(`[server] ${signal}, shutting down`);
  running.close().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
