import assert from "node:assert/strict";
import { test } from "node:test";

import { cutToBudget, estimateTokens, factTokens } from "./tokens.ts";

test("estimateTokens is ~4 chars per token, rounded up", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("x".repeat(400)), 100);
});

test("factTokens counts statement plus detail", () => {
  assert.equal(factTokens({ statement: "x".repeat(40) }), 10);
  assert.equal(factTokens({ statement: "x".repeat(40), detail: "y".repeat(8) }), 12);
});

test("cutToBudget keeps items in order until the next would overflow", () => {
  const items = [
    { id: 1, statement: "a".repeat(40) }, // 10
    { id: 2, statement: "b".repeat(80), detail: "c".repeat(40) }, // 30
    { id: 3, statement: "d".repeat(20) }, // 5: 40 + 5 > 42, so the cut happens here
    { id: 4, statement: "e".repeat(4) }, // 1: would fit, but order is kept and the cut is final
  ];
  const r = cutToBudget(items, 42);
  assert.deepEqual(r.kept.map((i) => i.id), [1, 2]);
  assert.equal(r.tokens, 40);

  assert.deepEqual(cutToBudget(items, 1500).kept.map((i) => i.id), [1, 2, 3, 4]);
  assert.deepEqual(cutToBudget(items, 0), { kept: [], tokens: 0 });
  assert.deepEqual(cutToBudget([], 100), { kept: [], tokens: 0 });
});
