// Integration tests for the CLI's exit status. They run the real entrypoint (src/run.ts executes main()
// on import, so a subprocess is the honest way) with --dry: offline, echo responder, SIMULATED.
// A cell is made to fail deterministically with no network: the canon baseline throws "No token for
// client" before any request when CANON_CLIENT_TOKENS is empty.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { RunResult } from "./results.ts";

const RUN_TS = fileURLToPath(new URL("./run.ts", import.meta.url));
const CWD = fileURLToPath(new URL("..", import.meta.url));
const scratch: string[] = [];

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function bench(...args: string[]): { status: number | null; out: string; run: RunResult } {
  const dir = mkdtempSync(join(tmpdir(), "bench-run-"));
  scratch.push(dir);
  const r = spawnSync(process.execPath, ["--import", "tsx", RUN_TS, "--dry", "--include-example", "--task", "t00-example", "--out", dir, ...args], {
    cwd: CWD,
    encoding: "utf8",
    timeout: 60_000,
    // Existing env wins over .env, so empty values make the run independent of a developer's .env.
    env: { ...process.env, CANON_CLIENT_TOKENS: "", ANTHROPIC_API_KEY: "" },
  });
  const file = readdirSync(dir).find((f) => /^\d.*\.json$/.test(f));
  assert.ok(file, `a run file is written even when cells fail:\n${r.stdout}\n${r.stderr}`);
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, run: JSON.parse(readFileSync(join(dir, file), "utf8")) as RunResult };
}

const errored = (run: RunResult) => run.cells.filter((c) => c.error).length;

describe("bench CLI exit status", () => {
  test("no cell fails: exits 0", () => {
    const r = bench("--baseline", "no-memory", "--baseline", "full-history");
    assert.equal(r.status, 0, r.out);
    assert.equal(errored(r.run), 0);
    assert.doesNotMatch(r.out, /cells errored/);
  });

  test("some cells fail: exits 1 and still writes diagnostic results", () => {
    const r = bench();
    assert.equal(r.status, 1, r.out);
    assert.equal(r.run.cells.length, 3);
    assert.equal(errored(r.run), 1);
    assert.match(r.run.cells.find((c) => c.error)?.error ?? "", /No token for client/);
    assert.match(r.out, /1 of 3 cells errored.*incomplete/);
  });

  test("all cells fail: exits 1", () => {
    const r = bench("--baseline", "canon");
    assert.equal(r.status, 1, r.out);
    assert.equal(errored(r.run), r.run.cells.length);
  });

  test("--allow-partial accepts some failed cells (exit 0) and still records the error", () => {
    const r = bench("--allow-partial");
    assert.equal(r.status, 0, r.out);
    assert.equal(errored(r.run), 1);
    assert.match(r.out, /partial run accepted/);
  });

  test("--allow-partial does not hide a run where every cell failed", () => {
    const r = bench("--baseline", "canon", "--allow-partial");
    assert.equal(r.status, 1, r.out);
  });
});
