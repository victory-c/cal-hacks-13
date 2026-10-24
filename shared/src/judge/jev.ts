// Official contract: https://docs.typesafe.ai/introduction/quickstart
// Questions and answers are keyed objects. Choice confidence is not P(choice): use probabilities.

import { env } from "../env.ts";
import type { Answer, Judge, Question } from "../types/judge.ts";
import { assembleAnswers, isRecord } from "./answers.ts";

const MODEL = "jev-latest";
const TIMEOUT_MS = 15_000;
export const DEFAULT_JEV_URL = "https://api.typesafe.ai/v1/systemone";

export function jevQuestions(questions: Question[]): Record<string, unknown> {
  return Object.fromEntries(questions.map((q) => [q.id, q.type === "noul"
    ? { type: "noul", instructions: q.text }
    : q.type === "choice"
      ? { type: "choice", instructions: q.text, criteria: Object.fromEntries(q.options.map((option) => [option, option])) }
      : { type: "score", instructions: q.text, criteria: [`Minimum (${q.min})`, `Maximum (${q.max})`] }]));
}

export class JevJudge implements Judge {
  readonly name = "jev" as const;
  private readonly apiKey: string;
  private readonly url: string;

  constructor(opts: { apiKey?: string; url?: string } = {}) {
    const apiKey = opts.apiKey ?? env("JEV_API_KEY");
    const url = opts.url ?? env("JEV_API_URL", DEFAULT_JEV_URL);
    if (!apiKey) throw new Error("JevJudge: JEV_API_KEY is not set. Put it in .env, or set JUDGE_PROVIDER=claude|fake.");
    this.apiKey = apiKey;
    this.url = url;
  }

  async ask(state: string, questions: Question[]): Promise<Answer[]> {
    if (questions.length === 0) return [];
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: MODEL, state, questions: jevQuestions(questions) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`JevJudge: request to ${this.url} failed: ${errorMessage(err)}`, { cause: err });
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`JevJudge: HTTP ${res.status} from ${this.url}: ${text.slice(0, 300)}`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`JevJudge: non-JSON response from ${this.url}: ${text.slice(0, 300)}`);
    }
    return assembleAnswers("jev", questions, extractItems(json, questions));
  }
}

/** The answer list may be the body itself or sit under "answers" / "results" / "data". */
function extractItems(json: unknown, questions: Question[]): unknown[] {
  if (Array.isArray(json)) return json;
  if (isRecord(json)) {
    if (isRecord(json.answers)) {
      const answers = json.answers;
      return questions.map((q) => {
        const answer = answers[q.id];
        if (!isRecord(answer)) return { id: q.id };
        if (q.type === "noul") return { id: q.id, p: answer.noul };
        if (q.type === "choice") {
          const probabilities = isRecord(answer.probabilities) ? answer.probabilities : {};
          return { id: q.id, choice: answer.choice, p: typeof answer.choice === "string" ? probabilities[answer.choice] : undefined, distribution: probabilities };
        }
        const score = typeof answer.score === "number" ? q.min + answer.score * (q.max - q.min) : undefined;
        return { id: q.id, value: score };
      });
    }
    for (const key of ["answers", "results", "data"]) {
      const v = json[key];
      if (Array.isArray(v)) return v;
    }
  }
  throw new Error(`JevJudge: response has no "answers" or "results" array: ${JSON.stringify(json).slice(0, 300)}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
