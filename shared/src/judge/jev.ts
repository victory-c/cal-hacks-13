// JevJudge: TypeSafe AI's Jev over HTTP (POST /v1/systemone). The real judge for the demo.
//
// Verified against TypeSafe's API docs (docs.typesafe.ai/api/system-one.md, Sat 10/24):
//   request   { model, state, questions: { <name>: { type, instructions, criteria? } } }
//             noul   → instructions only (yes/no)
//             choice → criteria: { <option>: null } (1–255 options; the name is the meaning)
//             score  → criteria: [level 0, level 1, …] (1–10 levels)
//   response  { model, answers: { <name>: { type, noul } | { type, choice, confidence,
//             probabilities } | { type, score, confidence, legend, probabilities } }, usage }
// Our question ids ("keep:0", "label:0:deal") go out as q0, q1, … and are mapped back by index.
// A missing or malformed answer becomes a neutral default with a warning (../judge/answers.ts),
// never a crash, so thresholds fall on their safe side.

import { env } from "../env.ts";
import type { Answer, Judge, Question } from "../types/judge.ts";
import { assembleAnswers, isRecord } from "./answers.ts";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const TIMEOUT_MS = 20_000;
const MAX_CHOICES = 255;
const MAX_LEVELS = 10;
/** 429 (rate limited) and 529 (overloaded) are retried after these waits; anything else fails at once. */
const RETRY_WAITS_MS = [500, 1500];

type Wire =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, null> }
  | { type: "score"; instructions: string; criteria: string[] };

export class JevJudge implements Judge {
  readonly name = "jev" as const;
  private readonly apiKey: string;
  private readonly url: string;
  private readonly model: string;
  private readonly retryWaitsMs: number[];

  constructor(opts: { apiKey?: string; url?: string; model?: string; retryWaitsMs?: number[] } = {}) {
    const apiKey = opts.apiKey ?? env("JEV_API_KEY") ?? env("TYPESAFE_API_KEY");
    if (!apiKey) throw new Error("JevJudge: JEV_API_KEY is not set. Put your TypeSafe key in .env, or set JUDGE_PROVIDER=claude|fake.");
    this.apiKey = apiKey;
    this.url = opts.url ?? env("JEV_API_URL") ?? JEV_URL;
    this.model = opts.model ?? env("JEV_MODEL") ?? MODEL;
    this.retryWaitsMs = opts.retryWaitsMs ?? RETRY_WAITS_MS;
  }

  async ask(state: string, questions: Question[]): Promise<Answer[]> {
    if (questions.length === 0) return [];
    const wire: Record<string, Wire> = {};
    const capped: string[] = [];
    questions.forEach((q, i) => {
      const w = toWire(q);
      if (w.capped) capped.push(q.id);
      wire[`q${i}`] = w.wire;
    });
    if (capped.length) console.warn(`[judge] jev: only the first ${MAX_CHOICES} options sent for ${capped.join(", ")}`);

    const json = await this.post({ model: this.model, state, questions: wire });
    const answers = isRecord(json) ? json.answers : undefined;
    if (!isRecord(answers)) throw new Error(`JevJudge: response has no "answers" map: ${JSON.stringify(json).slice(0, 300)}`);
    const items = questions.map((q, i) => fromWire(q, answers[`q${i}`]));
    return assembleAnswers("jev", questions, items);
  }

  private async post(body: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new Error(`JevJudge: request to ${this.url} failed: ${errorMessage(err)}`, { cause: err });
      }
      const text = await res.text();
      if ((res.status === 429 || res.status === 529) && attempt < this.retryWaitsMs.length) {
        await new Promise((r) => setTimeout(r, this.retryWaitsMs[attempt]));
        continue;
      }
      if (!res.ok) throw new Error(`JevJudge: HTTP ${res.status} from ${this.url}: ${text.slice(0, 300)}`);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`JevJudge: non-JSON response from ${this.url}: ${text.slice(0, 300)}`);
      }
    }
  }
}

/** One of our questions in TypeSafe's shape. Options past the limit are dropped (options[0], the safe default, is kept). */
function toWire(q: Question): { wire: Wire; capped: boolean } {
  switch (q.type) {
    case "noul":
      return { wire: { type: "noul", instructions: q.text }, capped: false };
    case "choice": {
      const sent = sentOptions(q.options);
      return { wire: { type: "choice", instructions: q.text, criteria: Object.fromEntries(sent.map((o) => [o, null])) }, capped: sent.length < new Set(q.options).size };
    }
    case "score": {
      const levels = scoreLevels(q.min, q.max);
      return { wire: { type: "score", instructions: q.text, criteria: levels.map(String) }, capped: false };
    }
  }
}

function sentOptions(options: string[]): string[] {
  return [...new Set(options)].slice(0, MAX_CHOICES);
}

/** min..max as at most MAX_LEVELS evenly spaced levels (integers when the range allows). */
function scoreLevels(min: number, max: number): number[] {
  if (!(max > min)) return [min];
  const n = Math.min(MAX_LEVELS, Number.isInteger(min) && Number.isInteger(max) ? max - min + 1 : MAX_LEVELS);
  return Array.from({ length: n }, (_, i) => min + ((max - min) * i) / (n - 1));
}

/** TypeSafe's answer → the loose item assembleAnswers() reads (p, choice, distribution, value). */
function fromWire(q: Question, raw: unknown): unknown {
  if (!isRecord(raw)) return undefined;
  switch (q.type) {
    case "noul":
      return { id: q.id, p: raw.noul };
    case "choice": {
      const probabilities = isRecord(raw.probabilities) ? raw.probabilities : undefined;
      const picked = typeof raw.choice === "string" ? raw.choice : undefined;
      // Only an option we sent counts; anything else falls to the neutral default.
      if (picked === undefined || !sentOptions(q.options).includes(picked)) return { id: q.id };
      const p = picked !== undefined && typeof probabilities?.[picked] === "number" ? probabilities[picked] : raw.confidence;
      return { id: q.id, choice: picked, p, ...(probabilities ? { distribution: probabilities } : {}) };
    }
    case "score": {
      // score is a probability-weighted level index (0 … levels-1), possibly fractional.
      if (typeof raw.score !== "number" || !Number.isFinite(raw.score)) return { id: q.id };
      const levels = scoreLevels(q.min, q.max);
      const step = levels.length > 1 ? (q.max - q.min) / (levels.length - 1) : 0;
      return { id: q.id, value: q.min + raw.score * step };
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
