// Results on disk. One timestamped file per run (full detail). latest.json and chart.json are
// what Devpost and the dashboard quote, so they are written only from a measured run, or from a
// simulated one when --allow-simulated says so, and then they carry `simulated: true`.
// Every number here is a mean of measured values; nothing is estimated except fields named *_est.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { env } from "@canon/shared";

import type { BaselineName } from "./baselines/index.ts";
import type { Usage } from "./responder.ts";
import type { ScoreResult } from "./types.ts";

export interface CellPrepare {
  context_chars: number;
  context_preview: string;
  tokens_injected_est: number;
  latency_ms: number;
  simulated: boolean;
  detail?: unknown;
}

export interface CellResponse {
  text: string;
  usage?: Usage;
  ms: number;
  simulated: boolean;
}

export interface Cell {
  task_id: string;
  baseline: BaselineName;
  prepare?: CellPrepare;
  response?: CellResponse;
  score?: ScoreResult;
  /** null when no model answered (echo responder) or the cell errored. */
  correct: boolean | null;
  error?: string;
}

export interface Prices {
  per_mtok_in: number;
  per_mtok_out: number;
}

export interface BaselineSummary {
  baseline: BaselineName;
  tasks: number;
  /** Cells that got a scored answer (no error). Accuracy is over these. */
  scored: number;
  errors: number;
  accuracy: number | null;
  mean_tokens_injected_est: number | null;
  mean_input_tokens: number | null;
  mean_output_tokens: number | null;
  mean_prepare_latency_ms: number | null;
  mean_respond_ms: number | null;
  cost_usd: number | null;
  simulated: boolean;
}

export interface Summary {
  generated_at: string;
  simulated: boolean;
  dry: boolean;
  responder: { name: string; model?: string; simulated: boolean };
  prices: Prices | null;
  tasks: number;
  baselines: BaselineSummary[];
  note: string;
}

export interface RunResult {
  summary: Summary;
  server_url: string;
  argv: string[];
  cells: Cell[];
}

export interface Chart {
  generated_at: string;
  simulated: boolean;
  series: Array<{ baseline: BaselineName; accuracy: number | null; tokens: number | null; tokens_source: "usage.input_tokens" | "est." | null }>;
}

/** BENCH_PRICE_PER_MTOK_IN / _OUT, both numeric, else null (cost then stays null, never guessed). */
export function readPrices(): Prices | null {
  const rawIn = env("BENCH_PRICE_PER_MTOK_IN");
  const rawOut = env("BENCH_PRICE_PER_MTOK_OUT");
  if (!rawIn && !rawOut) return null;
  const per_mtok_in = Number(rawIn);
  const per_mtok_out = Number(rawOut);
  if (!rawIn || !rawOut || !Number.isFinite(per_mtok_in) || !Number.isFinite(per_mtok_out)) {
    console.warn("[bench] BENCH_PRICE_PER_MTOK_IN and BENCH_PRICE_PER_MTOK_OUT must both be numbers; cost will be null");
    return null;
  }
  return { per_mtok_in, per_mtok_out };
}

function mean(xs: number[], digits = 1): number | null {
  if (xs.length === 0) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Number(m.toFixed(digits));
}

export interface SummarizeOptions {
  generated_at: string;
  dry: boolean;
  responder: Summary["responder"];
  prices: Prices | null;
  tasks: number;
  baselines: readonly BaselineName[];
}

export function summarize(cells: Cell[], opts: SummarizeOptions): Summary {
  const baselines = opts.baselines.map((name): BaselineSummary => {
    const mine = cells.filter((c) => c.baseline === name);
    const scored = mine.filter((c) => !c.error && c.response);
    const prepared = mine.filter((c) => c.prepare);
    const withUsage = scored.filter((c) => c.response?.usage);
    // An echo answer can be neither right nor wrong, so accuracy is null, not 0 or 100.
    const correct = opts.responder.simulated ? null : scored.filter((c) => c.correct === true).length;
    const allUsage = withUsage.length > 0 && withUsage.length === scored.length;
    const cost =
      opts.prices && allUsage
        ? withUsage.reduce((sum, c) => sum + (c.response!.usage!.input_tokens * opts.prices!.per_mtok_in + c.response!.usage!.output_tokens * opts.prices!.per_mtok_out) / 1e6, 0)
        : null;
    return {
      baseline: name,
      tasks: mine.length,
      scored: scored.length,
      errors: mine.filter((c) => c.error).length,
      accuracy: correct === null || scored.length === 0 ? null : Number((correct / scored.length).toFixed(3)),
      mean_tokens_injected_est: mean(prepared.map((c) => c.prepare!.tokens_injected_est)),
      mean_input_tokens: mean(withUsage.map((c) => c.response!.usage!.input_tokens)),
      mean_output_tokens: mean(withUsage.map((c) => c.response!.usage!.output_tokens)),
      mean_prepare_latency_ms: mean(prepared.map((c) => c.prepare!.latency_ms)),
      mean_respond_ms: opts.responder.simulated ? null : mean(scored.map((c) => c.response!.ms)),
      cost_usd: cost === null ? null : Number(cost.toFixed(6)),
      simulated: opts.responder.simulated || mine.some((c) => c.prepare?.simulated === true),
    };
  });
  const simulated = opts.dry || opts.responder.simulated || baselines.some((b) => b.simulated);
  return {
    generated_at: opts.generated_at,
    simulated,
    dry: opts.dry,
    responder: opts.responder,
    prices: opts.prices,
    tasks: opts.tasks,
    baselines,
    note: simulated
      ? "SIMULATED — not quotable. A stub stood in for the model, the judge or the distiller."
      : "Measured. *_est fields are ~4 chars/token estimates; input/output tokens come from the model's usage.",
  };
}

/** Accuracy vs tokens, one point per baseline. Real input tokens when known, else the estimate. */
export function toChart(summary: Summary): Chart {
  return {
    generated_at: summary.generated_at,
    simulated: summary.simulated,
    series: summary.baselines.map((b) => ({
      baseline: b.baseline,
      accuracy: b.accuracy,
      tokens: b.mean_input_tokens ?? b.mean_tokens_injected_est,
      tokens_source: b.mean_input_tokens !== null ? "usage.input_tokens" : b.mean_tokens_injected_est !== null ? "est." : null,
    })),
  };
}

/** ISO timestamp as a file name: colons are not allowed on every file system. */
export function fileStamp(iso: string): string {
  return iso.replace(/:/g, "-");
}

export interface WriteReport {
  run_file: string;
  wrote: string[];
  skipped: string[];
}

/**
 * Writes `<stamp>.json` always, and latest.json + chart.json only when the run is measured or the
 * caller allows simulated output (then both files say `simulated: true`).
 */
export function writeResults(outDir: string, run: RunResult, opts: { allowSimulated?: boolean } = {}): WriteReport {
  mkdirSync(outDir, { recursive: true });
  const stamp = fileStamp(run.summary.generated_at);
  const runFile = join(outDir, `${stamp}.json`);
  writeFileSync(runFile, `${JSON.stringify(run, null, 2)}\n`);
  const wrote = [runFile];
  const skipped: string[] = [];
  const quotable = ["latest.json", "chart.json"];
  if (run.summary.simulated && !opts.allowSimulated) {
    skipped.push(...quotable.map((f) => join(outDir, f)));
  } else {
    const latest = join(outDir, "latest.json");
    const chart = join(outDir, "chart.json");
    writeFileSync(latest, `${JSON.stringify(run.summary, null, 2)}\n`);
    writeFileSync(chart, `${JSON.stringify(toChart(run.summary), null, 2)}\n`);
    wrote.push(latest, chart);
  }
  return { run_file: runFile, wrote, skipped };
}

export interface RawEntry {
  task_id: string;
  baseline: BaselineName;
  context: string;
  answer: string;
}

/** Full contexts and answers, one markdown file per cell, under results/raw/<stamp>/ (gitignored). */
export function writeRaw(outDir: string, stamp: string, entries: RawEntry[]): string {
  const dir = join(outDir, "raw", stamp);
  mkdirSync(dir, { recursive: true });
  for (const e of entries) {
    const body = `# ${e.task_id} · ${e.baseline}\n\n## Context injected\n\n${e.context || "(empty)"}\n\n## Answer\n\n${e.answer || "(none)"}\n`;
    writeFileSync(join(dir, `${e.task_id}.${e.baseline}.md`), body);
  }
  return dir;
}
