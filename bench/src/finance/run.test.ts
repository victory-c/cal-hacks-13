// Integration tests for the finance CLI's exit status. They run the real entrypoint (src/finance/run.ts
// executes main() on import, so a subprocess is the honest way) with --dry: offline, echo responder,
// SIMULATED. Cells are made to fail deterministically with no network: a CANON_GRANTS_FILE that does
// not exist makes every setup that starts a world (all but no-memory) fail to open, which errors
// each of its cases.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { FinanceRunResult } from "./results.ts";

const RUN_TS = fileURLToPath(new URL("./run.ts", import.meta.url));
const CWD = fileURLToPath(new URL("../..", import.meta.url));
const scratch: string[] = [];

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function finance(broken: boolean, ...args: string[]): { status: number | null; out: string; run: FinanceRunResult } {
  const dir = mkdtempSync(join(tmpdir(), "bench-finance-"));
  scratch.push(dir);
  const r = spawnSync(process.execPath, ["--import", "tsx", RUN_TS, "--dry", "--include-examples", "--case", "task-00-example", "--out", dir, ...args], {
    cwd: CWD,
    encoding: "utf8",
    timeout: 120_000,
    // Existing env wins over .env, so empty values make the run independent of a developer's .env.
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "",
      JEV_API_KEY: "",
      TYPESAFE_API_KEY: "",
      MOSS_PROJECT_ID: "",
      MOSS_PROJECT_KEY: "",
      CANON_CLIENT_TOKENS: "",
      CANON_GRANTS_FILE: broken ? join(dir, "missing-grants.json") : "",
    },
  });
  const file = readdirSync(dir).find((f) => /^finance-\d.*\.json$/.test(f));
  assert.ok(file, `a run file is written even when cells fail:\n${r.stdout}\n${r.stderr}`);
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, run: JSON.parse(readFileSync(join(dir, file), "utf8")) as FinanceRunResult };
}

const errored = (run: FinanceRunResult) => run.cells.filter((c) => c.error).length;

describe("finance CLI exit status", { timeout: 300_000 }, () => {
  test("no cell fails: exits 0", () => {
    const r = finance(false, "--setup", "no-memory", "--setup", "shared-memory");
    assert.equal(r.status, 0, r.out);
    assert.equal(r.run.cells.length, 2);
    assert.equal(errored(r.run), 0);
    assert.doesNotMatch(r.out, /cells errored/);
  });

  test("some cells fail: exits 1 and still writes diagnostic results", () => {
    const r = finance(true);
    assert.equal(r.status, 1, r.out);
    assert.equal(r.run.cells.length, 4);
    assert.equal(errored(r.run), 3);
    assert.match(r.run.cells.find((c) => c.error)?.error ?? "", /failed to open/);
    assert.match(r.out, /3 of 4 cells errored.*incomplete/);
  });

  test("all cells fail: exits 1", () => {
    const r = finance(true, "--setup", "shared-memory", "--setup", "bullwark-claude");
    assert.equal(r.status, 1, r.out);
    assert.equal(errored(r.run), r.run.cells.length);
  });

  test("--allow-partial accepts some failed cells (exit 0) and still records the errors", () => {
    const r = finance(true, "--allow-partial");
    assert.equal(r.status, 0, r.out);
    assert.equal(errored(r.run), 3);
    assert.match(r.out, /partial run accepted/);
  });

  test("--allow-partial does not hide a run where every cell failed", () => {
    const r = finance(true, "--setup", "shared-memory", "--allow-partial");
    assert.equal(r.status, 1, r.out);
  });
});
