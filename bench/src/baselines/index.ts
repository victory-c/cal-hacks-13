// The three baselines, as pluggable strategies. Each one turns a task into the context string
// that the responder will see; the runner then asks the same question the same way for all three.
//
//   no-memory     nothing: the fresh-session floor
//   full-history  every setup session pasted in: the "just paste it all" ceiling on tokens
//   canon         the slice canon_context hands back after capture + distill + Jev

import type { BenchTask } from "../types.ts";
import { CanonBaseline } from "./canon.ts";
import type { CanonOptions } from "./canon.ts";
import { FullHistoryBaseline } from "./full-history.ts";
import { NoMemoryBaseline } from "./no-memory.ts";

export type BaselineName = "no-memory" | "full-history" | "canon";
export const BASELINE_NAMES: readonly BaselineName[] = ["no-memory", "full-history", "canon"];

export interface Prepared {
  /** What gets injected ahead of the question. */
  context: string;
  /** estimateTokens(context): ~4 chars/token. The real count is the responder's usage.input_tokens. */
  tokens_injected_est: number;
  /** Wall-clock of producing the context (for canon: the canon_context call alone). */
  latency_ms: number;
  /** True when a stub stood in for a real component (fake judge, heuristic distiller). */
  simulated?: boolean;
  detail?: unknown;
}

export interface Baseline {
  readonly name: BaselineName;
  prepare(task: BenchTask): Promise<Prepared>;
}

export function isBaselineName(x: string): x is BaselineName {
  return (BASELINE_NAMES as readonly string[]).includes(x);
}

export function createBaseline(name: BaselineName, canon: CanonOptions = {}): Baseline {
  switch (name) {
    case "no-memory":
      return new NoMemoryBaseline();
    case "full-history":
      return new FullHistoryBaseline();
    case "canon":
      return new CanonBaseline(canon);
  }
}

export { CanonBaseline, FullHistoryBaseline, NoMemoryBaseline };
export type { CanonOptions };
