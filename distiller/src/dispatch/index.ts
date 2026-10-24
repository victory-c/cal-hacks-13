// Dispatcher entrypoint (`npm run dispatch -w distiller`). With no arguments it is the worker: it
// subscribes to the server's /events as the internal `dispatcher` client, starts agent runs on
// dispatch.requested and routes fact.saved / deal.status_changed / entitlement.changed to the
// running agents' inboxes. With arguments it is the offline CLI (see cli.ts):
//   npm run dispatch -w distiller -- --by dan "Prep Falcon board materials and update our logistics sector note"

import { DEFAULT_SERVER_URL, FakeJudge, ROUTES, createJudge, env, loadEnv } from "@canon/shared";
import type { Judge } from "@canon/shared";
import { createBriefWriter } from "./brief.ts";
import { cliErrorMessage, runCli } from "./cli.ts";
import { createDispatchClient, subscribe } from "./client.ts";
import { Dispatcher } from "./dispatcher.ts";
import { createDispatchHandler } from "./handler.ts";
import { errorMessage, log, warn } from "./log.ts";
import { createPlanner } from "./plan.ts";
import { simulatedRoutingAnswer } from "./routing.ts";
import { createRunner, resolveRuntime } from "./runners/index.ts";

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
    // The fake judge's keyword rule would cancel every agent on any "decided" fact; routing
    // brings its own simulated answers (word overlap, explicit stop words).
    if (judge.name === "fake") judge = new FakeJudge({ override: simulatedRoutingAnswer });
    const client = createDispatchClient({ baseUrl, token });
    const dispatcher = new Dispatcher({ client, runner, planner: createPlanner(), briefWriter: createBriefWriter() });
    const handler = createDispatchHandler({ dispatcher, client, judge });

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
