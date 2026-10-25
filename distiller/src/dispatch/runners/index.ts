// Agent runtimes: pick one with DISPATCH_RUNTIME (droid | claude | fake). Unset: droid when the
// `droid` binary is on PATH and FACTORY_API_KEY is set, else claude when ANTHROPIC_API_KEY is
// set, else fake (simulated). The choice is made once at start and logged. A runtime that fails
// is a failed run, never a silent downgrade to another runtime.

import { AGENT_RUNTIMES, env } from "@canon/shared";
import type { AgentRuntime } from "@canon/shared";
import { ClaudeRunner } from "./claude.ts";
import { DroidRunner } from "./droid.ts";
import { FakeRunner } from "./fake.ts";
import { onPath } from "./types.ts";
import type { Runner } from "./types.ts";

export { ClaudeRunner, DroidRunner, FakeRunner };
export * from "./types.ts";

export function resolveRuntime(explicit?: string): AgentRuntime {
  const pick = explicit ?? env("DISPATCH_RUNTIME");
  if (pick) {
    if (!(AGENT_RUNTIMES as readonly string[]).includes(pick)) {
      throw new Error(`DISPATCH_RUNTIME must be one of ${AGENT_RUNTIMES.join("|")} (got "${pick}")`);
    }
    return pick as AgentRuntime;
  }
  if (onPath("droid") && env("FACTORY_API_KEY")) return "droid";
  if (env("ANTHROPIC_API_KEY")) return "claude";
  return "fake";
}

/** Throws when the picked runtime cannot run here (no binary, no key): fail loudly at start. */
export function createRunner(runtime: AgentRuntime): Runner {
  switch (runtime) {
    case "droid":
      return new DroidRunner();
    case "claude":
      return new ClaudeRunner();
    case "fake":
      return new FakeRunner();
  }
}
