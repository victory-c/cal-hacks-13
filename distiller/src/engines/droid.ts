// DroidDistiller: the Factory Droid SDK engine (sponsor track). SDK wiring is pending blocker Q1
// ("Can the Factory Droid SDK run headless on our trigger?"), task B2. Until that is answered the
// class constructs (so engine selection works) and distill() fails loudly, never silently.
//
// Intended contract, agreed before the SDK is wired (do not guess the SDK API; fill this in from
// Factory's docs once Q1 is resolved):
//
//   Trigger   Every captured session (SSE session.captured, see worker.ts). Not a chat wrapper:
//             Droid runs headless on our event, with no human in the loop.
//   Input     The CapturedSession (messages + meta), the fact-file format from CLAUDE.md, and
//             the folder list (TOP_FOLDERS plus known subfolders) so it files facts correctly.
//   Output    { plan: string, drafts: DraftFact[] }. The plan is Droid's own description of what
//             it is about to keep and why; the dashboard shows it next to the fact diffs.
//   Write     Droid may only write the fact store, and only through our POST /api/facts (the
//             distiller token). It never touches disk, the cold archive or any other folder.
//             Jev still decides tier / folder / dedupe on every draft (decide.ts), so Droid
//             cannot bypass the save-time questions.
//   Failure   Any SDK error surfaces as a thrown Error with Factory's message; the worker logs it
//             and moves on to the next session. The heuristic engine never kicks in silently.

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
  // Kept for the SDK wiring; unused until then.
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
