// The offline demo, no server and no keys needed (DISPATCH_RUNTIME=fake is the default with no keys):
//   npm run dispatch -w distiller -- --demo
//       Dan's deal analyst (deal/falcon + market/public) and Priya's research agent
//       (research/logistics + market/public) side by side, plus Priya's agent told to "include
//       everything about Falcon": it gets nothing about Falcon, because her scope has none.
//   npm run dispatch -w distiller -- --agent agt_dan_deal --agent agt_priya_research
//   npm run dispatch -w distiller -- --agent agt_mine --by priya --groups deal/falcon,market/public "<task>"
//       a new agent profile; its scope is those groups AND its creator's (simulated, by group)
//   ... --then add       after the first step, a new market/public fact joins the scopes; Jev (fake)
//                        decides which running agents need it; they get the file before their next step
//   ... --then narrow    after the first step, Maya removes deal/falcon from Dan's rule (Falcon dies):
//                        his agent's folder is discarded and the run restarts without the Falcon files
//   ... --then delete    after the first step, the first agent is deleted: its run is cancelled
//   ... --server         run an agent that exists on the live server (CANON_URL) instead
//   ... --runtime droid|claude|fake   --steps N   --list
// Every event goes through the same handler the worker uses. Prints every agent.run / agent.step /
// agent.inbox event as a lane line, then one row per run. The offline world, the fake judge, the
// template brief and the fake runtime all say "simulated"; tokens are shown only when a real
// runtime reported them.

import { AGENT_RUNTIMES, DEFAULT_SERVER_URL, FakeJudge, GROUP_RE, createJudge, env } from "@canon/shared";
import type { AgentRun, AgentRuntime, CanonEvent, Judge, Principal } from "@canon/shared";
import { createBriefWriter } from "./brief.ts";
import { createDispatchClient } from "./client.ts";
import type { DispatchClient, RelayedEvent } from "./client.ts";
import { AGENT_ID_RE, Dispatcher, maxStepsFromEnv } from "./dispatcher.ts";
import { createDispatchHandler } from "./handler.ts";
import { errorMessage } from "./log.ts";
import { DEMO_AGENTS, OfflineClient } from "./offline.ts";
import { simulatedRoutingAnswer } from "./routing.ts";
import { FakeRunner, createRunner, resolveRuntime } from "./runners/index.ts";

/** What --demo runs side by side: Dan's deal analyst, Priya's research agent, and Priya's Falcon attempt. */
const DEMO_RUN = ["agt_dan_deal", "agt_priya_research", "agt_priya_falcon"];
const THEN = ["add", "narrow", "delete"] as const;
type Then = (typeof THEN)[number];

const USAGE = [
  "usage: npm run dispatch -w distiller -- --demo [--then add|narrow|delete]",
  "       npm run dispatch -w distiller -- --agent <id> [--agent <id> ...] [--then add|narrow|delete]",
  '       npm run dispatch -w distiller -- --agent <new agt_ id> --by <person> [--groups g1,g2] "<task>"',
  "       npm run dispatch -w distiller -- --server --agent <id> [--by <person>]",
  `       options: --runtime ${AGENT_RUNTIMES.join("|")}  --steps N  --list`,
].join("\n");

export interface CliArgs {
  agents: string[];
  demo: boolean;
  list: boolean;
  by?: string;
  groups?: string[];
  task?: string;
  then?: Then;
  server: boolean;
  runtime?: AgentRuntime;
  steps?: number;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const out: CliArgs = { agents: [], demo: false, list: false, server: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value.\n${USAGE}`);
      return v;
    };
    if (a === "--agent") {
      const id = value();
      if (!AGENT_ID_RE.test(id)) throw new Error(`--agent wants an agent id like agt_dan_deal (got ${id})`);
      out.agents.push(id);
    } else if (a === "--demo") out.demo = true;
    else if (a === "--list") out.list = true;
    else if (a === "--by") out.by = value();
    else if (a === "--groups") {
      const groups = value()
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean);
      for (const g of groups) if (!GROUP_RE.test(g)) throw new Error(`--groups: "${g}" is not a group id like deal/falcon`);
      out.groups = groups;
    } else if (a === "--then") {
      const v = value();
      if (!(THEN as readonly string[]).includes(v)) throw new Error(`--then must be one of ${THEN.join("|")} (got ${v})`);
      out.then = v as Then;
    } else if (a === "--server") out.server = true;
    else if (a === "--runtime") out.runtime = resolveRuntime(value());
    else if (a === "--steps") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error("--steps must be an integer 1-20");
      out.steps = n;
    } else if (a.startsWith("--")) throw new Error(`unknown flag ${a}.\n${USAGE}`);
    else rest.push(a);
  }
  if (rest.length) out.task = rest.join(" ");
  if (out.demo) out.agents = [...new Set([...DEMO_RUN, ...out.agents])];
  return out;
}

export async function runCli(argv: string[]): Promise<number> {
  const args = parseCliArgs(argv);
  const offline = args.server ? undefined : new OfflineClient();
  if (args.list && offline) {
    printWorld(offline);
    return 0;
  }
  if (args.agents.length === 0) {
    console.error(USAGE);
    return 2;
  }
  if (args.server && args.then) throw new Error("--then works on the offline world only; on the server, a moderator edits rules in the console");
  if ((args.by || args.task || args.groups) && args.agents.length !== 1) throw new Error("--by, --groups and a task describe ONE new agent: pass exactly one --agent with them");

  // A new agent profile on the offline world: the member view's form.
  if (offline && args.agents.length === 1 && (args.by || args.task || args.groups)) {
    const id = args.agents[0];
    if (!args.by || !args.task) throw new Error(`a new agent needs --by <person> and a task.\n${USAGE}`);
    offline.addAgent({ id, created_by: args.by, groups: args.groups, task: args.task });
  }

  const client: DispatchClient =
    offline ?? createDispatchClient({ baseUrl: env("CANON_URL", DEFAULT_SERVER_URL), token: env("CANON_TOKEN_DISPATCHER", "dev-dispatcher") });
  const runtime = args.runtime ?? resolveRuntime();
  // The fake runtime pauses a little per step so the lanes read like a live run.
  const runner = runtime === "fake" ? new FakeRunner({ delayMs: 250 }) : createRunner(runtime);
  const briefWriter = createBriefWriter();
  let judge: Judge = createJudge();
  if (judge.name === "fake") judge = new FakeJudge({ override: simulatedRoutingAnswer });

  const sim = (b: boolean) => (b ? " (simulated)" : "");
  console.log(
    offline
      ? "world     offline synthetic world (simulated): Harbor Lane Partners, built from distiller/fixtures/world/ by group"
      : `world     live server ${env("CANON_URL", DEFAULT_SERVER_URL)}`,
  );
  console.log(`brief     ${briefWriter.name}${sim(briefWriter.name === "template")} · runtime ${runner.name}${sim(runner.simulated)} · routing judge ${judge.name}${sim(judge.name === "fake")}\n`);

  const labels = new Map<string, string>();
  const runs = new Map<string, AgentRun>();
  let triggered = false;
  let dispatcher!: Dispatcher;
  let handler!: ReturnType<typeof createDispatchHandler>;

  const fire = (events: CanonEvent[], what: string) => {
    console.log(`\n${pad("moderator")} ${what} (simulated)`);
    for (const e of events) {
      if (e.type === "scope.updated") console.log(`${pad("server")} scope.updated ${e.principal}: +${e.added.length} -${e.removed.length} (${e.reason})`);
      else if (e.type === "principal.changed") console.log(`${pad("server")} principal.changed ${e.principal.id}: ${e.change}`);
      void handler(e);
    }
    console.log("");
  };

  const onEvent = (e: RelayedEvent) => {
    if (e.type === "agent.run") {
      runs.set(e.run.id, e.run);
      labels.set(e.run.id, `${e.run.agent}`);
      const restarts = e.run.restarts ? ` (restart ${e.run.restarts})` : "";
      console.log(`${pad(labels.get(e.run.id)!)} run    ${e.run.state}${restarts}${e.run.reason ? `: ${e.run.reason}` : ""}${e.run.state === "queued" ? `  "${e.run.task}" for ${e.run.created_by}` : ""}`);
      // add: during the first step, so routing (one judge call) lands before the next step starts.
      // narrow and delete: once the first step is done.
      if (args.then && offline && !triggered && e.run.state === (args.then === "add" ? "running" : "waiting")) {
        triggered = true;
        if (args.then === "add") fire(offline.addLateFact(), "a new market/public fact joins the store");
        else if (args.then === "narrow") fire(offline.excludeGroup("dan", "deal/falcon"), "Maya removes deal/falcon from Dan's rule (Falcon is dead)");
        else fire(offline.deleteAgent(e.run.agent), `${e.run.created_by} deletes ${e.run.agent}`);
      }
    } else if (e.type === "agent.step") {
      const s = e.step;
      const tokens = s.tokens ? `  [tokens in/out ${s.tokens.input}/${s.tokens.output}]` : "";
      console.log(`${pad(labels.get(s.run_id) ?? s.run_id)} #${s.n} ${s.kind.padEnd(8)}${s.text}${tokens}`);
    } else if (e.type === "agent.inbox") {
      const i = e.item;
      console.log(`${pad(labels.get(i.run_id) ?? i.run_id)} inbox  ${i.urgent ? "URGENT " : ""}${i.kind}${i.delivered_at ? " (delivered)" : ""}${i.p_needs !== undefined ? ` p=${i.p_needs}` : ""}: ${i.text}`);
    }
  };

  dispatcher = new Dispatcher({ client, runner, briefWriter, maxSteps: args.steps ?? maxStepsFromEnv(), onEvent });
  handler = createDispatchHandler({ dispatcher, client, judge });

  // Each agent through the worker's own path: dispatch.requested -> rule -> scope -> sandbox.
  for (const agent of args.agents) {
    const known: Principal | undefined = offline?.principal(agent);
    if (offline && !known) throw new Error(`the offline world has no agent ${agent}; --list shows them, or create one with --by and a task`);
    await dispatcher.dispatch({ agent, by: known?.created_by ?? args.by ?? "maya" }, known);
  }
  await dispatcher.settle();
  await handler.settle();

  console.log("\nruns");
  for (const r of runs.values()) {
    const groups = offline ? countGroups(offline, dispatcher.factsOf(r.id)) : `${dispatcher.factsOf(r.id).length} fact(s)`;
    console.log(`  ${r.id}  ${pad(r.agent)} ${r.state.padEnd(9)} ${String(r.steps).padStart(2)} step(s) ${r.restarts} restart(s)  facts/: ${groups}${r.reason ? `  (${r.reason})` : ""}`);
    console.log(`  ${" ".repeat(r.id.length)}  record: ${r.sandbox}`);
  }
  if (offline) {
    for (const s of offline.sessions) console.log(`\nsaved to ${s.principal}'s memory: ${s.id} "${s.title}" (${s.messages.length - 1} file(s), simulated)`);
  }
  // A cancel or a restart is the system working, shown in the table. Only a broken runtime is an error exit.
  return [...runs.values()].some((r) => r.state === "failed" && r.reason?.startsWith(`${r.runtime} failed`)) ? 1 : 0;
}

/** "deal/falcon 6, market/public 4" for a run's folder (offline: the CLI user is the operator). */
function countGroups(offline: OfflineClient, ids: string[]): string {
  if (ids.length === 0) return "none";
  const counts = new Map<string, number>();
  for (const id of ids) {
    const g = offline.world.facts.find((f) => f.id === id)?.folder ?? "?";
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts].map(([g, n]) => `${g} ${n}`).join(", ");
}

function printWorld(offline: OfflineClient): void {
  const w = offline.world;
  console.log("offline synthetic world (simulated), built from distiller/fixtures/world/\n");
  console.log("people");
  for (const p of w.people) console.log(`  ${pad(p.principal.id)} ${p.principal.tier}  ${p.principal.tier === "moderator" ? "every group" : p.groups.join(", ")}`);
  console.log("\nagents");
  for (const a of w.agents) console.log(`  ${pad(a.principal.id)} by ${a.principal.created_by.padEnd(6)} asks for ${a.groups.join(", ")}  "${a.task}"`);
  console.log("\nfacts per group");
  for (const g of w.groups) console.log(`  ${pad(g.id)} ${w.facts.filter((f) => f.folder === g.id).length}`);
  console.log(`\nquarantined sessions (no facts): ${w.quarantined.join(", ")}`);
  console.log(`--demo runs: ${DEMO_RUN.join(", ")} (built in: ${DEMO_AGENTS.map((a) => a.id).join(", ")})`);
}

function pad(s: string): string {
  return s.padEnd(20);
}

export function cliErrorMessage(err: unknown): string {
  return `[dispatch] ${errorMessage(err)}`;
}
