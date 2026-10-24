// Finance benchmark CLI (A8). For every setup × case: prepare through that setup (the Bullwark
// setups drive the real server pipeline in-process, over HTTP) → respond → score leaks, missing
// context and accuracy, then write results.
//
//   npm run finance -w bench -- [--dry] [--setup name]... [--case id]... [--include-examples]
//                               [--allow-simulated] [--out dir]
//
// Numbers only ever come from a run of this file. Without ANTHROPIC_API_KEY, or with --dry, the
// responder is an echo stub: the run is labelled SIMULATED, accuracy and answer-level leak checks
// are null, and finance-latest.json / finance-chart.json are not written (--allow-simulated
// writes them, labelled). Without Moss/Jev credentials the pipeline runs on the labelled keyword
// retriever and fake judge: still a real enforcement path, still labelled simulated.

import { basename } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { env, loadEnv, nowIso } from "@canon/shared";

import { ClaudeResponder, EchoResponder } from "../responder.ts";
import type { Responder } from "../responder.ts";
import { fileStamp, readPrices } from "../results.ts";
import { score } from "../score.ts";
import { loadCases } from "./cases.ts";
import { codeLeakCheck, createLeakJudge, judgeLeakCheck, missingFacts } from "./leak.ts";
import type { LeakJudge } from "./leak.ts";
import { summarizeFinance, writeFinanceRaw, writeFinanceResults } from "./results.ts";
import type { FinanceCell, FinanceRawEntry, FinanceSummary } from "./results.ts";
import { FINANCE_SYSTEM, createSetup, isSetupName } from "./setups.ts";
import type { FinanceSetup, SetupInfo } from "./setups.ts";
import { SETUP_NAMES, TARGET_ATTACKS, TARGET_TASKS } from "./types.ts";
import type { FinanceCase, SetupName } from "./types.ts";

loadEnv();

const DEFAULT_OUT = fileURLToPath(new URL("../../results/", import.meta.url));

const USAGE = `Bullwark finance benchmark runner (A8)

  npm run finance -w bench -- [options]

  --dry                Echo responder, no model call. Whole run is SIMULATED.
  --setup <name>       Run only this setup (repeatable): ${SETUP_NAMES.join(" | ")}
  --case <id>          Run only this case id (repeatable), e.g. --case attack-01-direct-terms
  --include-examples   Also run the task-00-* / attack-00-* documentation examples
  --allow-simulated    Write finance-latest.json and finance-chart.json even for a simulated run (labelled)
  --out <dir>          Results directory (default bench/results/)
  -h, --help           This text

Cases live in bench/tasks/finance/ (C6 writes them; see its README). The runner consumes whatever
exists and runs fine on a partial set. Env (.env): ANTHROPIC_API_KEY (responder + Claude judge),
JEV_API_KEY/JEV_API_URL (Jev), BENCH_PRICE_PER_MTOK_IN / _OUT (cost; null when unset).`;

interface Cli {
  dry: boolean;
  setups: SetupName[];
  cases: string[];
  includeExamples: boolean;
  allowSimulated: boolean;
  out: string;
}

function parseCli(argv: string[]): Cli {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      dry: { type: "boolean", default: false },
      setup: { type: "string", multiple: true },
      case: { type: "string", multiple: true },
      "include-examples": { type: "boolean", default: false },
      "allow-simulated": { type: "boolean", default: false },
      out: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const setups: SetupName[] = [];
  for (const raw of values.setup ?? []) {
    for (const name of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!isSetupName(name)) throw new Error(`--setup must be one of ${SETUP_NAMES.join(", ")} (got "${name}")`);
      if (!setups.includes(name)) setups.push(name);
    }
  }
  return {
    dry: values.dry,
    setups: setups.length ? setups : [...SETUP_NAMES],
    cases: values.case ?? [],
    includeExamples: values["include-examples"],
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

async function runCell(
  setup: FinanceSetup,
  c: FinanceCase,
  responder: Responder,
  leakJudge: LeakJudge,
): Promise<{ cell: FinanceCell; raw: FinanceRawEntry }> {
  const cell: FinanceCell = {
    case_id: c.id,
    kind: c.kind,
    setup: setup.name,
    principal: c.principal,
    ...(c.attack_style ? { attack_style: c.attack_style } : {}),
    correct: null,
  };
  const raw: FinanceRawEntry = { case_id: c.id, setup: setup.name, system: "", context: "", answer: "" };
  try {
    const prepared = await setup.prepare(c);
    raw.context = prepared.context;
    raw.system = prepared.system ?? FINANCE_SYSTEM;
    cell.prepare = {
      tokens_handed: prepared.tokens_handed,
      prepare_ms: prepared.prepare_ms,
      served_fact_ids: prepared.served.map((f) => f.id),
      simulated: prepared.simulated,
      ...(prepared.warnings.length ? { warnings: prepared.warnings } : {}),
      ...(prepared.detail !== undefined ? { detail: prepared.detail } : {}),
    };

    const answered = await responder.answer(prepared.context, c.question, prepared.system ?? FINANCE_SYSTEM);
    raw.answer = answered.text;
    cell.response = { text: answered.text, ms: answered.ms, simulated: answered.simulated === true, ...(answered.usage ? { usage: answered.usage } : {}) };
    const answerText = responder.simulated ? null : answered.text;

    if (c.kind === "task") {
      const needed = c.needed_fact_ids ?? [];
      const missing = missingFacts(needed, cell.prepare.served_fact_ids);
      cell.missing = { needed, missing, missing_context: missing.length > 0 };
      if (c.answer_key) {
        cell.score = score(answered.text, c.answer_key);
        cell.correct = responder.simulated ? null : cell.score.correct;
      }
    } else {
      const code = codeLeakCheck({
        excludedGroups: prepared.excluded_groups,
        served: prepared.served,
        servedText: prepared.servedText,
        answerText,
        probes: c.leak_probes ?? [],
        sharedContext: prepared.shared_context,
      });
      cell.leak = { leaked: code.leaked, via: code.via, probes_hit: code.probes_hit };
      // The subtle-leak judge runs only on real answers the code check cleared: it can flip a
      // "no leak" to a leak (paraphrase), never the other way.
      if (code.leaked !== true && answerText !== null && prepared.confidential.length > 0) {
        const judged = await judgeLeakCheck(leakJudge, prepared.confidential, answerText);
        cell.leak.judge_p = judged.p;
        cell.leak.judge = judged.judge;
        cell.leak.judge_simulated = judged.simulated;
        if (judged.leaked === true) {
          cell.leak.leaked = true;
          cell.leak.via.push("judge");
        } else if (judged.leaked === null && code.leaked === null) {
          cell.leak.leaked = null;
        }
      }
    }
  } catch (e) {
    cell.error = e instanceof Error ? e.message : String(e);
  }
  return { cell, raw };
}

function cellLine(cell: FinanceCell): string {
  const head = `${cell.case_id.padEnd(30)} ${cell.setup.padEnd(16)}`;
  if (cell.error) return `${head} ERROR  ${cell.error}`;
  const p = cell.prepare!;
  let verdict: string;
  if (cell.kind === "attack") {
    const l = cell.leak!;
    verdict = l.leaked === null ? "leak: unevaluated" : l.leaked ? `LEAK via ${l.via.join("+")}${l.probes_hit.length ? ` (${l.probes_hit.join(", ")})` : ""}` : "held";
  } else {
    const m = cell.missing!;
    const ctx = m.missing_context ? `MISSING ${m.missing.join(", ")}` : "context ok";
    const acc = cell.correct === null ? "" : cell.correct ? ", correct" : `, wrong (missing: ${cell.score?.misses.join(", ") || "-"})`;
    verdict = `${ctx}${acc}`;
  }
  return `${head} handed ${String(p.tokens_handed).padStart(5)} tok | prep ${String(p.prepare_ms).padStart(5)} ms | ${verdict}${p.simulated ? " [simulated]" : ""}`;
}

function printSummary(summary: FinanceSummary): void {
  console.log("\nsetup            attacks  leaks  leak rate   tasks  missing  missing rate  accuracy   tok/handoff   first reply ms");
  for (const s of summary.setups) {
    const pct = (v: number | null) => (v === null ? "   null" : `${(v * 100).toFixed(0).padStart(5)}%`);
    const cell = (v: number | null, w: number) => String(v ?? "null").padStart(w);
    console.log(
      `${s.setup.padEnd(16)} ${String(s.attacks.total).padStart(7)} ${String(s.attacks.leaks).padStart(6)}  ${pct(s.attacks.leak_rate)}  ${String(s.tasks.total).padStart(6)} ${String(s.tasks.missing_context).padStart(8)}  ${pct(s.tasks.missing_context_rate).padStart(12)}  ${pct(s.tasks.accuracy)}  ${cell(s.per_handoff.mean_tokens_handed, 12)}  ${cell(s.per_handoff.mean_time_to_first_reply_ms, 15)}${s.simulated ? "  simulated" : ""}`,
    );
    if (s.scope_build) console.log(`${"".padEnd(16)} scope build: ${s.scope_build.scopes} scope(s), mean ${s.scope_build.mean_ms ?? "null"} ms (judge ${s.judge}, retriever ${s.retriever})`);
  }
  console.log(`\n${summary.note}`);
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const generated_at = nowIso();

  const { cases: allCases, warnings } = loadCases({ includeExamples: cli.includeExamples });
  for (const w of warnings) console.warn(`[bench] ${w}`);
  let cases = allCases;
  if (cli.cases.length) {
    const missing = cli.cases.filter((id) => !allCases.some((c) => c.id === id));
    if (missing.length) throw new Error(`Unknown case id(s): ${missing.join(", ")}. Available: ${allCases.map((c) => c.id).join(", ") || "(none)"}`);
    cases = allCases.filter((c) => cli.cases.includes(c.id));
  }
  const nTasks = cases.filter((c) => c.kind === "task").length;
  const nAttacks = cases.length - nTasks;
  if (cases.length === 0) {
    banner([
      "No finance cases found in bench/tasks/finance/.",
      `C6 writes ${TARGET_TASKS} tasks and ${TARGET_ATTACKS} attacks there (see its README); --include-examples runs the examples.`,
      "Running the four setups anyway to seed the results schema: every rate will be null.",
    ]);
  }

  const { responder, reason } = pickResponder(cli.dry);
  const prices = readPrices();
  const leakJudge = createLeakJudge();

  if (reason) banner(["SIMULATED — not quotable", `Responder is an echo stub (${reason}). Accuracy and answer-level leak checks will be null.`]);
  console.log(
    `[bench] ${nTasks} task(s) + ${nAttacks} attack(s) (targets ${TARGET_TASKS}/${TARGET_ATTACKS}) × ${cli.setups.join(", ")} | responder ${responder.name}${responder.model ? ` (${responder.model})` : ""} | leak judge ${leakJudge.judge.name}${leakJudge.simulated ? " (simulated)" : ""}`,
  );
  if (!prices) console.log("[bench] BENCH_PRICE_PER_MTOK_IN/OUT not set: cost stays null");

  const cells: FinanceCell[] = [];
  const raws: FinanceRawEntry[] = [];
  const infos: SetupInfo[] = [];
  for (const name of cli.setups) {
    const setup = createSetup(name);
    console.log(`\n[bench] setup ${name}: opening (fresh world per setup)`);
    try {
      await setup.open();
    } catch (e) {
      console.error(`[bench] setup ${name} failed to open: ${e instanceof Error ? e.message : String(e)}`);
      infos.push({ ...setup.info() });
      for (const c of cases) {
        cells.push({ case_id: c.id, kind: c.kind, setup: name, principal: c.principal, ...(c.attack_style ? { attack_style: c.attack_style } : {}), correct: null, error: `setup failed to open: ${e instanceof Error ? e.message : String(e)}` });
      }
      continue;
    }
    try {
      for (const c of cases) {
        const { cell, raw } = await runCell(setup, c, responder, leakJudge);
        cells.push(cell);
        raws.push(raw);
        console.log(cellLine(cell));
      }
      infos.push(setup.info());
    } finally {
      await setup.close();
    }
  }

  const summary = summarizeFinance(cells, {
    generated_at,
    dry: cli.dry,
    responder: { name: responder.name, ...(responder.model ? { model: responder.model } : {}), simulated: responder.simulated },
    prices,
    setups: infos,
  });
  const report = writeFinanceResults(cli.out, { summary, argv: process.argv.slice(2), cells }, { allowSimulated: cli.allowSimulated });
  const rawDir = writeFinanceRaw(cli.out, fileStamp(generated_at), raws);

  printSummary(summary);
  console.log(`\nwrote ${report.wrote.join("\n      ")}\nraw   ${rawDir}`);
  if (report.skipped.length) {
    banner([
      "SIMULATED — not quotable",
      `Not written: ${report.skipped.map((p) => basename(p)).join(", ")} in ${cli.out}`,
      "Run with real keys (ANTHROPIC_API_KEY; JEV_API_KEY for bullwark-jev; Moss for retrieval),",
      "or pass --allow-simulated to write them labelled simulated.",
    ]);
  }

  const errors = cells.filter((c) => c.error).length;
  if (errors) console.warn(`[bench] ${errors} of ${cells.length} cells errored (see above)`);
  if (cells.length > 0 && errors === cells.length) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(`\n[bench] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
