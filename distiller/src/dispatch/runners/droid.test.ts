import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, test } from "node:test";

import { withEnv } from "../../test-helpers.ts";
import { createSandbox, unlockForCleanup } from "../sandbox.ts";
import { DroidRunner, mapDroidEvent } from "./droid.ts";
import { resolveRuntime } from "./index.ts";
import { CancelledError } from "./types.ts";
import type { StepEvent, StepRequest } from "./types.ts";

// A stand-in for Factory's `droid` binary: records its argv and env, writes out/note.md in its
// cwd and prints a stream-json run. FAKE_DROID_MODE picks the scenario.
const FAKE_DROID = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const cwd = args[args.indexOf("--cwd") + 1];
fs.writeFileSync(path.join(cwd, "..", "droid-call.json"), JSON.stringify({ args, pwd: process.cwd(), anthropic: process.env.ANTHROPIC_API_KEY ?? null, factory: process.env.FACTORY_API_KEY ?? null }));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const mode = process.env.FAKE_DROID_MODE || "ok";
if (mode === "fail") { process.stderr.write("Error: invalid API key\\n"); process.exit(1); }
console.log("droid v0.0.0-fake starting");
out({ type: "system", cwd, model: args[args.indexOf("-m") + 1], tools: ["Read", "Create", "Edit", "LS"] });
out({ type: "message", role: "user", text: "the prompt" });
out({ type: "message", role: "assistant", text: "Reading brief.md and facts.md." });
out({ type: "tool_call", toolName: "Read", parameters: { file_path: path.join(cwd, "facts.md") } });
out({ type: "tool_result", toolName: "Read", isError: false, value: "..." });
if (mode === "hang") { setTimeout(() => {}, 60000); return; }
fs.writeFileSync(path.join(cwd, "out", "note.md"), "# Sector note\\n");
out({ type: "tool_call", toolName: "Create", parameters: { file_path: path.join(cwd, "out", "note.md"), content: "# Sector note" } });
out({ type: "tool_result", toolName: "Create", isError: true, value: "permission check: blocked a network call" });
// Split one event across two writes to prove line buffering.
const done = JSON.stringify({ type: "completion", finalText: "Wrote out/note.md.\\nDONE", usage: { input_tokens: 1200, output_tokens: 340 } });
process.stdout.write(done.slice(0, 20));
setTimeout(() => process.stdout.write(done.slice(20) + "\\n"), 20);
`;

let bin: string;
let root: string;
before(() => {
  bin = mkdtempSync(join(tmpdir(), "canon-droid-bin-"));
  root = mkdtempSync(join(tmpdir(), "canon-droid-sb-"));
  writeFileSync(join(bin, "droid"), FAKE_DROID);
  chmodSync(join(bin, "droid"), 0o755);
});
after(() => {
  unlockForCleanup(root);
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

const withDroid = <T>(vars: Record<string, string | undefined>, fn: () => Promise<T>) =>
  withEnv({ PATH: `${bin}${delimiter}${process.env.PATH}`, FACTORY_API_KEY: "fk-test", ANTHROPIC_API_KEY: "sk-should-not-leak", DISPATCH_DROID_MODEL: undefined, ...vars }, fn);

function request(dir: string, events: StepEvent[], over: Partial<StepRequest> = {}): StepRequest {
  return {
    runId: "run_00000001",
    n: 1,
    maxSteps: 4,
    role: "research_analyst",
    side: "public",
    task: "Update our logistics sector note",
    dir,
    prompt: "You are Canon's research analyst agent. Step 1 of at most 4.",
    signal: new AbortController().signal,
    timeoutMs: 10_000,
    emit: (e) => events.push(e),
    ...over,
  };
}

describe("DroidRunner against a fake droid on PATH", () => {
  test("runs `droid exec --auto low -o stream-json --cwd <sandbox>` and parses the stream into steps", async () => {
    const sb = createSandbox("run_00000d01", { root });
    const events: StepEvent[] = [];
    const result = await withDroid({ FAKE_DROID_MODE: "ok" }, () => new DroidRunner().step(request(sb.dir, events)));

    const call = JSON.parse(readFileSync(join(root, "droid-call.json"), "utf8"));
    assert.deepEqual(call.args.slice(0, 8), ["exec", "--auto", "low", "-o", "stream-json", "--cwd", sb.dir, "-m"]);
    assert.equal(call.args[8], "claude-sonnet-5-5");
    assert.match(call.args[9], /^You are Canon's research analyst agent/);
    assert.equal(call.pwd.endsWith("run_00000d01"), true, "spawned in the sandbox");
    assert.equal(call.factory, "fk-test");
    assert.equal(call.anthropic, null, "Canon's other secrets never reach the agent");

    assert.deepEqual(
      events.map((e) => [e.kind, e.text, e.file]),
      [
        ["message", "Reading brief.md and facts.md.", undefined],
        ["tool", `Read ${join(sb.dir, "facts.md")}`, undefined],
        ["tool", `Create ${join(sb.dir, "out", "note.md")}`, undefined],
        ["file", "Create out/note.md", "out/note.md"],
        ["error", "tool error: permission check: blocked a network call", undefined],
        ["result", "Wrote out/note.md.\nDONE", undefined],
      ],
    );
    assert.deepEqual(events.at(-1)!.tokens, { input: 1200, output: 340 }, "real usage, as reported");
    assert.equal(result.done, true);
    assert.deepEqual(result.tokens, { input: 1200, output: 340 });
    assert.ok(existsSync(join(sb.outDir, "note.md")));
  });

  test("a non-zero exit is a failed step with droid's stderr", async () => {
    const sb = createSandbox("run_00000d02", { root });
    await withDroid({ FAKE_DROID_MODE: "fail" }, async () => {
      await assert.rejects(new DroidRunner().step(request(sb.dir, [])), /droid exec exited 1: Error: invalid API key/);
    });
  });

  test("cancel kills the process and throws CancelledError", async () => {
    const sb = createSandbox("run_00000d03", { root });
    const controller = new AbortController();
    const events: StepEvent[] = [];
    await withDroid({ FAKE_DROID_MODE: "hang" }, async () => {
      const p = new DroidRunner().step(request(sb.dir, events, { signal: controller.signal, emit: (e) => (events.push(e), e.kind === "tool" && controller.abort()) }));
      const t0 = Date.now();
      await assert.rejects(p, CancelledError);
      assert.ok(Date.now() - t0 < 5000);
    });
  });

  test("a step past its timeout is killed and fails", async () => {
    const sb = createSandbox("run_00000d04", { root });
    await withDroid({ FAKE_DROID_MODE: "hang" }, async () => {
      await assert.rejects(new DroidRunner().step(request(sb.dir, [], { timeoutMs: 300 })), /timed out after 300 ms/);
    });
  });

  test("needs the binary and FACTORY_API_KEY; the default runtime picks droid only when both are there", async () => {
    await withDroid({ FACTORY_API_KEY: undefined }, async () => {
      assert.throws(() => new DroidRunner(), /FACTORY_API_KEY is not set/);
      assert.equal(resolveRuntime(), "claude", "ANTHROPIC_API_KEY is set in this env");
    });
    await withEnv({ PATH: "/nonexistent", FACTORY_API_KEY: "fk-test", ANTHROPIC_API_KEY: undefined, DISPATCH_RUNTIME: undefined }, async () => {
      assert.throws(() => new DroidRunner(), /not on PATH/);
      assert.equal(resolveRuntime(), "fake");
    });
    await withDroid({ DISPATCH_RUNTIME: undefined }, async () => assert.equal(resolveRuntime(), "droid"));
    await withEnv({ DISPATCH_RUNTIME: "nope" }, async () => assert.throws(() => resolveRuntime(), /must be one of droid\|claude\|fake/));
  });
});

describe("mapDroidEvent (field names beyond type/toolName are read defensively)", () => {
  test("variants of message, tool_call, completion", () => {
    assert.deepEqual(mapDroidEvent({ type: "message", role: "assistant", content: [{ type: "text", text: "hi" }] }, "/sb").steps, [{ kind: "message", text: "hi" }]);
    assert.deepEqual(mapDroidEvent({ type: "message", message: { role: "user", content: "x" } }, "/sb").steps, []);
    assert.deepEqual(mapDroidEvent({ type: "tool_call", toolName: "Edit", input: { path: "out/a.md" } }, "/sb").steps, [
      { kind: "tool", text: "Edit out/a.md" },
      { kind: "file", text: "Edit out/a.md", file: "out/a.md" },
    ]);
    assert.deepEqual(mapDroidEvent({ type: "tool_call", toolName: "Execute", parameters: { command: "python3 model.py" } }, "/sb").steps, [{ kind: "tool", text: "Execute python3 model.py" }]);
    const done = mapDroidEvent({ type: "result", result: "ok\nDONE", usage: { inputTokens: 5, outputTokens: 6 } }, "/sb");
    assert.deepEqual(done.completion, { text: "ok\nDONE", tokens: { input: 5, output: 6 } });
    assert.equal(mapDroidEvent({ type: "completion", finalText: "x" }, "/sb").steps[0].tokens, undefined, "no usage, no tokens: never estimated");
  });
});
