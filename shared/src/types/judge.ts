// Jev contract. Jev answers typed questions with probabilities; our code applies the
// thresholds. Everything goes through `Judge` so swapping Jev for the Claude fallback is a
// config change (JUDGE_PROVIDER). Implementations live in ../judge/.
//
// Rule from CLAUDE.md: batch every candidate into ONE request (one `state`, many questions).

import type { Folder, GroupId, Tier } from "./fact.ts";

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
// Scopes: save-time triage, scope build, live update, handoff and routing questions (PRD "Where
// Jev decides"). Generous when saving (the cold archive is the safety net), strict when building
// scopes and handing over, cautious on exclusions and injection: a "maybe" counts as yes.
//
// The scope-build and handoff bars are calibrated on live Jev (one run on the demo world, Sat
// 10/24, Dollar Bill's rule "anything about pending deals"): Jev's P(yes) is not centred on 0.5,
// so a "maybe" sits where its scores for clearly-no and clearly-yes cases meet, not at 0.5.

export const TRIAGE_THRESHOLDS = {
  /** Save: "worth remembering?" Below this the item is archive-only (no fact). */
  KEEP: 0.35,
  /** Save: "which group?" A pick below this confidence, or "unsure", files the fact in `inbox` (moderators only). */
  GROUP_CONFIDENT: 0.6,
  /** Save: "instructions aimed at an AI?" At or above: quarantine the whole item. */
  INJECTION: 0.3,
  /**
   * Scope build: "does group g fall under this exclusion?" At or above, the whole group goes, in
   * code. Live Jev: deal/stonewall 0.75, every other group 0.38–0.43 (so 0.2 excluded them all).
   */
  EXCLUDE_GROUP: 0.6,
  /**
   * Scope build / live update: "does fact i fall under this exclusion?" Maybe counts as yes.
   * Live Jev: deal facts 0.58–0.83, everything else 0.14–0.35; the bar sits nearer the safe side.
   */
  EXCLUDE_FACT: 0.45,
  /** Scope build / live update: "does fact i help with this task?" Live Jev: relevant public facts 0.55–0.77, office admin 0.12–0.23. */
  IN_SCOPE: 0.5,
  /** Handoff: "does this request need stored context at all?" Live Jev: work questions 0.69–0.82, a haiku or a unit conversion 0.18–0.32. */
  NEEDS_CONTEXT: 0.5,
  /** Handoff: "does fact i help with this request?" Live Jev: the facts a question needs 0.62–0.91, the rest under 0.4. */
  RELEVANT: 0.6,
  /** Routing: "does running agent k need this new fact now?" */
  ROUTE_NEEDS: 0.6,
} as const;

/** How a new fact relates to the closest existing ones. Drives the version history. */
export const RELATIONS = ["same", "replaces", "adds_detail", "contradicts", "unrelated"] as const;
export type Relation = (typeof RELATIONS)[number];

/** Sentinel answers for the "which group?" choice, next to the existing group ids. */
export const GROUP_NEW = "new" as const;
export const GROUP_UNSURE = "unsure" as const;

/**
 * fact: write it in its group. archive_only: below the keep bar, raw stays in the cold archive.
 * quarantine: instructions aimed at an AI; nothing from the item joins any scope until a
 * moderator releases it. inbox: written to the `inbox` group (moderators only) because nobody
 * could place it; it joins no member scope, not even its author's, until a moderator files it.
 */
export type TriageOutcome = "fact" | "archive_only" | "quarantine" | "inbox";

/** Every save-time answer for one draft fact, plus what code did with them. */
export interface TriageDecision {
  outcome: TriageOutcome;
  keep_p: number;
  /** The group the fact was filed in (`inbox` when unsure). */
  group: GroupId;
  group_p: number;
  /** Jev picked "new": the proposed new group id, filed in `inbox` until a moderator accepts it. */
  new_group?: GroupId;
  labels: string[];
  /** Asked once per captured item; copied onto each of its drafts. */
  injection_p: number;
  relation: Relation;
  /** The existing fact it relates to, when relation is not "unrelated". */
  relation_to?: string;
  /** One line on why it landed where it did ("code: alias Falcon; jev deal/falcon 0.91"). Moderators only. */
  reason: string;
  judge: JudgeName;
}
