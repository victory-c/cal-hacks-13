// FakeJudge: deterministic, offline, labelled simulated. It is what runs with no API keys, and
// what tests use. Keyword hits stand in for "this sounds like something worth keeping".

import type { Answer, Judge, Question } from "../types/judge.ts";

const DEFAULT_KEYWORDS = ["built", "shipped", "decided", "chose", "deadline", "targeting", "prefer", "resume", "internship"];

export interface FakeJudgeOptions {
  /** Case-insensitive substrings that make a noul answer 0.8 instead of 0.3. */
  keywords?: string[];
  /** Wins whenever it returns an Answer; return undefined to fall through to the defaults. */
  override?: (q: Question, state: string) => Answer | undefined;
}

export class FakeJudge implements Judge {
  readonly name = "fake" as const;
  private readonly keywords: string[];
  private readonly override: FakeJudgeOptions["override"];

  constructor(opts: FakeJudgeOptions = {}) {
    this.keywords = (opts.keywords ?? DEFAULT_KEYWORDS).map((k) => k.toLowerCase());
    this.override = opts.override;
    console.info("[judge] fake judge: answers are simulated");
  }

  async ask(state: string, questions: Question[]): Promise<Answer[]> {
    const stateLower = state.toLowerCase();
    return questions.map((q) => this.override?.(q, state) ?? this.answer(q, stateLower));
  }

  private answer(q: Question, stateLower: string): Answer {
    switch (q.type) {
      case "noul": {
        const text = q.text.toLowerCase();
        const hit = this.keywords.some((k) => text.includes(k) || stateLower.includes(k));
        return { id: q.id, type: "noul", p: hit ? 0.8 : 0.3 };
      }
      case "choice": {
        const found = q.options.find((o) => stateLower.includes(o.toLowerCase()));
        return { id: q.id, type: "choice", choice: found ?? q.options[0] ?? "", p: 0.5 };
      }
      case "score":
        return { id: q.id, type: "score", value: (q.min + q.max) / 2 };
    }
  }
}
