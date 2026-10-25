// judge(): one interface over Jev (the real thing), Claude (fallback) and a fake (offline).
//
// Rule from CLAUDE.md: batch every candidate into ONE judge.ask() call per decision, one `state`
// and many questions, never one call per candidate. Pick the provider with createJudge(); swapping
// is a config change (JUDGE_PROVIDER), not a code change.

import { env } from "../env.ts";
import type { Judge, JudgeName } from "../types/judge.ts";
import { ClaudeJudge } from "./claude.ts";
import { FakeJudge } from "./fake.ts";
import { JevJudge } from "./jev.ts";

export { ClaudeJudge, FakeJudge, JevJudge };
export type { FakeJudgeOptions } from "./fake.ts";

const JUDGE_NAMES: readonly JudgeName[] = ["jev", "claude", "fake"];

/**
 * Provider order: opts.provider, else JUDGE_PROVIDER, else "jev" when JEV_API_KEY (or TYPESAFE_API_KEY) is set, else
 * "claude" when ANTHROPIC_API_KEY is set, else "fake". Logs which one so the console says
 * "simulated" when it is.
 */
export function createJudge(opts: { provider?: JudgeName } = {}): Judge {
  const provider = resolveProvider(opts.provider);
  console.info(`[judge] provider: ${provider}${provider === "fake" ? " (simulated)" : ""}`);
  switch (provider) {
    case "jev":
      return new JevJudge();
    case "claude":
      return new ClaudeJudge();
    case "fake":
      return new FakeJudge();
  }
}

function resolveProvider(explicit?: JudgeName): JudgeName {
  const pick = explicit ?? env("JUDGE_PROVIDER");
  if (pick) {
    if (!JUDGE_NAMES.includes(pick as JudgeName)) {
      throw new Error(`JUDGE_PROVIDER must be one of ${JUDGE_NAMES.join("|")} (got "${pick}")`);
    }
    return pick as JudgeName;
  }
  if (env("JEV_API_KEY") || env("TYPESAFE_API_KEY")) return "jev";
  if (env("ANTHROPIC_API_KEY")) return "claude";
  return "fake";
}

/** Wall-clock a judge call (or anything async). Real measurement, never an estimate. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = performance.now();
  const result = await fn();
  return { result, ms: Math.round(performance.now() - t0) };
}
