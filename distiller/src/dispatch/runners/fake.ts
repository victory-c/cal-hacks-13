// FakeRunner: deterministic, offline, labelled simulated. What runs with no FACTORY_API_KEY and
// no ANTHROPIC_API_KEY, and what tests use. Step 1 (the plan step) writes out/plan.md; the step
// that finishes (step 2 by default) writes out/result.md from brief.md, the fact files in facts/
// and the step's updates. No model runs, so nothing in out/ is analysis: it says so at the top.
// Like a real agent, it knows only what is in its folder.

import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FACT_ID_RE, parseFactFile } from "@canon/shared";
import { SANDBOX_FILES } from "../sandbox.ts";
import { CancelledError } from "./types.ts";
import type { Runner, StepRequest, StepResult } from "./types.ts";

/** Where the fake runtime writes its deliverable. */
export const FAKE_DELIVERABLE = "out/result.md";

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
    const facts = readFactFiles(req.dir);

    if (req.n < finishAt) {
      const plan = [
        "# Plan (simulated)",
        "",
        `1. Read brief.md and the ${facts.length} fact file${facts.length === 1 ? "" : "s"} in facts/.`,
        `2. Write the deliverable to ${FAKE_DELIVERABLE}.`,
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
      `# ${req.name}: ${req.task}`,
      "",
      "_Simulated: the fake runtime assembled this from brief.md and facts/. No model ran._",
      "",
      "## What my files say",
      "",
      ...(facts.length ? facts.map((f) => `- ${f.statement} (${f.id})`) : ["- My files hold no facts for this task."]),
      ...(updates.length ? ["", "## Updates received between steps", "", ...updates.map((u) => `- ${u}`)] : []),
      "",
    ].join("\n");
    writeFileSync(join(req.dir, FAKE_DELIVERABLE), body, "utf8");
    req.emit({ kind: "file", text: `wrote ${FAKE_DELIVERABLE}`, file: FAKE_DELIVERABLE });
    req.emit({ kind: "message", text: `Deliverable written from ${facts.length} fact file(s) (simulated)` });
    return { done: true, summary: `Wrote ${FAKE_DELIVERABLE} (simulated). DONE` };
  }
}

/** The fact files in <dir>/facts/, parsed, sorted by id. Unreadable or malformed files are skipped. */
export function readFactFiles(dir: string): Array<{ id: string; statement: string }> {
  const factsDir = join(dir, SANDBOX_FILES.facts);
  let names: string[];
  try {
    names = readdirSync(factsDir).filter((n) => n.endsWith(".md") && FACT_ID_RE.test(n.slice(0, -3)));
  } catch {
    return [];
  }
  const out: Array<{ id: string; statement: string }> = [];
  for (const name of names.sort()) {
    const p = join(factsDir, name);
    try {
      if (!lstatSync(p).isFile()) continue;
      const f = parseFactFile(readFileSync(p, "utf8"));
      out.push({ id: f.id, statement: f.statement });
    } catch {
      // not a fact file this runtime can read
    }
  }
  return out;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}
