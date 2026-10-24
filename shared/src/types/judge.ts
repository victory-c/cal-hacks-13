// Jev contract. Jev answers typed questions with probabilities; our code applies the
// thresholds. Everything goes through `Judge` so swapping Jev for the Claude fallback is a
// config change (JUDGE_PROVIDER). Implementations live in ../judge/.
//
// Rule from CLAUDE.md: batch every candidate into ONE request (one `state`, many questions).

import type { Folder, Tier } from "./fact.ts";

export type JudgeName = "jev" | "claude" | "fake";

export type Question =
  /** Yes/no. Jev calls this type "Noul". Answer is P(yes). */
  | { id: string; type: "noul"; text: string }
  /** Pick one option. Answer is the choice plus its probability. */
  | { id: string; type: "choice"; text: string; options: string[] }
  /** A number in [min, max]. */
  | { id: string; type: "score"; text: string; min: number; max: number };

export type Answer =
  | { id: string; type: "noul"; p: number }
  | { id: string; type: "choice"; choice: string; p: number; distribution?: Record<string, number> }
  | { id: string; type: "score"; value: number };

export interface Judge {
  readonly name: JudgeName;
  /** `state` is the context Jev reasons over (the fact, the task, the candidates). */
  ask(state: string, questions: Question[]): Promise<Answer[]>;
}

/** Thresholds from CLAUDE.md. FOLDER_CONFIDENT is ours: below it a fact goes to the inbox. */
export const THRESHOLDS = {
  KEEP_HOT: 0.6,
  RELEVANT: 0.7,
  FOLDER_CONFIDENT: 0.5,
} as const;

export type SaveAction = "add" | "merge" | "supersede";

/** What the save-time questions decided for one draft fact. Stored on the fact.saved event. */
export interface SaveDecision {
  tier: Tier;
  folder: Folder;
  action: SaveAction;
  /** Set when action is "supersede" (or "merge": the fact we merged into). */
  supersedes?: string;
  keep_p: number;
  folder_p: number;
  judge: JudgeName;
}
