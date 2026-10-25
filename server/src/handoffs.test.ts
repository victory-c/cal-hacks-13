import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import type { Fact } from "@canon/shared";

import { Handoffs, toHandoffRecord } from "./handoffs.ts";

const fact = (id: string, statement: string): Fact => ({ id, statement, folder: "market/public", tier: "hot", jev_keep: 0.9, source: { client: "ingest", session: "ses_0001" }, updated: "2026-10-24" });
const facts = new Map([fact("fct_1", "TMC closed at $41.65"), fact("fct_2", "TMC paused its buyback")].map((f) => [f.id, f]));

describe("handoff records for the inspector", () => {
  test("toHandoffRecord maps cuts to decisions, resolves statements and keeps the measured times", () => {
    const r = toHandoffRecord(
      {
        id: "aud_1", at: "2026-10-24T20:00:00.000Z", principal: "dollar-bill", client: "dollar-bill", request: "TMC position?",
        candidates: [
          { fact_id: "fct_1", group: "market/public", cut: null, p: 0.83, tokens: 12 },
          { fact_id: "fct_2", group: "market/public", cut: "relevance", p: 0.2, tokens: 9 },
          { fact_id: "fct_gone", group: "market/public", cut: "budget", tokens: 30 },
        ],
        tokens: 12, budget: 1500, latency_ms: 40, retrieval_ms: 3, judge_ms: 30, simulated: true, inject_nothing: false,
      },
      (id) => facts.get(id),
    );
    assert.deepEqual(r.candidates, [
      { fact_id: "fct_1", statement: "TMC closed at $41.65", p: 0.83, decision: "kept", tokens_est: 12 },
      { fact_id: "fct_2", statement: "TMC paused its buyback", p: 0.2, decision: "cut_relevance", tokens_est: 9 },
      { fact_id: "fct_gone", statement: "", p: null, decision: "cut_budget", tokens_est: 30 },
    ]);
    assert.deepEqual(r.timings_ms, { search: 3, judge: 30, total: 40 });
    assert.equal(r.budget_est, 1500);
    assert.equal(r.simulated, true);
    assert.equal(r.run_id, undefined);
  });

  test("records persist as JSON lines, reload newest-last, list newest-first and filter by principal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canon-handoffs-"));
    try {
      const h = new Handoffs(dir);
      assert.equal(await h.load(), 0);
      const base = { candidates: [], tokens_est: 0, budget_est: 1500, timings_ms: { search: null, judge: null, total: 1 }, simulated: true, inject_nothing: true };
      h.record({ id: "aud_1", at: "t1", principal: "dollar-bill", request: "a", ...base });
      h.record({ id: "aud_2", at: "t2", principal: "desk-assistant", request: "b", ...base });
      h.record({ id: "aud_3", at: "t3", principal: "axe", request: "c", ...base });
      await h.drain();
      const lines = (await readFile(join(dir, "world", "handoffs.jsonl"), "utf8")).trim().split("\n");
      assert.equal(lines.length, 3);

      const again = new Handoffs(dir);
      assert.equal(await again.load(), 3);
      assert.deepEqual(again.list().map((r) => r.id), ["aud_3", "aud_2", "aud_1"]);
      assert.deepEqual(again.list({ principals: ["dollar-bill", "desk-assistant"] }).map((r) => r.id), ["aud_2", "aud_1"]);
      assert.deepEqual(again.list({ limit: 1 }).map((r) => r.id), ["aud_3"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("without a data dir the records live in memory only", () => {
    const h = new Handoffs();
    h.record({ id: "aud_9", at: "t", principal: "ben", request: "x", candidates: [], tokens_est: 0, budget_est: 1, timings_ms: { search: null, judge: null, total: 0 }, simulated: false, inject_nothing: true });
    assert.equal(h.list().length, 1);
  });
});
