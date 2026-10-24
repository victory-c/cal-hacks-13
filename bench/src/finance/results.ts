// Finance results on disk, following ../results.ts: one timestamped file per run with full
// detail; finance-latest.json and finance-chart.json are what the pitch quotes, so they are
// written only from a measured run (or labelled, with --allow-simulated). finance-chart.json is
// exactly the PRD pitch chart: leak rate against missing-context rate, one point per setup.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Usage } from "../responder.ts";
import { fileStamp } from "../results.ts";
import type { Prices } from "../results.ts";
import type { ScoreResult } from "../types.ts";
import type { LeakVia } from "./leak.ts";
import type { SetupInfo } from "./setups.ts";
import type { AttackStyle, SetupName } from "./types.ts";

export interface FinanceCellPrepare {
  tokens_handed: number;
  prepare_ms: number;
  served_fact_ids: string[];
  simulated: boolean;
  warnings?: string[];
  detail?: unknown;
}

export interface FinanceCellResponse {
  text: string;
  usage?: Usage;
  ms: number;
  simulated: boolean;
}

export interface FinanceCellLeak {
  /** null: this cell could not be evaluated (e.g. shared memory with a simulated responder). */
  leaked: boolean | null;
  via: LeakVia[];
  probes_hit: string[];
  /** The subtle-leak judge's P(reveals), when it ran. */
  judge_p?: number | null;
  judge?: string;
  judge_simulated?: boolean;
}

export interface FinanceCellMissing {
  needed: string[];
  missing: string[];
  missing_context: boolean;
}

export interface FinanceCell {
  case_id: string;
  kind: "task" | "attack";
  setup: SetupName;
  principal: string;
  attack_style?: AttackStyle;
  prepare?: FinanceCellPrepare;
  response?: FinanceCellResponse;
  leak?: FinanceCellLeak;
  missing?: FinanceCellMissing;
  score?: ScoreResult;
  /** null when no model answered (echo responder) or the cell errored. */
  correct: boolean | null;
  error?: string;
}

export interface SetupAttackSummary {
  total: number;
  errors: number;
  /** Cells whose leak check could run (leaked !== null). Leak rate is over these. */
  evaluated: number;
  leaks: number;
  leak_rate: number | null;
  by_style: Record<string, { total: number; leaks: number; evaluated: number }>;
}

export interface SetupTaskSummary {
  total: number;
  errors: number;
  /** Cells with a prepared context (no error). Missing-context rate is over these. */
  prepared: number;
  missing_context: number;
  missing_context_rate: number | null;
  /** Cells a real model answered. Accuracy is over these; null when simulated. */
  scored: number;
  accuracy: number | null;
}

export interface SetupHandoffSummary {
  mean_tokens_handed: number | null;
  mean_input_tokens: number | null;
  mean_output_tokens: number | null;
  mean_prepare_ms: number | null;
  mean_respond_ms: number | null;
  /** prepare + respond per cell, then the mean: the member's wait. Null when simulated. */
  mean_time_to_first_reply_ms: number | null;
  cost_usd_per_handoff: number | null;
}

export interface SetupSummary {
  setup: SetupName;
  label: string;
  judge_requested?: string;
  judge: string | null;
  retriever: string | null;
  simulated: boolean;
  attacks: SetupAttackSummary;
  tasks: SetupTaskSummary;
  per_handoff: SetupHandoffSummary;
  scope_build: { scopes: number; mean_ms: number | null; per_principal: Array<{ principal: string; ms: number }> } | null;
  /** PRD metric not yet measurable here: triage is lane B's distiller (B5/B17). Never guessed. */
  save_time_per_100: { with_triage: null; without_triage: null; note: string };
}

export interface FinanceSummary {
  generated_at: string;
  simulated: boolean;
  dry: boolean;
  responder: { name: string; model?: string; simulated: boolean };
  prices: Prices | null;
  cases: { tasks: number; attacks: number };
  setups: SetupSummary[];
  note: string;
}

export interface FinanceRunResult {
  summary: FinanceSummary;
  argv: string[];
  cells: FinanceCell[];
}

/** The pitch chart (PRD "Chart for the pitch"): one point per setup, nothing else. */
export interface FinanceChart {
  generated_at: string;
  simulated: boolean;
  series: Array<{ setup: SetupName; leak_rate: number | null; missing_context_rate: number | null }>;
}

const SAVE_TIME_NOTE = "Save-time cost per 100 captured items (with/without Jev triage) runs through the distiller (lane B, B5/B17); this runner does not measure it yet and never estimates it.";

function mean(xs: number[], digits = 1): number | null {
  if (xs.length === 0) return null;
  return Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(digits));
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(3));
}

export interface SummarizeFinanceOptions {
  generated_at: string;
  dry: boolean;
  responder: FinanceSummary["responder"];
  prices: Prices | null;
  setups: SetupInfo[];
}

export function summarizeFinance(cells: FinanceCell[], opts: SummarizeFinanceOptions): FinanceSummary {
  const setups = opts.setups.map((info): SetupSummary => {
    const mine = cells.filter((c) => c.setup === info.name);
    const attacks = mine.filter((c) => c.kind === "attack");
    const tasks = mine.filter((c) => c.kind === "task");

    const attacksEvaluated = attacks.filter((c) => !c.error && c.leak?.leaked !== null && c.leak !== undefined);
    const leaks = attacksEvaluated.filter((c) => c.leak!.leaked === true);
    const by_style: SetupAttackSummary["by_style"] = {};
    for (const c of attacks) {
      const style = c.attack_style ?? "unknown";
      by_style[style] ??= { total: 0, leaks: 0, evaluated: 0 };
      by_style[style].total++;
      if (!c.error && c.leak && c.leak.leaked !== null) {
        by_style[style].evaluated++;
        if (c.leak.leaked) by_style[style].leaks++;
      }
    }

    const tasksPrepared = tasks.filter((c) => !c.error && c.missing);
    const missing = tasksPrepared.filter((c) => c.missing!.missing_context);
    const tasksScored = tasks.filter((c) => !c.error && c.correct !== null);
    const correct = tasksScored.filter((c) => c.correct === true);

    const prepared = mine.filter((c) => c.prepare);
    const answered = mine.filter((c) => !c.error && c.response && !c.response.simulated);
    const withUsage = answered.filter((c) => c.response!.usage);
    const allUsage = withUsage.length > 0 && withUsage.length === answered.length;
    const cost =
      opts.prices && allUsage
        ? withUsage.reduce((sum, c) => sum + (c.response!.usage!.input_tokens * opts.prices!.per_mtok_in + c.response!.usage!.output_tokens * opts.prices!.per_mtok_out) / 1e6, 0) /
          withUsage.length
        : null;

    return {
      setup: info.name,
      label: info.label,
      ...(info.judge_requested ? { judge_requested: info.judge_requested } : {}),
      judge: info.judge,
      retriever: info.retriever,
      simulated: info.simulated || mine.some((c) => c.prepare?.simulated === true),
      attacks: {
        total: attacks.length,
        errors: attacks.filter((c) => c.error).length,
        evaluated: attacksEvaluated.length,
        leaks: leaks.length,
        leak_rate: rate(leaks.length, attacksEvaluated.length),
        by_style,
      },
      tasks: {
        total: tasks.length,
        errors: tasks.filter((c) => c.error).length,
        prepared: tasksPrepared.length,
        missing_context: missing.length,
        missing_context_rate: rate(missing.length, tasksPrepared.length),
        scored: tasksScored.length,
        accuracy: tasksScored.length === 0 ? null : rate(correct.length, tasksScored.length),
      },
      per_handoff: {
        mean_tokens_handed: mean(prepared.map((c) => c.prepare!.tokens_handed)),
        mean_input_tokens: mean(withUsage.map((c) => c.response!.usage!.input_tokens)),
        mean_output_tokens: mean(withUsage.map((c) => c.response!.usage!.output_tokens)),
        mean_prepare_ms: mean(prepared.map((c) => c.prepare!.prepare_ms)),
        mean_respond_ms: mean(answered.map((c) => c.response!.ms)),
        mean_time_to_first_reply_ms: mean(answered.filter((c) => c.prepare).map((c) => c.prepare!.prepare_ms + c.response!.ms)),
        cost_usd_per_handoff: cost === null ? null : Number(cost.toFixed(6)),
      },
      scope_build:
        info.scope_builds === null
          ? null
          : {
              scopes: info.scope_builds.length,
              mean_ms: mean(info.scope_builds.map((b) => b.ms)),
              per_principal: info.scope_builds,
            },
      save_time_per_100: { with_triage: null, without_triage: null, note: SAVE_TIME_NOTE },
    };
  });

  const caseIds = new Set(cells.map((c) => c.case_id));
  const taskIds = new Set(cells.filter((c) => c.kind === "task").map((c) => c.case_id));
  const simulated = opts.dry || opts.responder.simulated || setups.some((s) => s.simulated);
  return {
    generated_at: opts.generated_at,
    simulated,
    dry: opts.dry,
    responder: opts.responder,
    prices: opts.prices,
    cases: { tasks: taskIds.size, attacks: caseIds.size - taskIds.size },
    setups,
    note: simulated
      ? "SIMULATED — not quotable. A stub stood in for the model, the judge or the retriever (see each setup's judge/retriever and the responder)."
      : "Measured. Rates are over evaluated cells; tokens_handed is a ~4 chars/token estimate, input/output tokens come from the model's usage.",
  };
}

export function toFinanceChart(summary: FinanceSummary): FinanceChart {
  return {
    generated_at: summary.generated_at,
    simulated: summary.simulated,
    series: summary.setups.map((s) => ({
      setup: s.setup,
      leak_rate: s.attacks.leak_rate,
      missing_context_rate: s.tasks.missing_context_rate,
    })),
  };
}

export interface FinanceWriteReport {
  run_file: string;
  wrote: string[];
  skipped: string[];
}

/**
 * Writes `finance-<stamp>.json` always, and finance-latest.json + finance-chart.json only when
 * the run is measured or the caller allows simulated output (then both say `simulated: true`).
 */
export function writeFinanceResults(outDir: string, run: FinanceRunResult, opts: { allowSimulated?: boolean } = {}): FinanceWriteReport {
  mkdirSync(outDir, { recursive: true });
  const stamp = fileStamp(run.summary.generated_at);
  const runFile = join(outDir, `finance-${stamp}.json`);
  writeFileSync(runFile, `${JSON.stringify(run, null, 2)}\n`);
  const wrote = [runFile];
  const skipped: string[] = [];
  if (run.summary.simulated && !opts.allowSimulated) {
    skipped.push(join(outDir, "finance-latest.json"), join(outDir, "finance-chart.json"));
  } else {
    const latest = join(outDir, "finance-latest.json");
    const chart = join(outDir, "finance-chart.json");
    writeFileSync(latest, `${JSON.stringify(run.summary, null, 2)}\n`);
    writeFileSync(chart, `${JSON.stringify(toFinanceChart(run.summary), null, 2)}\n`);
    wrote.push(latest, chart);
  }
  return { run_file: runFile, wrote, skipped };
}

export interface FinanceRawEntry {
  case_id: string;
  setup: SetupName;
  system: string;
  context: string;
  answer: string;
}

/** Full contexts and answers, one markdown file per cell, under results/raw/ (gitignored). */
export function writeFinanceRaw(outDir: string, stamp: string, entries: FinanceRawEntry[]): string {
  const dir = join(outDir, "raw", `finance-${stamp}`);
  mkdirSync(dir, { recursive: true });
  for (const e of entries) {
    const body = `# ${e.case_id} · ${e.setup}\n\n## System\n\n${e.system || "(default)"}\n\n## Context injected\n\n${e.context || "(empty)"}\n\n## Answer\n\n${e.answer || "(none)"}\n`;
    writeFileSync(join(dir, `${e.case_id}.${e.setup}.md`), body);
  }
  return dir;
}
