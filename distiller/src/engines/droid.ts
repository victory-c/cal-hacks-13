// DroidDistiller: a placeholder kept so DISTILLER=droid still parses. In v2 Factory Droid does not
// distill. It runs the dispatched agents instead (PRD v2 "Agents and dispatch", WORK_SPLIT lane
// B item 4): lane B's dispatcher gives each agent a sandbox folder, runs `droid exec` at a low
// permission level, keeps an inbox between runs and streams every step as an agent.step event.
// That is the Factory track. Claude writes the facts (claude.ts), and the heuristic engine stands
// in offline.
//
// Behaviour is unchanged from v1: the class constructs when FACTORY_API_KEY is set (so engine
// selection works) and distill() fails loudly, never silently. createDistiller() no longer picks
// it on its own; only an explicit DISTILLER=droid does (see index.ts). FACTORY_API_KEY is now
// there for the dispatcher, and picking it up here would stop the distiller.

import { env } from "@canon/shared";
import type { CapturedSession } from "@canon/shared";
import type { Distiller, DistillResult } from "./index.ts";

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

export class DroidDistiller implements Distiller {
  readonly name = "droid" as const;
  // Kept so the constructor still checks the key; unused, since Droid does not distill in v2.
  protected readonly apiKey: string;

  constructor(opts: { apiKey?: string } = {}) {
    const apiKey = opts.apiKey ?? env("FACTORY_API_KEY");
    if (!apiKey) throw new Error("DroidDistiller: FACTORY_API_KEY is not set. Put it in .env, or set DISTILLER=claude|heuristic.");
    this.apiKey = apiKey;
  }

  async distill(_session: CapturedSession): Promise<DistillResult> {
    throw new NotConfiguredError("Droid SDK wiring pending: blocker Q1 (headless Droid), task B2");
  }
}
