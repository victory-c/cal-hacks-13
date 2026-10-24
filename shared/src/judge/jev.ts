// JevJudge: TypeSafe AI's Jev over HTTP. The real judge for the demo.
//
// UNVERIFIED: the request shape (`model` + `state` + `questions`) and the response mapping below
// come from the early-access notes, not from docs. Blocker Q3 in status.json tracks getting
// TypeSafe's docs. When they arrive, fix this file and nothing else: callers only see `Judge`.
// Until then the response is read defensively (see ../judge/answers.ts) and anything missing
// becomes a neutral default with a warning, never a crash.

import { env } from "../env.ts";
import type { Answer, Judge, Question } from "../types/judge.ts";
import { assembleAnswers, isRecord } from "./answers.ts";

const MODEL = "jev-latest";
const TIMEOUT_MS = 5000;

export class JevJudge implements Judge {
  readonly name = "jev" as const;
  private readonly apiKey: string;
  private readonly url: string;

  constructor(opts: { apiKey?: string; url?: string } = {}) {
    const apiKey = opts.apiKey ?? env("JEV_API_KEY");
    const url = opts.url ?? env("JEV_API_URL");
    if (!apiKey) throw new Error("JevJudge: JEV_API_KEY is not set. Put it in .env, or set JUDGE_PROVIDER=claude|fake.");
    if (!url) throw new Error("JevJudge: JEV_API_URL is not set. Put the endpoint from TypeSafe's docs in .env.");
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
        body: JSON.stringify({ model: MODEL, state, questions }),
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
    return assembleAnswers("jev", questions, extractItems(json));
  }
}

/** The answer list may be the body itself or sit under "answers" / "results" / "data". */
function extractItems(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (isRecord(json)) {
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
