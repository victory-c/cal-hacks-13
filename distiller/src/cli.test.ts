import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { PostFactsBody } from "@canon/shared";
import { readBody, serve } from "./test-helpers.ts";

const DISTILLER_DIR = fileURLToPath(new URL("..", import.meta.url));
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const SAMPLE = fileURLToPath(new URL("../fixtures/session.sample.json", import.meta.url));
const MEMO = fileURLToPath(new URL("../fixtures/world/falcon-process-memo.json", import.meta.url));

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

describe("cli", () => {
  test("offline it files against the world's groups by default, and says the judge is simulated", async () => {
    const run = await runCli([MEMO], {});
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /^groups {4}5 from .*fixtures\/world\/groups\.json: deal\/falcon, research\/logistics, market\/public, desk\/trading, firm\/ops$/m);
    assert.match(run.stdout, /^judge {5}fake \(simulated, finance rules\)/m);
    assert.match(run.stdout, /^ {2}\d+ +fact +deal\/falcon /m, "Dan's Falcon memo files to deal/falcon");
    assert.match(run.stdout, /\(ingest, memo, 1 messages, ended, origin unknown, author dan\)/);
  });

  test("--post refuses --groups: a posted result is filed in the server's groups only", async () => {
    // A local list could file facts in a group the server does not have, and against a server
    // without GET /api/groups it would skip the inbox fallback.
    const dir = mkdtempSync(join(tmpdir(), "distiller-cli-"));
    const groups = join(dir, "groups.json");
    writeFileSync(groups, JSON.stringify({ groups: [{ id: "firm/ops", description: "Ops" }] }));
    const hits: string[] = [];
    const { url, close } = await serve((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "no route" }));
    });
    try {
      const run = await runCli([SAMPLE, "--post", "--groups", groups], { CANON_URL: url });
      assert.notEqual(run.code, 0, "must fail");
      assert.match(run.stderr, /--groups cannot be used with --post/, run.stderr);
      assert.equal(run.stdout, "", "nothing triaged or printed");
      assert.deepEqual(hits, [], "refused before any request to the server");
    } finally {
      await close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--post against a server without GET /api/groups files every fact in inbox, never the fixture's groups", async () => {
    const posted: PostFactsBody[] = [];
    const { url, close } = await serve(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url?.startsWith("/api/facts")) res.writeHead(200).end(JSON.stringify({ facts: [] }));
      else if (req.method === "POST" && req.url === "/api/facts") {
        const body = JSON.parse(await readBody(req)) as PostFactsBody;
        posted.push(body);
        res.writeHead(200).end(JSON.stringify({ saved: body.facts.map((f) => f.fact.id), retired: [] }));
      } else res.writeHead(404).end(JSON.stringify({ error: "no route" }));
    });
    try {
      const run = await runCli([MEMO, "--post"], { CANON_URL: url });
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, /^groups {4}none \(the server gave no group list; --post never falls back to a local file\)$/m);
      assert.equal(posted.length, 1);
      assert.ok(posted[0].facts.length > 0);
      assert.ok(posted[0].facts.every((f) => f.fact.folder === "inbox" && f.fact.author === "dan"));
    } finally {
      await close();
    }
  });
});
