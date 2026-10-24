import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, test } from "node:test";

import { REPO_ROOT } from "@canon/shared";
import { quiet, withEnv } from "../../test-helpers.ts";
import { createSandbox, realPath, unlockForCleanup } from "../sandbox.ts";
import { DroidRunner, agentEnv, mapDroidEvent, resolveOsSandbox, seatbeltProfile } from "./droid.ts";
import { resolveRuntime } from "./index.ts";
import { CancelledError, StepError } from "./types.ts";
import type { StepEvent, StepRequest } from "./types.ts";

// A stand-in for Factory's `droid` binary: records its argv, pid and env in its own folder, writes
// out/note.md and prints a stream-json run. It writes nothing outside its cwd. FAKE_DROID_MODE
// picks the scenario.
const FAKE_DROID = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const cwd = args[args.indexOf("--cwd") + 1];
fs.writeFileSync(path.join(cwd, "droid-call.json"), JSON.stringify({ args, pwd: process.cwd(), pid: process.pid, env: process.env }));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const mode = process.env.FAKE_DROID_MODE || "ok";
if (mode === "fail") { process.stderr.write("Error: invalid API key\\n"); process.exit(1); }
if (mode === "probe") {
  const seen = {};
  for (const p of JSON.parse(args[args.length - 1])) { try { fs.readFileSync(p); seen[p] = "read"; } catch (e) { seen[p] = e.code; } }
  fs.writeFileSync(path.join(cwd, "probe.json"), JSON.stringify(seen));
  out({ type: "completion", finalText: "DONE" });
  return;
}
if (mode === "tree" || mode === "leave") {
  // What a tool call that starts a script looks like: a child in droid's process group.
  const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(cwd, "tree.json"), JSON.stringify({ droid: process.pid, kid: kid.pid }));
  if (mode === "leave") { kid.unref(); out({ type: "completion", finalText: "DONE" }); return; }
}
console.log("droid v0.0.0-fake starting");
out({ type: "system", cwd, model: args[args.indexOf("-m") + 1], tools: ["Read", "Create", "Edit", "LS"] });
out({ type: "message", role: "user", text: "the prompt" });
out({ type: "message", role: "assistant", text: "Reading brief.md and facts/." });
out({ type: "tool_call", toolName: "Read", parameters: { file_path: path.join(cwd, "facts", "fct_0000f001.md") } });
out({ type: "tool_result", toolName: "Read", isError: false, value: "..." });
if (mode === "hang" || mode === "tree") { setTimeout(() => {}, 60000); return; }
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

// The worker's env carries the repo's path in several places (npm_*, INIT_CWD, PWD, PATH's
// node_modules/.bin); these stand in for them so the scrub is tested even under plain `node --test`.
const REPO_PATH_VARS = {
  CANON_DATA_DIR: join(REPO_ROOT, "data"),
  npm_package_json: join(REPO_ROOT, "distiller", "package.json"),
  INIT_CWD: REPO_ROOT,
};

const withDroid = <T>(vars: Record<string, string | undefined>, fn: () => Promise<T>) =>
  withEnv(
    {
      PATH: [bin, join(REPO_ROOT, "node_modules", ".bin"), process.env.PATH].join(delimiter),
      FACTORY_API_KEY: "fk-test",
      ANTHROPIC_API_KEY: "sk-should-not-leak",
      DISPATCH_DROID_MODEL: undefined,
      ...REPO_PATH_VARS,
      ...vars,
    },
    fn,
  );

/** The runner, its start-up log line silenced. Construct it inside withDroid (it reads PATH). */
const newRunner = () => quiet(() => new DroidRunner()).then((r) => r.result);

const seatbelt = resolveOsSandbox("auto") === "seatbelt";

/** False once `pid` is gone (polls: a just-killed orphan is reaped asynchronously). */
async function gone(pid: number, withinMs = 3000): Promise<boolean> {
  const until = Date.now() + withinMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function request(dir: string, events: StepEvent[], over: Partial<StepRequest> = {}): StepRequest {
  return {
    runId: "run_00000001",
    n: 1,
    maxSteps: 4,
    agent: "agt_priya_research",
    name: "Priya's research agent",
    task: "Update our logistics sector note",
    dir,
    prompt: "You are Priya's research agent, an agent in Bullwark. Step 1 of at most 4.",
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
    const result = await withDroid({ FAKE_DROID_MODE: "ok" }, async () => (await newRunner()).step(request(sb.dir, events)));

    const call = JSON.parse(readFileSync(join(sb.dir, "droid-call.json"), "utf8"));
    assert.deepEqual(call.args.slice(0, 8), ["exec", "--auto", "low", "-o", "stream-json", "--cwd", sb.dir, "-m"]);
    assert.equal(call.args[8], "claude-sonnet-5-5");
    assert.match(call.args[9], /^You are Priya's research agent, an agent in Bullwark/);
    assert.equal(call.pwd.endsWith("run_00000d01"), true, "spawned in the sandbox");
    assert.equal(call.env.FACTORY_API_KEY, "fk-test");
    assert.equal(call.env.ANTHROPIC_API_KEY, undefined, "Bullwark's other secrets never reach the agent");

    assert.deepEqual(
      events.map((e) => [e.kind, e.text, e.file]),
      [
        ["message", "Reading brief.md and facts/.", undefined],
        ["tool", `Read ${join(sb.dir, "facts", "fct_0000f001.md")}`, undefined],
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

  test("no env value that points into the repo or the data dir reaches droid; PATH keeps the rest; PWD is the sandbox", async () => {
    const sb = createSandbox("run_00000d06", { root });
    await withDroid({ FAKE_DROID_MODE: "ok" }, async () => (await newRunner()).step(request(sb.dir, [])));
    const { env } = JSON.parse(readFileSync(join(sb.dir, "droid-call.json"), "utf8")) as { env: Record<string, string> };
    const repo = [REPO_ROOT.replace(/[\\/]+$/, ""), realPath(REPO_ROOT)];
    const leaks = Object.entries(env).filter(([, v]) => repo.some((r) => v.includes(r)));
    assert.deepEqual(leaks, [], "the sandbox is outside the repo; no env var may hand the way back");
    for (const k of Object.keys(REPO_PATH_VARS)) assert.equal(env[k], undefined, k);
    assert.equal(env.PWD, sb.dir);
    assert.ok(env.PATH.split(delimiter).includes(bin), "PATH still finds the tools outside the repo");
  });

  test("agentEnv drops Bullwark's secrets and settings, values under hidden roots, and PATH entries inside them", () => {
    const e = agentEnv("/sb/run_1", { PATH: `/usr/bin${delimiter}/repo/node_modules/.bin${delimiter}/repo`, HOME: "/home/x", CANON_URL: "http://x", JEV_API_KEY: "k", NODE_OPTIONS: "--import /repo/x.js", FACTORY_API_KEY: "f" }, ["/repo"]);
    assert.deepEqual(e, { PATH: "/usr/bin", HOME: "/home/x", FACTORY_API_KEY: "f", PWD: "/sb/run_1" });
  });

  test("a non-zero exit is a failed step: the exit code is the public reason, stderr only in the message", async () => {
    const sb = createSandbox("run_00000d02", { root });
    await withDroid({ FAKE_DROID_MODE: "fail" }, async () => {
      const err = await (await newRunner()).step(request(sb.dir, [])).then(
        () => assert.fail("should fail"),
        (e: unknown) => e,
      );
      assert.ok(err instanceof StepError);
      assert.equal(err.publicReason, "droid exec exited 1");
      assert.match(err.message, /droid exec exited 1: Error: invalid API key/);
    });
  });

  test("cancel kills the process and throws CancelledError", async () => {
    const sb = createSandbox("run_00000d03", { root });
    const controller = new AbortController();
    const events: StepEvent[] = [];
    await withDroid({ FAKE_DROID_MODE: "hang" }, async () => {
      const p = (await newRunner()).step(request(sb.dir, events, { signal: controller.signal, emit: (e) => (events.push(e), e.kind === "tool" && controller.abort()) }));
      const t0 = Date.now();
      await assert.rejects(p, CancelledError);
      assert.ok(Date.now() - t0 < 5000);
    });
  });

  test("cancel kills droid's whole process tree, and the step settles only after droid has exited", async () => {
    const sb = createSandbox("run_00000d07", { root });
    const controller = new AbortController();
    await withDroid({ FAKE_DROID_MODE: "tree" }, async () => {
      const p = (await newRunner()).step(request(sb.dir, [], { signal: controller.signal, emit: (e) => e.kind === "tool" && controller.abort() }));
      await assert.rejects(p, CancelledError);
    });
    const { droid, kid } = JSON.parse(readFileSync(join(sb.dir, "tree.json"), "utf8")) as { droid: number; kid: number };
    assert.equal(await gone(droid, 0), true, "droid has exited before the cancel settles, so the folder never locks under it");
    assert.equal(await gone(kid), true, "what droid's tools started is killed too");
  });

  test("nothing droid started outlives a step that finished normally", async () => {
    const sb = createSandbox("run_00000d08", { root });
    const result = await withDroid({ FAKE_DROID_MODE: "leave" }, async () => (await newRunner()).step(request(sb.dir, [])));
    assert.equal(result.done, true);
    const { kid } = JSON.parse(readFileSync(join(sb.dir, "tree.json"), "utf8")) as { kid: number };
    assert.equal(await gone(kid), true);
  });

  test("a step past its timeout is killed and fails", async () => {
    const sb = createSandbox("run_00000d04", { root });
    await withDroid({ FAKE_DROID_MODE: "hang" }, async () => {
      await assert.rejects((await newRunner()).step(request(sb.dir, [], { timeoutMs: 300 })), /timed out after 300 ms/);
    });
  });

  test("macOS: under sandbox-exec droid cannot read the repo or another run's folder, only its own", { skip: seatbelt ? false : "sandbox-exec is not usable here" }, async () => {
    const sb = createSandbox("run_00000d09", { root });
    const sibling = createSandbox("run_00000d0a", { root });
    writeFileSync(join(sb.factsDir, "fct_00000001.md"), "mine");
    writeFileSync(join(sibling.factsDir, "fct_00000002.md"), "Falcon terms: another agent's scope");
    const targets = [join(REPO_ROOT, "package.json"), join(sibling.factsDir, "fct_00000002.md"), join(sb.factsDir, "fct_00000001.md")];
    await withDroid({ FAKE_DROID_MODE: "probe", DISPATCH_OS_SANDBOX: "on" }, async () => (await newRunner()).step(request(sb.dir, [], { prompt: JSON.stringify(targets) })));
    const seen = JSON.parse(readFileSync(join(sb.dir, "probe.json"), "utf8")) as Record<string, string>;
    assert.deepEqual(
      targets.map((t) => seen[t]),
      ["EPERM", "EPERM", "read"],
    );
  });

  test("seatbeltProfile denies the given roots and carves the run's own folder back out, last", () => {
    const p = seatbeltProfile(["/repo", "/tmp/agents"], ["/tmp/agents/run_1"]);
    assert.equal(
      p,
      [
        "(version 1)",
        "(allow default)",
        '(deny file-read* file-write* (subpath "/repo"))',
        '(deny file-read* file-write* (subpath "/tmp/agents"))',
        '(allow file-read* file-write* (subpath "/tmp/agents/run_1"))',
      ].join("\n"),
    );
    assert.throws(() => resolveOsSandbox("maybe"), /auto, on or off/);
    assert.equal(resolveOsSandbox("off"), "none");
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
