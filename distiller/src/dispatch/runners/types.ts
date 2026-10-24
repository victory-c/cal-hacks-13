// The Runner contract every agent runtime implements (droid.ts, claude.ts, fake.ts). A run is a
// few short invocations ("steps"); a Runner does exactly one step in the sandbox folder and
// streams what it did as StepEvents, which the dispatcher publishes as agent.step events (the
// dashboard lane and the audit record). Kept apart from index.ts so the runners import it
// without a cycle.

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { AgentRuntime, StepKind } from "@canon/shared";

export interface StepEvent {
  kind: StepKind;
  text: string;
  /** kind "file": path relative to the sandbox. */
  file?: string;
  /** Real token counts the runtime reported. Never estimated. */
  tokens?: { input: number; output: number };
}

export interface StepRequest {
  runId: string;
  /** 1-based step within the current folder: 1 is the plan step (again after a restart). */
  n: number;
  maxSteps: number;
  /** The agent's principal id and display name. */
  agent: string;
  name: string;
  /** The task from the agent's scope rule. Never its exclusions. */
  task: string;
  /** Absolute path of the sandbox folder: the runtime's working directory. */
  dir: string;
  /** What this step should do (built by the dispatcher; includes inbox updates). */
  prompt: string;
  /** Aborted on cancel: the runner stops (kills its process) and throws CancelledError. */
  signal: AbortSignal;
  timeoutMs: number;
  emit: (e: StepEvent) => void;
}

export interface StepResult {
  /** The agent says the deliverable in out/ is complete. */
  done: boolean;
  summary: string;
  tokens?: { input: number; output: number };
}

export interface Runner {
  readonly name: AgentRuntime;
  readonly simulated: boolean;
  step(req: StepRequest): Promise<StepResult>;
}

export class CancelledError extends Error {
  constructor(message = "cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

/**
 * A step that failed for a reason safe to show on every lane (an exit code, a timeout).
 * `message` adds the detail (droid's stderr, which may quote what the agent did) for the worker
 * log only; the run's reason uses `publicReason`.
 */
export class StepError extends Error {
  constructor(
    readonly publicReason: string,
    detail?: string,
  ) {
    super(detail ? `${publicReason}: ${detail}` : publicReason);
    this.name = "StepError";
  }
}

/** The last non-empty line says DONE (finished). CONTINUE or anything else: not finished. */
export function saysDone(text: string): boolean {
  const last = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  return last !== undefined && /^[*_`\s]*DONE[*_`.!\s]*$/i.test(last);
}

/** Absolute path of an executable named `bin` on PATH, or undefined. */
export function onPath(bin: string, pathVar = process.env.PATH ?? ""): string | undefined {
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** Sum of two optional token counts; undefined only when both are. */
export function addTokens(
  a: { input: number; output: number } | undefined,
  b: { input: number; output: number } | undefined,
): { input: number; output: number } | undefined {
  if (!a) return b;
  if (!b) return a;
  return { input: a.input + b.input, output: a.output + b.output };
}
