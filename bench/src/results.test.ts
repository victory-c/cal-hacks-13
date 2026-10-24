import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { fileStamp, readPrices, summarize, toChart, writeRaw, writeResults } from "./results.ts";
import type { Cell, RunResult } from "./results.ts";
import { withEnv } from "./test-helpers.ts";

const prepare = (tokens: number, simulated = false) => ({ context_chars: tokens * 4, context_preview: "", tokens_injected_est: tokens, latency_ms: 10, simulated });
const response = (input_tokens?: number) => ({ text: "a", ms: 1000, simulated: false, ...(input_tokens === undefined ? {} : { usage: { input_tokens, output_tokens: 50 } }) });

const measuredCells: Cell[] = [
  { task_id: "t01", baseline: "no-memory", prepare: prepare(0), response: response(100), correct: false, score: { correct: false, hits: [], misses: ["x"], violations: [] } },
  { task_id: "t02", baseline: "no-memory", prepare: prepare(0), response: response(120), correct: false },
  { task_id: "t01", baseline: "full-history", prepare: prepare(4000), response: response(4200), correct: true },
  { task_id: "t02", baseline: "full-history", prepare: prepare(6000), response: response(6100), correct: true },
  { task_id: "t01", baseline: "canon", prepare: prepare(300), response: response(420), correct: true },
  { task_id: "t02", baseline: "canon", correct: null, error: "Canon server at http://localhost:4100 is not reachable" },
];

const base = { generated_at: "2026-10-24T03:12:00.000Z", dry: false, tasks: 2, baselines: ["no-memory", "full-history", "canon"] as const };

describe("summarize", () => {
  test("measured run: accuracy over scored cells, errors counted separately, cost from prices × usage", () => {
    const s = summarize(measuredCells, { ...base, responder: { name: "claude", model: "claude-sonnet-5-5", simulated: false }, prices: { per_mtok_in: 2, per_mtok_out: 10 } });
    assert.equal(s.simulated, false);
    const by = Object.fromEntries(s.baselines.map((b) => [b.baseline, b]));
    assert.equal(by["no-memory"].accuracy, 0);
    assert.equal(by["full-history"].accuracy, 1);
    assert.equal(by.canon.accuracy, 1, "the errored cell is not scored");
    assert.equal(by.canon.scored, 1);
    assert.equal(by.canon.errors, 1);
    assert.equal(by["full-history"].mean_tokens_injected_est, 5000);
    assert.equal(by["full-history"].mean_input_tokens, 5150);
    assert.equal(by["full-history"].mean_output_tokens, 50);
    assert.equal(by["full-history"].cost_usd, Number((((4200 + 6100) * 2 + 100 * 10) / 1e6).toFixed(6)));
    assert.equal(by.canon.cost_usd, Number(((420 * 2 + 50 * 10) / 1e6).toFixed(6)));
    assert.match(s.note, /^Measured/);
  });

  test("no prices → cost null; a scored cell without usage → cost null for that baseline", () => {
    const cells: Cell[] = [
      { task_id: "t01", baseline: "canon", prepare: prepare(300), response: response(420), correct: true },
      { task_id: "t02", baseline: "canon", prepare: prepare(310), response: response(), correct: true },
    ];
    const noPrices = summarize(cells, { ...base, baselines: ["canon"], responder: { name: "claude", simulated: false }, prices: null });
    assert.equal(noPrices.baselines[0].cost_usd, null);
    assert.equal(noPrices.baselines[0].mean_input_tokens, 420, "mean over the cells that have usage");
    const prices = summarize(cells, { ...base, baselines: ["canon"], responder: { name: "claude", simulated: false }, prices: { per_mtok_in: 2, per_mtok_out: 10 } });
    assert.equal(prices.baselines[0].cost_usd, null, "never priced from a partial usage count");
  });

  test("simulated responder: accuracy, respond time and cost are null, flag set, note says so", () => {
    const cells: Cell[] = measuredCells.map((c) => (c.response ? { ...c, response: { ...c.response, usage: undefined, simulated: true }, correct: null } : c));
    const s = summarize(cells, { ...base, dry: true, responder: { name: "echo", simulated: true }, prices: { per_mtok_in: 2, per_mtok_out: 10 } });
    assert.equal(s.simulated, true);
    for (const b of s.baselines) {
      assert.equal(b.accuracy, null);
      assert.equal(b.mean_input_tokens, null);
      assert.equal(b.mean_respond_ms, null);
      assert.equal(b.cost_usd, null);
      assert.equal(b.simulated, true);
    }
    assert.notEqual(s.baselines[1].mean_tokens_injected_est, null, "measured estimate of the injected context stays");
    assert.match(s.note, /^SIMULATED — not quotable/);
  });

  test("a simulated prepare (fake judge) marks that baseline and the run simulated even with a real responder", () => {
    const cells: Cell[] = [
      { task_id: "t01", baseline: "no-memory", prepare: prepare(0), response: response(100), correct: false },
      { task_id: "t01", baseline: "canon", prepare: prepare(300, true), response: response(420), correct: true },
    ];
    const s = summarize(cells, { ...base, baselines: ["no-memory", "canon"], responder: { name: "claude", simulated: false }, prices: null });
    assert.equal(s.baselines[0].simulated, false);
    assert.equal(s.baselines[1].simulated, true);
    assert.equal(s.baselines[1].accuracy, 1, "the measured figure is kept, but labelled");
    assert.equal(s.simulated, true);
  });
});

test("toChart: real input tokens when known, else the estimate, and says which", () => {
  const s = summarize(measuredCells, { ...base, responder: { name: "claude", simulated: false }, prices: null });
  const chart = toChart(s);
  assert.equal(chart.simulated, false);
  assert.deepEqual(chart.series[1], { baseline: "full-history", accuracy: 1, tokens: 5150, tokens_source: "usage.input_tokens" });
  const est = toChart({ ...s, baselines: s.baselines.map((b) => ({ ...b, mean_input_tokens: null })) });
  assert.deepEqual(est.series[1], { baseline: "full-history", accuracy: 1, tokens: 5000, tokens_source: "est." });
});

test("readPrices needs both numbers", async () => {
  await withEnv({ BENCH_PRICE_PER_MTOK_IN: undefined, BENCH_PRICE_PER_MTOK_OUT: undefined }, () => assert.equal(readPrices(), null));
  await withEnv({ BENCH_PRICE_PER_MTOK_IN: "2", BENCH_PRICE_PER_MTOK_OUT: "10" }, () => assert.deepEqual(readPrices(), { per_mtok_in: 2, per_mtok_out: 10 }));
  const original = console.warn;
  console.warn = () => undefined;
  try {
    await withEnv({ BENCH_PRICE_PER_MTOK_IN: "2", BENCH_PRICE_PER_MTOK_OUT: undefined }, () => assert.equal(readPrices(), null));
    await withEnv({ BENCH_PRICE_PER_MTOK_IN: "two", BENCH_PRICE_PER_MTOK_OUT: "10" }, () => assert.equal(readPrices(), null));
  } finally {
    console.warn = original;
  }
});

describe("writeResults", () => {
  const run = (simulated: boolean): RunResult => ({
    summary: summarize(measuredCells, { ...base, dry: simulated, responder: { name: simulated ? "echo" : "claude", simulated }, prices: null }),
    server_url: "http://localhost:4100",
    argv: simulated ? ["--dry"] : [],
    cells: measuredCells,
  });

  test("a dry run writes the timestamped file but refuses latest.json and chart.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "canon-bench-"));
    try {
      const report = writeResults(dir, run(true));
      assert.equal(report.run_file, join(dir, "2026-10-24T03-12-00.000Z.json"));
      assert.ok(existsSync(report.run_file));
      assert.equal(existsSync(join(dir, "latest.json")), false);
      assert.equal(existsSync(join(dir, "chart.json")), false);
      assert.deepEqual(report.skipped, [join(dir, "latest.json"), join(dir, "chart.json")]);
      const saved = JSON.parse(readFileSync(report.run_file, "utf8")) as RunResult;
      assert.equal(saved.summary.simulated, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--allow-simulated writes them, labelled simulated", () => {
    const dir = mkdtempSync(join(tmpdir(), "canon-bench-"));
    try {
      const report = writeResults(dir, run(true), { allowSimulated: true });
      assert.deepEqual(report.skipped, []);
      const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")) as { simulated: boolean; baselines: Array<{ accuracy: null }> };
      assert.equal(latest.simulated, true);
      assert.equal(latest.baselines[0].accuracy, null);
      const chart = JSON.parse(readFileSync(join(dir, "chart.json"), "utf8")) as { simulated: boolean };
      assert.equal(chart.simulated, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a measured run writes all three, and raw files land under raw/<stamp>/", () => {
    const dir = mkdtempSync(join(tmpdir(), "canon-bench-"));
    try {
      const report = writeResults(dir, run(false));
      assert.equal(report.wrote.length, 3);
      const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")) as { simulated: boolean };
      assert.equal(latest.simulated, false);
      const rawDir = writeRaw(dir, fileStamp(base.generated_at), [{ task_id: "t01", baseline: "canon", context: "CTX", answer: "ANS" }]);
      assert.equal(rawDir, join(dir, "raw", "2026-10-24T03-12-00.000Z"));
      const md = readFileSync(join(rawDir, "t01.canon.md"), "utf8");
      assert.ok(md.includes("CTX") && md.includes("ANS"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("fileStamp makes an ISO timestamp safe for every file system", () => {
  assert.equal(fileStamp("2026-10-24T03:12:00.000Z"), "2026-10-24T03-12-00.000Z");
});
