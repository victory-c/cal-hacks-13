// Dispatcher entrypoint (`npm run dispatch -w distiller`). With no arguments it is the worker: it
// subscribes to the server's /events as the internal `dispatcher` client, runs an agent on
// dispatch.requested, and routes scope.updated (new facts, narrowed scopes) and principal.changed
// (an agent deleted) to the running agents' inboxes. With arguments it is the offline CLI (see
// cli.ts):
//   npm run dispatch -w distiller -- --demo

import { join } from "node:path";

import { DEFAULT_SERVER_URL, FakeJudge, ROUTES, createJudge, env, loadEnv } from "@canon/shared";
import type { Judge } from "@canon/shared";
import { createBriefWriter } from "./brief.ts";
import { cliErrorMessage, runCli } from "./cli.ts";
import { createDispatchClient, subscribe } from "./client.ts";
import { Dispatcher } from "./dispatcher.ts";
import { createDispatchHandler, fileLedger } from "./handler.ts";
import { errorMessage, log, warn } from "./log.ts";
import { simulatedRoutingAnswer } from "./routing.ts";
import { createRunner, resolveRuntime } from "./runners/index.ts";
import { recordsRoot } from "./sandbox.ts";

loadEnv();
const argv = process.argv.slice(2);

if (argv.length > 0) {
  runCli(argv).then(
    (code) => process.exit(code),
    (err) => {
      console.error(cliErrorMessage(err));
      process.exit(1);
    },
  );
} else {
  startWorker();
}

function startWorker(): void {
  const baseUrl = env("CANON_URL", DEFAULT_SERVER_URL);
  let token = env("CANON_TOKEN_DISPATCHER");
  if (!token) {
    // A dev value, not a secret (see .env.example). It must match the server's dispatcher= pair.
    token = "dev-dispatcher";
    warn("CANON_TOKEN_DISPATCHER is not set; using the dev default from .env.example");
  }

  try {
    const runtime = resolveRuntime();
    const runner = createRunner(runtime);
    log(`runtime: ${runtime}${runner.simulated ? " (simulated)" : ""}`);
    let judge: Judge = createJudge();
    // Offline, routing brings its own simulated answers (word overlap between a fact and a task).
    if (judge.name === "fake") judge = new FakeJudge({ override: simulatedRoutingAnswer });
    const client = createDispatchClient({ baseUrl, token });
    const dispatcher = new Dispatcher({ client, runner, briefWriter: createBriefWriter() });
    // The request ids this worker ran, next to the runs' records: a restart inside the replay
    // grace does not run a request again.
    const handler = createDispatchHandler({ dispatcher, client, judge, ledger: fileLedger(join(recordsRoot(), "dispatched.log")) });

    log(`dispatcher worker: runtime ${runner.name}, judge ${judge.name}, listening on ${baseUrl}${ROUTES.events}`);
    const stop = subscribe({ baseUrl, token }, (event) => void handler(event), {
      onOpen: () => log(`connected to ${baseUrl}${ROUTES.events}`),
      onError: (err) => warn(`event stream: ${errorMessage(err)}; reconnecting`),
    });

    let stopping = false;
    const shutdown = async (signal: string) => {
      if (stopping) return;
      stopping = true;
      log(`${signal}: stopping; cancelling running agents and locking their folders`);
      stop();
      await handler.settle();
      for (const run of dispatcher.list()) dispatcher.cancel(run.id, "The dispatcher was stopped.");
      await dispatcher.settle();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (err) {
    console.error(`[dispatch] cannot start: ${errorMessage(err)}`);
    process.exit(1);
  }
}
