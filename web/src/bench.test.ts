import assert from "node:assert/strict";
import { test } from "node:test";

import { BENCH_URL, benchText, fetchBench, pickBenchComparison } from "./bench.ts";

// Shaped like bench/src/results.ts `Summary` (latest.json) and `Chart` (chart.json).
const baseline = (name: string, over: Record<string, unknown>) => ({
  baseline: name,
  tasks: 20,
  scored: 20,
  errors: 0,
  accuracy: null,
  mean_tokens_injected_est: null,
  mean_input_tokens: null,
  mean_output_tokens: null,
  mean_prepare_latency_ms: 12.5,
  mean_respond_ms: null,
  cost_usd: null,
  simulated: false,
  ...over,
});
const measuredSummary = {
  generated_at: "2026-10-25T01:00:00.000Z",
  simulated: false,
  dry: false,
  responder: { name: "claude", model: "claude-sonnet-5-5", simulated: false },
  prices: null,
  tasks: 20,
  baselines: [
    baseline("no-memory", { accuracy: 0.3, mean_tokens_injected_est: 0, mean_input_tokens: 310.2, mean_output_tokens: 80 }),
    baseline("full-history", { accuracy: 0.85, mean_tokens_injected_est: 41_000, mean_input_tokens: 44_120.5, mean_output_tokens: 90 }),
    baseline("canon", { accuracy: 0.8, mean_tokens_injected_est: 1_200, mean_input_tokens: 1_490.3, mean_output_tokens: 88 }),
  ],
  note: "Measured. *_est fields are ~4 chars/token estimates; input/output tokens come from the model's usage.",
};
const drySummary = {
  ...measuredSummary,
  simulated: true,
  dry: true,
  responder: { name: "echo", simulated: true },
  baselines: [
    baseline("no-memory", { mean_tokens_injected_est: 0, simulated: true }),
    baseline("full-history", { mean_tokens_injected_est: 41_000, simulated: true }),
    baseline("canon", { mean_tokens_injected_est: 1_200, simulated: true }),
  ],
  note: "SIMULATED — not quotable. A stub stood in for the model, the judge or the distiller.",
};
const chart = {
  generated_at: "2026-10-25T01:00:00.000Z",
  simulated: false,
  series: [
    { baseline: "no-memory", accuracy: 0.3, tokens: 310.2, tokens_source: "usage.input_tokens" },
    { baseline: "full-history", accuracy: 0.85, tokens: 44_120.5, tokens_source: "usage.input_tokens" },
    { baseline: "canon", accuracy: 0.8, tokens: 1_490.3, tokens_source: "usage.input_tokens" },
  ],
};

test("pickBenchComparison reads bench's latest.json Summary, preferring real usage tokens", () => {
  const c = pickBenchComparison(measuredSummary);
  assert.ok(c);
  assert.equal(c.fullTokens, 44_120.5, "mean_input_tokens, not the *_est figure");
  assert.equal(c.canonTokens, 1_490.3);
  assert.equal(c.tasks, 20);
  assert.equal(c.simulated, undefined);
  assert.ok(Math.abs(c.ratio - 29.61) < 0.01);
});

test("pickBenchComparison falls back to *_est on a dry run and carries simulated", () => {
  const c = pickBenchComparison(drySummary);
  assert.ok(c);
  assert.equal(c.fullTokens, 41_000);
  assert.equal(c.canonTokens, 1_200);
  assert.equal(c.simulated, true);
  assert.equal(benchText({ status: "ok", comparison: c }), "34× fewer tokens · 20 tasks (simulated)");
});

test("pickBenchComparison reads bench's chart.json series", () => {
  const c = pickBenchComparison(chart);
  assert.ok(c);
  assert.equal(c.fullTokens, 44_120.5);
  assert.equal(c.canonTokens, 1_490.3);
  assert.equal(c.tasks, undefined, "chart.json has no task count");
  assert.equal(pickBenchComparison({ ...chart, simulated: true })?.simulated, true);
});

test("pickBenchComparison reads baselines as an object", () => {
  const c = pickBenchComparison({
    tasks: 20,
    baselines: { no_memory: { tokens: 0 }, full_history: { tokens: 48_200 }, canon: { tokens: 1_380 } },
  });
  assert.ok(c);
  assert.equal(c.fullTokens, 48_200);
  assert.equal(c.canonTokens, 1_380);
  assert.equal(c.tasks, 20);
  assert.ok(Math.abs(c.ratio - 34.93) < 0.01);
});

test("pickBenchComparison reads baselines as an array with nested means", () => {
  const c = pickBenchComparison({
    tasks: [{ id: "t1" }, { id: "t2" }],
    results: [
      { name: "Paste full history", tokens_injected: { mean: 30_000 } },
      { name: "Canon", tokens_injected: { mean: 1_500 } },
    ],
  });
  assert.ok(c);
  assert.equal(c.ratio, 20);
  assert.equal(c.tasks, 2);
});

test("pickBenchComparison refuses to guess", () => {
  assert.equal(pickBenchComparison(null), null);
  assert.equal(pickBenchComparison({ baselines: { canon: { tokens: 10 } } }), null, "no full-history figure");
  assert.equal(pickBenchComparison({ baselines: { canon: { accuracy: 0.9 }, full_history: { accuracy: 0.8 } } }), null, "no tokens at all");
});

test("benchText never shows a number without a bench run", () => {
  assert.equal(benchText(undefined), "—");
  assert.equal(benchText({ status: "missing" }), "— (run bench)");
  assert.equal(benchText({ status: "unreadable" }), "— (bench format?)");
  assert.equal(benchText({ status: "offline" }), "—");
  assert.equal(benchText({ status: "ok", comparison: { canonTokens: 1000, fullTokens: 34_900, ratio: 34.9, tasks: 20 } }), "35× fewer tokens · 20 tasks");
  assert.equal(benchText({ status: "ok", comparison: { canonTokens: 1000, fullTokens: 2500, ratio: 2.5 } }), "2.5× fewer tokens");
});

test("fetchBench reads the same-origin bench path by default (no Canon server route involved)", async () => {
  const urls: string[] = [];
  const recording = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(measuredSummary), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal((await fetchBench(undefined, recording)).status, "ok");
  assert.deepEqual(urls, [BENCH_URL]);
  assert.equal(BENCH_URL, "bench/latest.json");
  assert.ok(!BENCH_URL.startsWith("/") && !BENCH_URL.includes("://"), "relative to the page, so it stays on the web origin");
});

test("fetchBench maps HTTP outcomes", async () => {
  const fake = (status: number, body?: unknown): typeof fetch =>
    (async () => new Response(body === undefined ? null : JSON.stringify(body), { status })) as unknown as typeof fetch;

  assert.deepEqual(await fetchBench("http://x", fake(404)), { status: "missing" });
  assert.deepEqual(await fetchBench("http://x", fake(500)), { status: "unreadable" });
  assert.deepEqual(await fetchBench("http://x", fake(200, { hello: 1 })), { status: "unreadable" });
  const ok = await fetchBench("http://x", fake(200, { baselines: { full: { tokens: 200 }, canon: { tokens: 100 } } }));
  assert.equal(ok.status, "ok");
  const offline = await fetchBench("http://x", (async () => {
    throw new TypeError("connection refused");
  }) as unknown as typeof fetch);
  assert.deepEqual(offline, { status: "offline" });
});
