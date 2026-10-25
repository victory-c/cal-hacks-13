import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { readBody, serve, withEnv } from "../../test-helpers.ts";
import { createSandbox, unlockForCleanup } from "../sandbox.ts";
import { ClaudeRunner } from "./claude.ts";
import type { StepEvent, StepRequest } from "./types.ts";

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), "canon-claude-runner-"));
});
after(() => {
  unlockForCleanup(root);
  rmSync(root, { recursive: true, force: true });
});

/** A Messages API stand-in that replays `turns` in order and records every request body. */
async function fakeAnthropic(turns: unknown[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const headers: Array<Record<string, string | string[] | undefined>> = [];
  const srv = await serve(async (req, res) => {
    bodies.push(JSON.parse(await readBody(req)));
    headers.push(req.headers);
    const turn = turns[bodies.length - 1] ?? { content: [{ type: "text", text: "out of script" }], stop_reason: "end_turn" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(turn));
  });
  return { ...srv, bodies, headers };
}

const thinking = { type: "thinking", thinking: "", signature: "sig-abc" };

describe("ClaudeRunner tool loop", () => {
  test("lists, reads and writes under out/ only, round-trips thinking, sums real usage, ends on finish", async () => {
    const sb = createSandbox("run_00000c01", { root });
    writeFileSync(join(sb.factsDir, "fct_0000f001.md"), "---\nid: fct_0000f001\nstatement: Freight demand drives the note.\n---\n");
    const api = await fakeAnthropic([
      {
        content: [
          thinking,
          { type: "text", text: "Looking around." },
          { type: "tool_use", id: "tu_1", name: "list_files", input: { path: "." } },
          { type: "tool_use", id: "tu_2", name: "read_file", input: { path: "facts/fct_0000f001.md" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 500, output_tokens: 50 },
      },
      {
        content: [
          { type: "tool_use", id: "tu_3", name: "write_file", input: { path: "out/sector-note.md", content: "# Note\nFreight demand." } },
          { type: "tool_use", id: "tu_4", name: "write_file", input: { path: "../escape.md", content: "x" } },
          { type: "tool_use", id: "tu_5", name: "write_file", input: { path: "brief.md", content: "rewritten" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 700, output_tokens: 80 },
      },
      {
        content: [{ type: "tool_use", id: "tu_6", name: "finish", input: { summary: "Wrote the note.", done: true } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 800, output_tokens: 20 },
      },
    ]);
    const events: StepEvent[] = [];
    try {
      const req: StepRequest = {
        runId: "run_00000c01",
        n: 2,
        maxSteps: 4,
        agent: "agt_priya_research",
        name: "Priya's research agent",
        task: "Update our logistics sector note",
        dir: sb.dir,
        prompt: "Step 2 of at most 4.",
        signal: new AbortController().signal,
        timeoutMs: 10_000,
        emit: (e) => events.push(e),
      };
      const result = await withEnv({ ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: api.url }, () => new ClaudeRunner().step(req));

      assert.equal(result.done, true);
      assert.equal(result.summary, "Wrote the note.");
      assert.deepEqual(result.tokens, { input: 2000, output: 150 });
      assert.equal(readFileSync(join(sb.outDir, "sector-note.md"), "utf8"), "# Note\nFreight demand.");
      assert.equal(existsSync(join(root, "escape.md")), false);
      assert.equal(existsSync(join(sb.dir, "brief.md")), false, "writes outside out/ are refused");

      const first = api.bodies[0];
      assert.equal(first.model, "claude-sonnet-5-5");
      assert.deepEqual(first.tool_choice, { type: "auto" });
      assert.equal(first.temperature, undefined);
      assert.equal(first.fallbacks, "default");
      assert.ok((first.tools as Array<{ strict?: boolean }>).every((t) => t.strict === true));
      assert.equal(api.headers[0]["anthropic-version"], "2026-10-21");

      // Turn 2 carries turn 1's assistant content unchanged (thinking first) and both results in ONE user message.
      const msgs2 = api.bodies[1].messages as Array<{ role: string; content: unknown }>;
      assert.equal(msgs2.length, 3);
      assert.deepEqual((msgs2[1].content as unknown[])[0], thinking);
      const results2 = msgs2[2].content as Array<{ type: string; tool_use_id: string; is_error?: boolean; content: string }>;
      assert.deepEqual(
        results2.map((r) => [r.type, r.tool_use_id, r.is_error ?? false]),
        [
          ["tool_result", "tu_1", false],
          ["tool_result", "tu_2", false],
        ],
      );
      assert.match(results2[1].content, /Freight demand drives the note/);
      const results3 = (api.bodies[2].messages as Array<{ content: unknown }>)[4].content as Array<{ tool_use_id: string; is_error?: boolean; content: string }>;
      assert.deepEqual(
        results3.map((r) => [r.tool_use_id, r.is_error ?? false]),
        [
          ["tu_3", false],
          ["tu_4", true],
          ["tu_5", true],
        ],
      );
      assert.match(results3[1].content, /"\.\." is not allowed/);
      assert.match(results3[2].content, /only under out\//);

      assert.ok(events.some((e) => e.kind === "file" && e.file === "out/sector-note.md"));
      assert.ok(events.some((e) => e.kind === "error" && /write_file refused/.test(e.text)));
      assert.deepEqual(events.at(-1), { kind: "result", text: "Wrote the note.", tokens: { input: 2000, output: 150 } });
    } finally {
      await api.close();
    }
  });

  test("a refusal or HTTP error is a failed step, not a downgrade", async () => {
    const sb = createSandbox("run_00000c02", { root });
    const api = await fakeAnthropic([{ content: [], stop_reason: "refusal", stop_details: { category: "cyber" } }]);
    try {
      await withEnv({ ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: api.url }, async () => {
        const req = { runId: "r", n: 1, maxSteps: 2, agent: "agt_dan_deal", name: "Dan's deal analyst", task: "t", dir: sb.dir, prompt: "p", signal: new AbortController().signal, timeoutMs: 5000, emit: () => {} } as const;
        await assert.rejects(new ClaudeRunner().step({ ...req }), /declined \(category: cyber\)/);
      });
    } finally {
      await api.close();
    }
    await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => assert.throws(() => new ClaudeRunner(), /ANTHROPIC_API_KEY is not set/));
  });
});
