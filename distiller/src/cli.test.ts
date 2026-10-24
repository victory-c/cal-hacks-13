import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { serve } from "./test-helpers.ts";

const DISTILLER_DIR = fileURLToPath(new URL("..", import.meta.url));
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const SAMPLE = fileURLToPath(new URL("../fixtures/session.sample.json", import.meta.url));

/** Runs the CLI in a child process (it exits when done) and resolves with its exit code and output. */
function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", CLI, ...args],
      // Offline engine and judge, whatever .env says: this test never calls a model.
      { cwd: DISTILLER_DIR, env: { ...process.env, DISTILLER: "heuristic", JUDGE_PROVIDER: "fake", ...env }, timeout: 30_000 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }),
    );
  });
}

describe("cli --post", () => {
  test("refuses --deals / --lists: a posted result is labeled with the server's deals and lists only", async () => {
    // A local world that names no deal would let the CLI label facts public and file them in
    // team/, where a server without the finance routes checks folders, not walls.
    const dir = mkdtempSync(join(tmpdir(), "distiller-cli-"));
    const deals = join(dir, "deals.json");
    const lists = join(dir, "lists.json");
    writeFileSync(deals, JSON.stringify({ deals: [] }));
    writeFileSync(lists, JSON.stringify({ restricted: [], watch: [] }));
    const hits: string[] = [];
    const { url, close } = await serve((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "no route" }));
    });
    try {
      for (const flags of [["--deals", deals, "--lists", lists], ["--deals", deals], ["--lists", lists]]) {
        const run = await runCli([SAMPLE, "--post", ...flags], { CANON_URL: url });
        assert.notEqual(run.code, 0, `${flags.join(" ")}: must fail`);
        assert.match(run.stderr, /--deals and --lists cannot be used with --post/, run.stderr);
        assert.equal(run.stdout, "", "nothing triaged or printed");
      }
      assert.deepEqual(hits, [], "refused before any request to the server");
    } finally {
      await close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
