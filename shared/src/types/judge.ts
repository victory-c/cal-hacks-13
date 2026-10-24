// Jev contract. Jev answers typed questions with probabilities; our code applies the
// thresholds. Everything goes through `Judge` so swapping Jev for the Claude fallback is a
// config change (JUDGE_PROVIDER). Implementations live in ../judge/.
//
// Rule from CLAUDE.md: batch every candidate into ONE request (one `state`, many questions).

import type { Folder, Tier } from "./fact.ts";
import type { Wall } from "./walls.ts";

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
  /** The full triage behind this decision. The handoff inspector and audit read it. */
  triage?: TriageDecision;
}

// ---------------------------------------------------------------------------------------------
// Finance: save-time triage, handoff, routing and exit-check questions (PRD "Where Jev decides").
// Generous when saving (the cold archive is the safety net), strict when handing over, cautious
// on anything security-related: a "maybe" on confidentiality or injection counts as yes.

export const TRIAGE_THRESHOLDS = {
  /** Save: "worth remembering?" Below this the item is archive-only (no fact). */
  KEEP: 0.35,
  /** Save: "looks like confidential deal information?" At or above: restricted until compliance says otherwise. */
  CONFIDENTIAL: 0.2,
  /** Save: "which deal?" A pick below this confidence is "unsure" and goes to the compliance queue. */
  DEAL_CONFIDENT: 0.6,
  /** Save: "instructions aimed at an AI?" At or above: quarantine the whole item. */
  INJECTION: 0.3,
  /** Handoff: "does this task need stored context at all?" Below: send only the pinned profile. */
  NEEDS_CONTEXT: 0.5,
  /** Handoff: "does fact i help?" Same bar as v1 RELEVANT. */
  RELEVANT: 0.7,
  /** Routing: "does agent k need this new fact?" */
  ROUTE_NEEDS: 0.6,
  /** Routing: "does it cancel agent k's work?" */
  ROUTE_CANCELS: 0.5,
  /** Exit check: "does this output point at a restricted deal, even indirectly?" */
  EXIT_LEAK: 0.2,
} as const;

/** How a new fact relates to the closest existing ones. Drives the version history. */
export const RELATIONS = ["same", "replaces", "adds_detail", "contradicts", "unrelated"] as const;
export type Relation = (typeof RELATIONS)[number];

/** Sentinel answers for the "which deal?" choice, next to the deal ids. */
export const DEAL_PUBLIC = "public" as const;
export const DEAL_UNSURE = "unsure" as const;

/**
 * fact: write it. archive_only: below the keep bar, raw stays in the cold archive.
 * quarantine: instructions aimed at an AI; nothing from the item is handed over until compliance
 * releases it. compliance: deal unsure (or two deals); written with the most restrictive wall it
 * could have and a label_unsure review item.
 */
export type TriageOutcome = "fact" | "archive_only" | "quarantine" | "compliance";

/** Every save-time answer for one draft fact, plus what code did with them. */
export interface TriageDecision {
  outcome: TriageOutcome;
  keep_p: number;
  confidential_p: number;
  /** A deal id, "public" or "unsure". */
  deal: string;
  deal_p: number;
  /** Asked once per captured item; copied onto each of its drafts. */
  injection_p: number;
  relation: Relation;
  /** The existing fact it relates to, when relation is not "unrelated". */
  relation_to?: string;
  /**
   * The wall code assigned (code rules + Jev, raise-only). For outcome "compliance" the fact is
   * written with no wall (unlabeled: nobody but compliance sees it) and this is the proposed wall
   * that goes on the label_unsure review item.
   */
  wall: Wall;
  wall_reason: string;
  judge: JudgeName;
}
