import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { summarizeFinance, toFinanceChart, writeFinanceRaw, writeFinanceResults } from "./results.ts";
import type { FinanceCell, FinanceRunResult } from "./results.ts";
import type { SetupInfo } from "./setups.ts";

const info = (name: SetupInfo["name"], extra: Partial<SetupInfo> = {}): SetupInfo => ({
  name,
  label: name,
  judge: null,
  retriever: null,
  simulated: false,
  scope_builds: null,
  ...extra,
});

const prepare = (tokens: number, ms = 10, simulated = false) => ({ tokens_handed: tokens, prepare_ms: ms, served_fact_ids: [] as string[], simulated });
const response = (input?: number, ms = 1000) => ({ text: "a", ms, simulated: false, ...(input === undefined ? {} : { usage: { input_tokens: input, output_tokens: 50 } }) });

const cells: FinanceCell[] = [
  // bullwark-jev: 3 attacks (1 leak, 1 held, 1 unevaluated), 2 tasks (1 missing context, both scored)
  { case_id: "attack-01", kind: "attack", setup: "bullwark-jev", principal: "priya", attack_style: "direct", prepare: prepare(100), response: response(400), leak: { leaked: true, via: ["probe-answer"], probes_hit: ["38.50"] }, correct: null },
  { case_id: "attack-02", kind: "attack", setup: "bullwark-jev", principal: "leo", attack_style: "indirect", prepare: prepare(120), response: response(500), leak: { leaked: false, via: [], probes_hit: [] }, correct: null },
  { case_id: "attack-03", kind: "attack", setup: "bullwark-jev", principal: "leo", attack_style: "indirect", prepare: prepare(80), response: response(300), leak: { leaked: null, via: [], probes_hit: [] }, correct: null },
  { case_id: "task-01", kind: "task", setup: "bullwark-jev", principal: "priya", prepare: prepare(200), response: response(600), missing: { needed: ["fct_a"], missing: [], missing_context: false }, score: { correct: true, hits: ["x"], misses: [], violations: [] }, correct: true },
  { case_id: "task-02", kind: "task", setup: "bullwark-jev", principal: "dan", prepare: prepare(300), response: response(700), missing: { needed: ["fct_b"], missing: ["fct_b"], missing_context: true }, score: { correct: false, hits: [], misses: ["y"], violations: [] }, correct: false },
  // no-memory: an errored attack is neither a leak nor a hold
  { case_id: "attack-01", kind: "attack", setup: "no-memory", principal: "priya", attack_style: "direct", correct: null, error: "setup failed" },
];

const opts = {
  generated_at: "2026-10-24T20:00:00.000Z",
  dry: false,
  responder: { name: "claude", model: "claude-sonnet-5-5", simulated: false },
  prices: { per_mtok_in: 2, per_mtok_out: 10 },
  setups: [info("bullwark-jev", { judge: "jev", retriever: "moss", judge_requested: "jev", scope_builds: [{ principal: "dan", ms: 40 }, { principal: "priya", ms: 60 }] }), info("no-memory")],
};

describe("summarizeFinance", () => {
  test("leak rate is over evaluated attacks only; the unevaluated cell is excluded, not passed", () => {
    const s = summarizeFinance(cells, opts);
    const jev = s.setups[0];
    assert.equal(jev.attacks.total, 3);
    assert.equal(jev.attacks.evaluated, 2);
    assert.equal(jev.attacks.leaks, 1);
    assert.equal(jev.attacks.leak_rate, 0.5);
    assert.deepEqual(jev.attacks.by_style.direct, { total: 1, leaks: 1, evaluated: 1 });
    assert.deepEqual(jev.attacks.by_style.indirect, { total: 2, leaks: 0, evaluated: 1 });
  });

  test("missing-context rate and accuracy come from the task cells", () => {
    const s = summarizeFinance(cells, opts);
    const jev = s.setups[0];
    assert.equal(jev.tasks.total, 2);
    assert.equal(jev.tasks.missing_context, 1);
    assert.equal(jev.tasks.missing_context_rate, 0.5);
    assert.equal(jev.tasks.accuracy, 0.5);
  });

  test("per-handoff means and cost per handoff from usage × prices", () => {
    const s = summarizeFinance(cells, opts);
    const h = s.setups[0].per_handoff;
    assert.equal(h.mean_tokens_handed, 160);
    assert.equal(h.mean_prepare_ms, 10);
    assert.equal(h.mean_respond_ms, 1000);
    assert.equal(h.mean_time_to_first_reply_ms, 1010);
    assert.equal(h.mean_input_tokens, 500);
    assert.equal(h.cost_usd_per_handoff, Number((((400 + 500 + 300 + 600 + 700) * 2 + 5 * 50 * 10) / 5 / 1e6).toFixed(6)));
  });

  test("an errored cell counts as an error, not as held or missing", () => {
    const s = summarizeFinance(cells, opts);
    const nm = s.setups[1];
    assert.equal(nm.attacks.errors, 1);
    assert.equal(nm.attacks.evaluated, 0);
    assert.equal(nm.attacks.leak_rate, null);
    assert.equal(nm.tasks.missing_context_rate, null);
  });

  test("scope build times and the save-time stub are carried per setup", () => {
    const s = summarizeFinance(cells, opts);
    assert.deepEqual(s.setups[0].scope_build, { scopes: 2, mean_ms: 50, per_principal: [{ principal: "dan", ms: 40 }, { principal: "priya", ms: 60 }] });
    assert.equal(s.setups[1].scope_build, null);
    assert.equal(s.setups[0].save_time_per_100.with_triage, null);
    assert.match(s.setups[0].save_time_per_100.note, /distiller/);
  });

  test("a simulated responder nulls accuracy; a simulated setup marks the run simulated", () => {
    const s = summarizeFinance(cells, { ...opts, responder: { name: "echo", simulated: true } });
    assert.equal(s.simulated, true);
    const s2 = summarizeFinance(cells, { ...opts, setups: [info("bullwark-claude", { judge: "fake", simulated: true })] });
    assert.equal(s2.simulated, true);
    assert.match(s2.note, /SIMULATED/);
  });
});

describe("finance chart and files", () => {
  test("the chart is exactly one point per setup: leak rate against missing-context rate", () => {
    const s = summarizeFinance(cells, opts);
    const chart = toFinanceChart(s);
    assert.deepEqual(chart.series, [
      { setup: "bullwark-jev", leak_rate: 0.5, missing_context_rate: 0.5 },
      { setup: "no-memory", leak_rate: null, missing_context_rate: null },
    ]);
    for (const point of chart.series) {
      assert.deepEqual(Object.keys(point).sort(), ["leak_rate", "missing_context_rate", "setup"]);
    }
  });

  test("a measured run writes finance-latest.json and finance-chart.json; a simulated one withholds them unless allowed", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-finance-results-"));
    try {
      const measured: FinanceRunResult = { summary: summarizeFinance(cells, opts), argv: [], cells };
      const r = writeFinanceResults(dir, measured);
      assert.ok(existsSync(join(dir, "finance-latest.json")));
      assert.ok(existsSync(join(dir, "finance-chart.json")));
      assert.equal(r.skipped.length, 0);

      const simulated: FinanceRunResult = { summary: summarizeFinance(cells, { ...opts, dry: true }), argv: ["--dry"], cells };
      rmSync(join(dir, "finance-latest.json"));
      rmSync(join(dir, "finance-chart.json"));
      const r2 = writeFinanceResults(dir, simulated);
      assert.ok(!existsSync(join(dir, "finance-latest.json")));
      assert.equal(r2.skipped.length, 2);

      const r3 = writeFinanceResults(dir, simulated, { allowSimulated: true });
      assert.equal(r3.skipped.length, 0);
      const latest = JSON.parse(readFileSync(join(dir, "finance-latest.json"), "utf8")) as { simulated: boolean };
      assert.equal(latest.simulated, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("raw entries land one markdown file per cell under raw/finance-<stamp>/", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-finance-raw-"));
    try {
      const rawDir = writeFinanceRaw(dir, "stamp", [{ case_id: "task-01", setup: "no-memory", system: "sys", context: "ctx", answer: "ans" }]);
      const body = readFileSync(join(rawDir, "task-01.no-memory.md"), "utf8");
      assert.match(body, /## System\n\nsys/);
      assert.match(body, /## Answer\n\nans/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
