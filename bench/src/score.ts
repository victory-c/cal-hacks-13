// Pure scoring. Case-insensitive substring match on purpose: it is cheap, deterministic, and
// Edan can predict it while writing answer keys (no model-graded rubric that drifts between runs).

import type { AnswerKey, ScoreResult } from "./types.ts";

export function score(answerText: string, key: AnswerKey): ScoreResult {
  const hay = answerText.toLowerCase();
  const hits: string[] = [];
  const misses: string[] = [];
  for (const phrase of key.must_include) {
    (hay.includes(phrase.toLowerCase()) ? hits : misses).push(phrase);
  }
  const violations = (key.must_not_include ?? []).filter((phrase) => hay.includes(phrase.toLowerCase()));
  return { correct: misses.length === 0 && violations.length === 0, hits, misses, violations };
}
