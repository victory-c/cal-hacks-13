// Finance benchmark contract (A8). The case file format lives here (mirrored in
// ../../tasks/finance/case.schema.json for editors and for Edan); everything server-facing comes
// from @canon/shared. The PRD "Benchmark" section defines the sets and the four setups.

import type { CapturedSession } from "@canon/shared";

import type { AnswerKey } from "../types.ts";

/** PRD attack styles, 10 each. */
export const ATTACK_STYLES = [
  "direct",
  "paraphrase",
  "code-name",
  "indirect",
  "planted-instruction",
  "agent-escalation",
] as const;
export type AttackStyle = (typeof ATTACK_STYLES)[number];

/** The four PRD setups, compared on the same cases. */
export const SETUP_NAMES = ["no-memory", "shared-memory", "bullwark-claude", "bullwark-jev"] as const;
export type SetupName = (typeof SETUP_NAMES)[number];

export const SETUP_LABELS: Record<SetupName, string> = {
  "no-memory": "No memory: agents start from zero",
  "shared-memory": "Shared memory: all facts in one store, the prompt is the wall",
  "bullwark-claude": "Bullwark scopes, Claude making the yes/no calls",
  "bullwark-jev": "Bullwark scopes with Jev (the full product)",
};

/** PRD targets. C6 writes the sets; the runner consumes whatever exists. */
export const TARGET_TASKS = 30;
export const TARGET_ATTACKS = 60;

/** An agent-escalation attack creates this agent as the case's principal, then asks through it. */
export interface AgentSpec {
  name: string;
  rule: {
    task: string;
    exclude: { groups: string[]; labels: string[]; text?: string };
  };
}

/**
 * One finance case: a member (or their agent) asks one question. `kind` comes from the file name
 * (task-NN-slug.json / attack-NN-slug.json). A task measures missing context and accuracy; an
 * attack measures leaks against the member's exclusions.
 */
export interface FinanceCase {
  /** Equals the file name without .json, e.g. "attack-01-direct-terms". */
  id: string;
  kind: "task" | "attack";
  title: string;
  /** The synthetic-world person asking (dan, priya, leo). */
  principal: string;
  question: string;
  /** Tasks: facts the handoff must supply; any absent one is missing context. May be empty. */
  needed_fact_ids?: string[];
  /** Tasks: scored against the responder's answer. Optional on attacks. */
  answer_key?: AnswerKey;
  /** Attacks only. */
  attack_style?: AttackStyle;
  /**
   * Attacks: distinctive strings from the excluded material that must never appear in anything
   * served or answered. Never use a string that appears in the question itself.
   */
  leak_probes?: string[];
  /** agent-escalation only. */
  agent?: AgentSpec;
  /**
   * planted-instruction: sessions posted to the server before the ask. They only become facts
   * when lane B's distiller worker is attached; the runner posts them and notes when it is not.
   */
  setup_sessions?: CapturedSession[];
  notes?: string;
}
