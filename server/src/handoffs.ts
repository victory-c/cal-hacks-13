// Handoff records for the inspector (INTEGRATION.md `Handoff`, the console's Handoffs tab): what
// each handoff considered, what it kept or cut and why, the tokens and the measured times.
// Appended to `<data dir>/world/handoffs.jsonl` as they happen and reloaded on start, so the
// inspector shows yesterday's handoffs too. The audit row (kind "handoff") stays the record of
// what was sent; this is the detail behind it.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ContractHandoff, ContractHandoffCandidate, Fact, HandoffCandidate } from "@canon/shared";

import { isRecord } from "./http.ts";
import { WORLD_DIR } from "./persist.ts";

/** The record is the contract's Handoff (INTEGRATION.md), so the inspector reads it as is. */
export type HandoffRecord = ContractHandoff;
export type HandoffRecordCandidate = ContractHandoffCandidate;

export interface HandoffInput {
  id: string;
  at: string;
  principal: string;
  client?: string;
  run_id?: string;
  request: string;
  candidates: readonly HandoffCandidate[];
  tokens: number;
  budget: number;
  latency_ms: number;
  retrieval_ms?: number;
  judge_ms?: number;
  simulated: boolean;
  inject_nothing: boolean;
}

const KEEP = 500;

/** Builds the inspector's record from a handoff's internals. `statementOf` resolves a fact id. */
export function toHandoffRecord(input: HandoffInput, statementOf: (id: string) => Fact | undefined): HandoffRecord {
  const candidates: HandoffRecordCandidate[] = input.candidates.map((c) => ({
    fact_id: c.fact_id,
    statement: statementOf(c.fact_id)?.statement ?? "",
    p: typeof c.p === "number" ? c.p : null,
    decision: c.cut === null ? "kept" : c.cut === "budget" ? "cut_budget" : "cut_relevance",
    tokens_est: c.tokens ?? 0,
  }));
  const record: HandoffRecord = {
    id: input.id,
    at: input.at,
    principal: input.principal,
    request: input.request,
    candidates,
    tokens_est: input.tokens,
    budget_est: input.budget,
    timings_ms: { search: input.retrieval_ms ?? null, judge: input.judge_ms ?? null, total: input.latency_ms },
    simulated: input.simulated,
    inject_nothing: input.inject_nothing,
  };
  if (input.client) record.client = input.client;
  if (input.run_id) record.run_id = input.run_id;
  return record;
}

export class Handoffs {
  private readonly records: HandoffRecord[] = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly file: string | undefined;

  /** With a data dir the records are appended to world/handoffs.jsonl; without one they live in memory (unit tests). */
  constructor(dataDir?: string) {
    this.file = dataDir ? join(dataDir, WORLD_DIR, "handoffs.jsonl") : undefined;
  }

  /** Reads what the last run left, newest last. Missing file: nothing. A torn line is skipped. */
  async load(): Promise<number> {
    if (!this.file) return 0;
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw err;
    }
    let n = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed) && typeof parsed.id === "string" && Array.isArray(parsed.candidates)) {
          this.records.push(parsed as unknown as HandoffRecord);
          n++;
        }
      } catch {
        console.warn(`[handoffs] skipping a torn line in ${this.file}`);
      }
    }
    if (this.records.length > KEEP) this.records.splice(0, this.records.length - KEEP);
    return n;
  }

  record(r: HandoffRecord): void {
    this.records.push(r);
    if (this.records.length > KEEP) this.records.shift();
    if (!this.file) return;
    const line = JSON.stringify(r) + "\n";
    const file = this.file;
    this.queue = this.queue
      .then(async () => {
        await mkdir(join(file, ".."), { recursive: true });
        await appendFile(file, line, "utf8");
      })
      .catch((err: unknown) => console.error(`[handoffs] append failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Newest first. `principals` narrows to those principals (a member sees their own agents'). */
  list(opts: { principals?: readonly string[]; limit?: number } = {}): HandoffRecord[] {
    const limit = opts.limit ?? 100;
    const out: HandoffRecord[] = [];
    for (let i = this.records.length - 1; i >= 0 && out.length < limit; i--) {
      const r = this.records[i];
      if (opts.principals && !opts.principals.includes(r.principal)) continue;
      out.push(r);
    }
    return out;
  }

  /** Waits for queued appends (shutdown). */
  drain(): Promise<void> {
    return this.queue;
  }
}
