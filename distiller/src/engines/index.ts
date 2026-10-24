// Distiller engines: session in, draft facts out. Jev decides what happens to the drafts
// (decide.ts); an engine only proposes. Pick one with createDistiller(); swapping is config
// (DISTILLER), never a code change.

import { env } from "@canon/shared";
import type { CapturedSession, DistillEngine, DraftFact } from "@canon/shared";
import { ClaudeDistiller } from "./claude.ts";
import { DroidDistiller, NotConfiguredError } from "./droid.ts";
import { HeuristicDistiller } from "./heuristic.ts";

export { ClaudeDistiller, DroidDistiller, HeuristicDistiller, NotConfiguredError };

export interface DistillResult {
  drafts: DraftFact[];
  /** What the engine decided to keep and why. Droid's plan is the Factory-track proof on the dashboard. */
  plan?: string;
  /** True when no model was involved (heuristic). Shown as "simulated" in logs and UI. */
  simulated: boolean;
  /** Real token counts from the model's `usage` field, when an API was called. Never estimated. */
  usage?: { input_tokens: number; output_tokens: number };
}

export interface Distiller {
  readonly name: DistillEngine;
  distill(session: CapturedSession): Promise<DistillResult>;
}

const ENGINES: readonly DistillEngine[] = ["droid", "claude", "heuristic"];

/**
 * Engine order: opts.engine, else DISTILLER, else "claude" when ANTHROPIC_API_KEY is set, else
 * "heuristic". Logs which, and says "simulated" when it is. "droid" only when asked for by name:
 * in v2 FACTORY_API_KEY is the dispatcher's key, and Droid does not distill (see droid.ts).
 */
export function createDistiller(opts: { engine?: DistillEngine } = {}): Distiller {
  const engine = resolveEngine(opts.engine);
  console.info(`[distiller] engine: ${engine}${engine === "heuristic" ? " (simulated)" : ""}`);
  switch (engine) {
    case "droid":
      return new DroidDistiller();
    case "claude":
      return new ClaudeDistiller();
    case "heuristic":
      return new HeuristicDistiller();
  }
}

export function resolveEngine(explicit?: string): DistillEngine {
  const pick = explicit ?? env("DISTILLER");
  if (pick) {
    if (!ENGINES.includes(pick as DistillEngine)) {
      throw new Error(`DISTILLER must be one of ${ENGINES.join("|")} (got "${pick}")`);
    }
    return pick as DistillEngine;
  }
  if (env("ANTHROPIC_API_KEY")) return "claude";
  return "heuristic";
}
