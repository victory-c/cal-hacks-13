// FakeRunner: deterministic, offline, labelled simulated. What runs with no FACTORY_API_KEY and
// no ANTHROPIC_API_KEY, and what tests use. Step 1 writes out/plan.md; the step that finishes
// (step 2 by default) writes the role's deliverable from brief.md + facts.md + the step's
// updates. No model runs, so nothing in out/ is analysis: it says so at the top.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DELIVERABLES, ROLE_LABELS } from "../brief.ts";
import { SANDBOX_FILES } from "../sandbox.ts";
import { CancelledError } from "./types.ts";
import type { Runner, StepRequest, StepResult } from "./types.ts";

export interface FakeRunnerOptions {
  /** The step that writes the deliverable and says DONE. Default 2 (plan, then deliverable). */
  finishAt?: number;
  /** Wait this long per step, so lanes look live in the offline demo. Default 0. */
  delayMs?: number;
}

export class FakeRunner implements Runner {
  readonly name = "fake" as const;
  readonly simulated = true;
  private readonly finishAt: number;
  private readonly delayMs: number;

  constructor(opts: FakeRunnerOptions = {}) {
    this.finishAt = Math.max(1, opts.finishAt ?? 2);
    this.delayMs = opts.delayMs ?? 0;
  }

  async step(req: StepRequest): Promise<StepResult> {
    if (this.delayMs > 0) await sleep(this.delayMs, req.signal);
    if (req.signal.aborted) throw new CancelledError();
    const finishAt = Math.min(this.finishAt, req.maxSteps);
    const facts = readFactStatements(join(req.dir, SANDBOX_FILES.facts));

    if (req.n < finishAt) {
      const plan = [
        "# Plan (simulated)",
        "",
        `1. Read brief.md and facts.md (${facts.length} fact${facts.length === 1 ? "" : "s"}).`,
        `2. Write the deliverable to ${DELIVERABLES[req.role].file}.`,
        "3. Check that every line traces to a fact id or to the task.",
        "",
      ].join("\n");
      writeFileSync(join(req.dir, "out", "plan.md"), plan, "utf8");
      req.emit({ kind: "plan", text: "Plan written (simulated)" });
      req.emit({ kind: "file", text: "wrote out/plan.md", file: "out/plan.md" });
      return { done: false, summary: "Plan written (simulated). CONTINUE" };
    }

    const updates = req.prompt
      .split("\n")
      .filter((l) => l.startsWith("- [update]"))
      .map((l) => l.replace(/^- \[update\]\s*/, ""));
    const body = [
      `# ${ROLE_LABELS[req.role]}: ${req.task}`,
      "",
      "_Simulated: the fake runtime assembled this from brief.md and facts.md. No model ran._",
      "",
      "## What the facts say",
      "",
      ...(facts.length ? facts.map((f) => `- ${f.statement} (${f.id})`) : ["- No facts were handed over for this task."]),
      ...(updates.length ? ["", "## Updates received between steps", "", ...updates.map((u) => `- ${u}`)] : []),
      "",
    ].join("\n");
    const file = DELIVERABLES[req.role].file;
    writeFileSync(join(req.dir, file), body, "utf8");
    req.emit({ kind: "file", text: `wrote ${file}`, file });
    req.emit({ kind: "message", text: `Deliverable written from ${facts.length} facts (simulated)` });
    return { done: true, summary: `Wrote ${file} (simulated). DONE` };
  }
}

/** Reads back the first quoted line of each fact in facts.md (see sandbox.renderFacts). */
export function readFactStatements(path: string): Array<{ id: string; statement: string }> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: Array<{ id: string; statement: string }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^### \d+\. (\S+)$/.exec(lines[i]);
    if (!m) continue;
    const quoted = lines.slice(i + 1).find((l) => l.startsWith("> "));
    if (quoted) out.push({ id: m[1], statement: quoted.slice(2).trim() });
  }
  return out;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}
