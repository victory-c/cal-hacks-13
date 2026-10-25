// Shared coercion for judge responses. Every network provider maps its raw output through here,
// so a missing or malformed answer never crashes a save: it becomes a neutral default marked unavailable, plus one
// console.warn naming the question ids. Access decisions must apply their fail-closed fallback.

import type { Answer, Question } from "../types/judge.ts";

type ChoiceAnswer = Extract<Answer, { type: "choice" }>;

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Keep neutral values for diagnostics; never treat an unavailable answer as a real probability. */
export function defaultAnswer(q: Question): Answer {
  switch (q.type) {
    case "noul":
      return { id: q.id, type: "noul", p: 0.5, unavailable: true };
    case "choice":
      return { id: q.id, type: "choice", choice: q.options[0] ?? "", p: 0.5, unavailable: true };
    case "score":
      return { id: q.id, type: "score", value: (q.min + q.max) / 2, unavailable: true };
  }
}

function num(...xs: unknown[]): number | undefined {
  for (const x of xs) {
    if (typeof x === "number" && Number.isFinite(x)) return x;
    if (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))) return Number(x);
  }
  return undefined;
}

function str(...xs: unknown[]): string | undefined {
  for (const x of xs) if (typeof x === "string" && x.trim() !== "") return x.trim();
  return undefined;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Reads one provider item as the answer to `q`. Accepts the field names we have seen or expect
 * (p / probability / confidence, choice / answer / option, value / score). Returns undefined
 * when nothing usable is there, including a choice that is not one of the options.
 */
export function coerceAnswer(q: Question, raw: unknown): Answer | undefined {
  if (!isRecord(raw)) return undefined;
  switch (q.type) {
    case "noul": {
      const p = num(raw.p, raw.probability, raw.confidence, raw.value);
      return p === undefined ? undefined : { id: q.id, type: "noul", p: clamp(p, 0, 1) };
    }
    case "choice": {
      const picked = str(raw.choice, raw.answer, raw.option);
      if (picked === undefined) return undefined;
      const choice = q.options.find((o) => o.toLowerCase() === picked.toLowerCase());
      if (choice === undefined) return undefined;
      const ans: ChoiceAnswer = { id: q.id, type: "choice", choice, p: clamp(num(raw.p, raw.probability, raw.confidence) ?? 0.5, 0, 1) };
      if (isRecord(raw.distribution)) {
        const dist: Record<string, number> = {};
        for (const [k, v] of Object.entries(raw.distribution)) {
          const n = num(v);
          if (n !== undefined) dist[k] = n;
        }
        if (Object.keys(dist).length) ans.distribution = dist;
      }
      return ans;
    }
    case "score": {
      const v = num(raw.value, raw.score, raw.answer);
      return v === undefined ? undefined : { id: q.id, type: "score", value: clamp(v, q.min, q.max) };
    }
  }
}

/**
 * Pairs raw items with questions by id (by position when no item carries an id) and fills
 * every gap with defaultAnswer(), warning once. Output order matches `questions`.
 */
export function assembleAnswers(judge: string, questions: Question[], items: unknown[]): Answer[] {
  const byId = new Map<string, unknown>();
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = str(item.id, item.question_id, item.question);
    if (id !== undefined) byId.set(id, item);
  }
  const missing: string[] = [];
  const answers = questions.map((q, i) => {
    const raw = byId.has(q.id) ? byId.get(q.id) : byId.size === 0 ? items[i] : undefined;
    const ans = coerceAnswer(q, raw);
    if (ans) return ans;
    missing.push(q.id);
    return defaultAnswer(q);
  });
  if (missing.length) console.warn(`[judge] ${judge}: no usable answer for ${missing.join(", ")}; using unavailable defaults`);
  return answers;
}
