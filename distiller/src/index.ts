// Distiller worker entrypoint. Subscribes to the server's SSE stream and hands every event to
// the handler in worker.ts. Start it with `npm run dev -w distiller` (or `npm run dev` at the root).

import { DEFAULT_SERVER_URL, ROUTES, createJudge, env, loadEnv, subscribeEvents } from "@canon/shared";
import { createClient } from "./client.ts";
import { createDistiller } from "./engines/index.ts";
import { errorMessage, log, warn } from "./log.ts";
import { triageJudge } from "./triage.ts";
import { createHandler } from "./worker.ts";

loadEnv();

const url = env("CANON_URL", DEFAULT_SERVER_URL);
const live = env("DISTILL_LIVE") === "1";
let token = env("CANON_TOKEN_DISTILLER");
if (!token) {
  // A dev value, not a secret (see .env.example). It must match the server's distiller= pair.
  token = "dev-distiller";
  warn("CANON_TOKEN_DISTILLER is not set; using the dev default from .env.example");
}

let distiller, judge;
try {
  distiller = createDistiller();
  // With no keys the judge is the fake; triage swaps in its finance rules (still simulated).
  judge = triageJudge(createJudge());
} catch (err) {
  console.error(`[distiller] cannot start: ${errorMessage(err)}`);
  process.exit(1);
}

const client = createClient({ baseUrl: url, token });
const handler = createHandler({ client, distiller, judge, live });

log(`distiller worker: engine ${distiller.name}, judge ${judge.name}${judge.name === "fake" ? " (simulated)" : ""}, v2 triage, listening on ${url}${ROUTES.events}${live ? " (DISTILL_LIVE=1)" : ""}`);

const stop = subscribeEvents(url + ROUTES.events, (event) => void handler(event), {
  headers: { authorization: `Bearer ${token}` },
  onOpen: () => log(`connected to ${url}${ROUTES.events}`),
  onError: (err) => warn(`event stream: ${errorMessage(err)}; reconnecting`),
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping, finishing in-flight sessions`);
  stop();
  await handler.settle();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
