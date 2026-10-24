// The offline demo, no server and no keys needed:
//   npm run dispatch -w distiller -- --by dan "Prep Falcon board materials and update our logistics sector note"
//   ... --then terminate    after the first step, Project Falcon dies: the deal agent is cancelled, its folder locked
//   ... --then announce     after the first step, Falcon is announced: the research agent's next slice gets the lifted facts
//   ... --server            use the live server at CANON_URL (v2 routes) instead of the offline world
//   ... --runtime droid|claude|fake   --steps N
// Prints every agent.run / agent.step / agent.inbox event as a lane line, then one row per run.
// The offline world, the heuristic planner, the template brief and the fake runtime all say
// "simulated"; tokens are shown only when a real runtime reported them.

import { AGENT_RUNTIMES, DEFAULT_SERVER_URL, DEAL_STATUSES, env } from "@canon/shared";
import type { AgentRun, AgentRuntime, DealStatus } from "@canon/shared";
import { createBriefWriter } from "./brief.ts";
import { createDispatchClient } from "./client.ts";
import type { DispatchClient, RelayedEvent } from "./client.ts";
import { Dispatcher, maxStepsFromEnv } from "./dispatcher.ts";
import { errorMessage } from "./log.ts";
import { OfflineClient } from "./offline.ts";
import { createPlanner } from "./plan.ts";
import { routeDealStatus } from "./routing.ts";
import { FakeRunner, createRunner, resolveRuntime } from "./runners/index.ts";

const USAGE = `usage: npm run dispatch -w distiller -- --by <person> "<task>" [--then announce|terminate] [--deal deal_falcon] [--server] [--runtime ${AGENT_RUNTIMES.join("|")}] [--steps N]`;

interface CliArgs {
  by?: string;
  task?: string;
  then?: DealStatus;
  deal: string;
  server: boolean;
  runtime?: AgentRuntime;
  steps?: number;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const out: CliArgs = { deal: "deal_falcon", server: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value. ${USAGE}`);
      return v;
    };
    if (a === "--by") out.by = value();
    else if (a === "--then") {
      const v = value();
      const to = v === "announce" ? "announced" : v === "terminate" ? "terminated" : v;
      if (!(DEAL_STATUSES as readonly string[]).includes(to)) throw new Error(`--then must be announce or terminate (got ${v})`);
      out.then = to as DealStatus;
    } else if (a === "--deal") out.deal = value();
    else if (a === "--server") out.server = true;
    else if (a === "--runtime") out.runtime = resolveRuntime(value());
    else if (a === "--steps") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error("--steps must be an integer 1-20");
      out.steps = n;
    } else if (a.startsWith("--")) throw new Error(`unknown flag ${a}. ${USAGE}`);
    else rest.push(a);
  }
  if (rest.length) out.task = rest.join(" ");
  return out;
}

export async function runCli(argv: string[]): Promise<number> {
  const args = parseCliArgs(argv);
  if (!args.by || !args.task) {
    console.error(USAGE);
    return 2;
  }
  if (args.server && args.then) throw new Error("--then works on the offline world only; on the server, compliance changes deal status (POST /api/deals/:id/status)");

  const offline = args.server ? undefined : new OfflineClient();
  const client: DispatchClient =
    offline ?? createDispatchClient({ baseUrl: env("CANON_URL", DEFAULT_SERVER_URL), token: env("CANON_TOKEN_DISPATCHER", "dev-dispatcher") });
  const runtime = args.runtime ?? resolveRuntime();
  // The fake runtime pauses a little per step so the lanes read like a live run.
  const runner = runtime === "fake" ? new FakeRunner({ delayMs: 250 }) : createRunner(runtime);
  const planner = createPlanner();
  const briefWriter = createBriefWriter();

  const sim = (b: boolean) => (b ? " (simulated)" : "");
  console.log(offline ? "world     offline synthetic world (simulated): Harbor Lane Partners, Project Falcon confidential, dan cleared" : `world     live server ${env("CANON_URL", DEFAULT_SERVER_URL)}`);
  console.log(`planner   ${planner.name}${sim(planner.simulated)} · brief ${briefWriter.name}${sim(briefWriter.name === "template")} · runtime ${runner.name}${sim(runner.simulated)}`);
  console.log(`request   ${args.by}: "${args.task}"\n`);

  const labels = new Map<string, string>();
  const runs = new Map<string, AgentRun>();
  let triggered = false;
  let dispatcher!: Dispatcher;

  const onEvent = (e: RelayedEvent) => {
    if (e.type === "agent.run") {
      runs.set(e.run.id, e.run);
      labels.set(e.run.id, `${e.run.agent}@${e.run.side}`);
      console.log(`${pad(labels.get(e.run.id)!)} run    ${e.run.state}${e.run.reason ? `: ${e.run.reason}` : ""}${e.run.state === "queued" ? `  "${e.run.task}"` : ""}`);
      if (args.then && offline && !triggered && e.run.state === "waiting") {
        triggered = true;
        const change = offline.setDealStatus(args.deal, args.then);
        console.log(`\n${pad("compliance")} deal   ${change.deal}: ${change.from} -> ${change.to} (simulated button press)\n`);
        dispatcher.deliver(routeDealStatus(change, dispatcher.routable(), offline.world));
      }
    } else if (e.type === "agent.step") {
      const s = e.step;
      const tokens = s.tokens ? `  [tokens in/out ${s.tokens.input}/${s.tokens.output}]` : "";
      console.log(`${pad(labels.get(s.run_id) ?? s.run_id)} #${s.n} ${s.kind.padEnd(8)}${s.text}${tokens}`);
    } else if (e.type === "agent.inbox") {
      const i = e.item;
      console.log(`${pad(labels.get(i.run_id) ?? i.run_id)} inbox  ${i.urgent ? "URGENT " : ""}${i.kind}${i.delivered_at ? " (delivered)" : ""}: ${i.text}`);
    }
  };

  dispatcher = new Dispatcher({ client, runner, planner, briefWriter, maxSteps: args.steps ?? maxStepsFromEnv(), onEvent });
  await dispatcher.dispatch({ by: args.by, task: args.task });
  await dispatcher.settle();

  console.log("\nruns");
  for (const r of runs.values()) {
    console.log(`  ${r.id}  ${pad(`${r.agent}@${r.side}`)} ${r.state.padEnd(9)} ${String(r.steps).padStart(2)} step(s)  ${r.sandbox}${r.reason ? `  (${r.reason})` : ""}`);
  }
  if (offline) {
    const blocked = offline.exitChecks.filter((x) => x.result.blocked);
    console.log(`\nexit checks: ${offline.exitChecks.length} run, ${blocked.length} blocked (simulated, code-only)`);
  }
  // A held output or a refusal is the walls working, shown in the table. Only a broken runtime is an error exit.
  return [...runs.values()].some((r) => r.state === "failed" && r.reason?.startsWith(`${r.runtime} failed`)) ? 1 : 0;
}

function pad(s: string): string {
  return s.padEnd(26);
}

export function cliErrorMessage(err: unknown): string {
  return `[dispatch] ${errorMessage(err)}`;
}
