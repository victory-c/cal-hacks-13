import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { score } from "./score.ts";

describe("score", () => {
  test("correct when every must_include phrase appears, case-insensitively", () => {
    const r = score("I interned at DATABRICKS on the spark sql team and cut latency 30%.", { must_include: ["Databricks", "Spark SQL", "30%"] });
    assert.deepEqual(r, { correct: true, hits: ["Databricks", "Spark SQL", "30%"], misses: [], violations: [] });
  });

  test("a missing phrase makes it wrong and is listed under misses", () => {
    const r = score("I interned at Databricks.", { must_include: ["Databricks", "Spark SQL"] });
    assert.equal(r.correct, false);
    assert.deepEqual(r.hits, ["Databricks"]);
    assert.deepEqual(r.misses, ["Spark SQL"]);
  });

  test("a must_not_include phrase present makes it wrong even when every must_include hits", () => {
    const r = score("Databricks, Spark SQL, 30%. Also: apply to Stripe by October 31.", { must_include: ["Databricks", "Spark SQL", "30%"], must_not_include: ["Stripe", "Jane Street"] });
    assert.equal(r.correct, false);
    assert.deepEqual(r.misses, []);
    assert.deepEqual(r.violations, ["Stripe"]);
  });

  test("empty answer misses everything", () => {
    const r = score("", { must_include: ["a", "b"] });
    assert.equal(r.correct, false);
    assert.deepEqual(r.misses, ["a", "b"]);
  });
});
