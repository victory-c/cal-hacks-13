// Bench CLI. For every task × baseline: prepare → respond → score, then write results.
//
//   npm run run -w bench -- [--dry] [--baseline name]... [--task id]... [--include-example]
//                           [--allow-simulated] [--out dir]
//
// Numbers only ever come from a run of this file. Without ANTHROPIC_API_KEY, or with --dry, the
// responder is an echo stub: the run is labelled SIMULATED, accuracy and token usage are null, and
// latest.json / chart.json are not written (pass --allow-simulated to write them, labelled).

import { basename } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { DEFAULT_SERVER_URL, env, loadEnv, nowIso } from "@canon/shared";

import { BASELINE_NAMES, createBaseline, isBaselineName } from "./baselines/index.ts";
import type { Baseline, BaselineName } from "./baselines/index.ts";
import { ClaudeResponder, EchoResponder } from "./responder.ts";
import type { Responder } from "./responder.ts";
import { fileStamp, readPrices, summarize, writeRaw, writeResults } from "./results.ts";
import type { Cell, RawEntry, Summary } from "./results.ts";
import { score } from "./score.ts";
import { loadTasks } from "./tasks.ts";
import type { BenchTask } from "./types.ts";

loadEnv();

const DEFAULT_OUT = fileURLToPath(new URL("../results/", import.meta.url));

const USAGE = `Canon benchmark runner

  npm run run -w bench -- [options]

  --dry                Echo responder, no model call. Whole run is SIMULATED.
  --baseline <name>    Run only this baseline (repeatable): ${BASELINE_NAMES.join(" | ")}
  --task <id>          Run only this task id (repeatable), e.g. --task t03-offer-deadline
  --include-example    Also run bench/tasks/t00-example.json
  --allow-simulated    Write latest.json and chart.json even for a simulated run (labelled)
  --out <dir>          Results directory (default bench/results/)
  -h, --help           This text

Env (.env): ANTHROPIC_API_KEY (responder), CANON_URL, CANON_CLIENT_TOKENS (canon baseline),
BENCH_PRICE_PER_MTOK_IN / BENCH_PRICE_PER_MTOK_OUT (cost; null when unset).`;

interface Cli {
  dry: boolean;
  baselines: BaselineName[];
  tasks: string[];
  includeExample: boolean;
  allowSimulated: boolean;
  out: string;
}

function parseCli(argv: string[]): Cli {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      dry: { type: "boolean", default: false },
      baseline: { type: "string", multiple: true },
      task: { type: "string", multiple: true },
      "include-example": { type: "boolean", default: false },
      "allow-simulated": { type: "boolean", default: false },
      out: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const baselines: BaselineName[] = [];
  for (const raw of values.baseline ?? []) {
    for (const name of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!isBaselineName(name)) throw new Error(`--baseline must be one of ${BASELINE_NAMES.join(", ")} (got "${name}")`);
      if (!baselines.includes(name)) baselines.push(name);
    }
  }
  return {
    dry: values.dry,
    baselines: baselines.length ? baselines : [...BASELINE_NAMES],
    tasks: values.task ?? [],
    includeExample: values["include-example"],
    allowSimulated: values["allow-simulated"],
    out: values.out ?? DEFAULT_OUT,
  };
}

function banner(lines: string[]): void {
  const width = Math.min(100, Math.max(...lines.map((l) => l.length)) + 4);
  const bar = "=".repeat(width);
  console.log(`\n${bar}\n${lines.map((l) => `  ${l}`).join("\n")}\n${bar}\n`);
}

function pickResponder(dry: boolean): { responder: Responder; reason?: string } {
  if (dry) return { responder: new EchoResponder(), reason: "--dry" };
  if (!env("ANTHROPIC_API_KEY")) return { responder: new EchoResponder(), reason: "ANTHROPIC_API_KEY is not set" };
  return { responder: new ClaudeResponder() };
}

function preview(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

async function runCell(task: BenchTask, baseline: Baseline, responder: Responder): Promise<{ cell: Cell; raw: RawEntry }> {
  const cell: Cell = { task_id: task.id, baseline: baseline.name, correct: null };
  const raw: RawEntry = { task_id: task.id, baseline: baseline.name, context: "", answer: "" };
  try {
    const prepared = await baseline.prepare(task);
    raw.context = prepared.context;
    cell.prepare = {
      context_chars: prepared.context.length,
      context_preview: preview(prepared.context),
      tokens_injected_est: prepared.tokens_injected_est,
      latency_ms: prepared.latency_ms,
      simulated: prepared.simulated === true,
      ...(prepared.detail !== undefined ? { detail: prepared.detail } : {}),
    };
    const answered = await responder.answer(prepared.context, task.question);
    raw.answer = answered.text;
    cell.response = { text: answered.text, ms: answered.ms, simulated: answered.simulated === true, ...(answered.usage ? { usage: answered.usage } : {}) };
    cell.score = score(answered.text, task.answer_key);
    cell.correct = responder.simulated ? null : cell.score.correct;
  } catch (e) {
    cell.error = e instanceof Error ? e.message : String(e);
  }
  return { cell, raw };
}

function cellLine(cell: Cell): string {
  const head = `${cell.task_id.padEnd(28)} ${cell.baseline.padEnd(13)}`;
  if (cell.error) return `${head} ERROR  ${cell.error}`;
  const p = cell.prepare!;
  const r = cell.response!;
  const verdict = cell.correct === null ? "simulated" : cell.correct ? "correct" : `wrong (missing: ${cell.score?.misses.join(", ") || "-"}${cell.score?.violations.length ? `; leaked: ${cell.score.violations.join(", ")}` : ""})`;
  const usage = r.usage ? ` | in ${r.usage.input_tokens} tok` : "";
  return `${head} ctx est. ${String(p.tokens_injected_est).padStart(5)} tok | prep ${String(p.latency_ms).padStart(6)} ms | answer ${String(r.ms).padStart(6)} ms${usage} | ${verdict}${p.simulated ? " [prep simulated]" : ""}`;
}

function printSummary(summary: Summary): void {
  console.log("\nbaseline       tasks  errors  accuracy   est. tokens   input tokens   prep ms   answer ms   cost USD");
  for (const b of summary.baselines) {
    const pct = b.accuracy === null ? "   null" : `${(b.accuracy * 100).toFixed(0).padStart(6)}%`;
    const cell = (v: number | null, w: number) => String(v ?? "null").padStart(w);
    console.log(
      `${b.baseline.padEnd(13)} ${String(b.tasks).padStart(6)} ${String(b.errors).padStart(7)}  ${pct}  ${cell(b.mean_tokens_injected_est, 12)}  ${cell(b.mean_input_tokens, 13)}  ${cell(b.mean_prepare_latency_ms, 8)}  ${cell(b.mean_respond_ms, 10)}  ${cell(b.cost_usd, 9)}${b.simulated ? "  simulated" : ""}`,
    );
  }
  console.log(`\n${summary.note}`);
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const generated_at = nowIso();

  const { tasks: allTasks, warnings } = loadTasks({ includeExample: cli.includeExample });
  for (const w of warnings) console.warn(`[bench] ${w}`);
  let tasks = allTasks;
  if (cli.tasks.length) {
    const missing = cli.tasks.filter((id) => !allTasks.some((t) => t.id === id));
    if (missing.length) throw new Error(`Unknown task id(s): ${missing.join(", ")}. Available: ${allTasks.map((t) => t.id).join(", ") || "(none)"}`);
    tasks = allTasks.filter((t) => cli.tasks.includes(t.id));
  }
  if (tasks.length === 0) {
    throw new Error("No tasks to run. Edan writes them in bench/tasks/ (see bench/tasks/README.md); --include-example runs the example.");
  }

  const { responder, reason } = pickResponder(cli.dry);
  const serverUrl = env("CANON_URL", DEFAULT_SERVER_URL);
  const baselines = cli.baselines.map((name) => createBaseline(name, { serverUrl }));
  const prices = readPrices();

  if (reason) banner(["SIMULATED — not quotable", `Responder is an echo stub (${reason}). Accuracy and token usage will be null.`]);
  console.log(`[bench] ${tasks.length} task(s) × ${baselines.map((b) => b.name).join(", ")} | responder ${responder.name}${responder.model ? ` (${responder.model})` : ""} | server ${serverUrl}`);
  if (!prices) console.log("[bench] BENCH_PRICE_PER_MTOK_IN/OUT not set: cost stays null");

  const cells: Cell[] = [];
  const raws: RawEntry[] = [];
  for (const task of tasks) {
    for (const baseline of baselines) {
      const { cell, raw } = await runCell(task, baseline, responder);
      cells.push(cell);
      raws.push(raw);
      console.log(cellLine(cell));
    }
  }

  const summary = summarize(cells, {
    generated_at,
    dry: cli.dry,
    responder: { name: responder.name, ...(responder.model ? { model: responder.model } : {}), simulated: responder.simulated },
    prices,
    tasks: tasks.length,
    baselines: cli.baselines,
  });
  const report = writeResults(cli.out, { summary, server_url: serverUrl, argv: process.argv.slice(2), cells }, { allowSimulated: cli.allowSimulated });
  const rawDir = writeRaw(cli.out, fileStamp(generated_at), raws);

  printSummary(summary);
  console.log(`\nwrote ${report.wrote.join("\n      ")}\nraw   ${rawDir}`);
  if (report.skipped.length) {
    banner([
      "SIMULATED — not quotable",
      `Not written: ${report.skipped.map((p) => basename(p)).join(", ")} in ${cli.out}`,
      "Run with a real ANTHROPIC_API_KEY and a real judge/distiller,",
      "or pass --allow-simulated to write them labelled simulated.",
    ]);
  }

  const errors = cells.filter((c) => c.error).length;
  if (errors) console.warn(`[bench] ${errors} of ${cells.length} cells errored (see above)`);
  if (errors === cells.length) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(`\n[bench] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
