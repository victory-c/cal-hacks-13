import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { INTERNAL_CLIENTS, REPO_ROOT, parseClientTokens } from "@canon/shared";

import { DEMO_CLIENTS, EXAMPLE_ID, TASKS_DIR, listTaskFiles, loadTasks, parseTask } from "./tasks.ts";

const fixtures = (name: string) => fileURLToPath(new URL(`./__fixtures__/${name}/`, import.meta.url));

describe("loadTasks", () => {
  test("loads a good task, cleans it, and warns about files that are not tasks", () => {
    const { tasks, warnings } = loadTasks({ dir: fixtures("good") });
    assert.equal(tasks.length, 1);
    const t = tasks[0];
    assert.equal(t.id, "t01-good-task");
    assert.equal(t.from_client, "claude-code");
    assert.equal(t.to_client, "chatgpt");
    assert.equal(t.folder, "career/projects");
    assert.equal(t.setup_sessions[0].messages.length, 2);
    assert.equal("notes" in t, false, "optionals are present only when set");
    assert.deepEqual(t.answer_key, { must_include: ["Canon"], must_not_include: ["Databricks"] });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /notes\.json: ignored/);
  });

  test("the shipped example validates, and runs only with includeExample", () => {
    const withExample = loadTasks({ dir: TASKS_DIR, includeExample: true });
    const example = withExample.tasks.find((t) => t.id === EXAMPLE_ID);
    assert.ok(example, "bench/tasks/t00-example.json must load");
    assert.equal(example.from_client, "chatgpt");
    assert.equal(example.to_client, "claude-code");
    assert.ok(example.answer_key.must_include.includes("Databricks"));
    assert.deepEqual(withExample.warnings, []);

    const without = loadTasks({ dir: TASKS_DIR });
    assert.equal(without.tasks.some((t) => t.id === EXAMPLE_ID), false);
  });

  test("bad files: one error listing every problem, each naming the file and the field", () => {
    assert.throws(
      () => loadTasks({ dir: fixtures("bad") }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        const m = e.message;
        assert.match(m, /^\d+ problems in /);
        assert.match(m, /t02-bad-fields\.json: id must equal the file name without \.json \("t02-bad-fields"\)/);
        assert.match(m, /t02-bad-fields\.json: title must be a non-empty string/);
        assert.match(m, /t02-bad-fields\.json: to_client must differ from from_client/);
        assert.match(m, /t02-bad-fields\.json: folder must be career \| projects \| team \| private/);
        assert.match(m, /t02-bad-fields\.json: setup_sessions\[0\]\.id must look like "ses_"/);
        assert.match(m, /t02-bad-fields\.json: setup_sessions\[0\]\.client must equal from_client \("chatgpt"\)/);
        assert.match(m, /t02-bad-fields\.json: setup_sessions\[0\]\.started_at must be an ISO 8601 timestamp/);
        assert.match(m, /t02-bad-fields\.json: setup_sessions\[0\]\.messages\[0\]\.role must be one of user \| assistant/);
        assert.match(m, /t02-bad-fields\.json: setup_sessions\[0\]\.messages\[0\]\.content must be a non-empty string/);
        assert.match(m, /t02-bad-fields\.json: answer_keys is not a known field .*Typo\?/);
        assert.match(m, /t02-bad-fields\.json: answer_key\.must_include must be a non-empty array/);
        assert.match(m, /t02-bad-fields\.json: answer_key\.must_not_include must be an array/);
        assert.match(m, /t02-bad-fields\.json: question must be a non-empty string/);
        assert.match(m, /t03-not-json\.json: is not valid JSON/);
        return true;
      },
    );
  });

  test("a session id reused across two task files is an error", () => {
    assert.throws(() => loadTasks({ dir: fixtures("dupes") }), /t05-dupe-b\.json: setup_sessions id "ses_04000001" is already used in t04-dupe-a\.json/);
  });

  test("listTaskFiles keeps task names, ignores others, skips task.schema.json silently", () => {
    const real = listTaskFiles(TASKS_DIR);
    assert.ok(real.files.includes("t00-example.json"));
    assert.equal(real.ignored.includes("task.schema.json"), false);
    const good = listTaskFiles(fixtures("good"));
    assert.deepEqual(good, { files: ["t01-good-task.json"], ignored: ["notes.json"] });
  });
});

describe("parseTask", () => {
  const base = {
    id: "t09-x",
    title: "t",
    from_client: "chatgpt",
    to_client: "claude-code",
    folder: "career",
    setup_sessions: [{ id: "ses_09000001", client: "chatgpt", started_at: "2026-10-20T18:30:00Z", messages: [{ role: "user", content: "hi" }] }],
    question: "q",
    answer_key: { must_include: ["a"] },
  };

  test("a client without a demo token is a warning, not an error", () => {
    const r = parseTask(JSON.stringify({ ...base, to_client: "copilot" }), "t09-x.json");
    assert.ok(r.ok);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /to_client "copilot" has no token on the demo server.*No token for client/);
    for (const c of ["chatgpt", "claude-code", "teammate-cursor"]) assert.ok(r.warnings[0].includes(c), `names ${c} as a client that does work`);
  });

  test("a KNOWN_CLIENTS entry without a demo token (claude-web) still warns", () => {
    // The canon baseline would throw at run time for this task; Edan should hear it at validate time.
    const r = parseTask(JSON.stringify({ ...base, from_client: "claude-web", setup_sessions: [{ ...base.setup_sessions[0], client: "claude-web" }] }), "t09-x.json");
    assert.ok(r.ok);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /from_client "claude-web" has no token on the demo server/);
  });

  test("the three demo clients do not warn", () => {
    for (const [from, to] of [["chatgpt", "claude-code"], ["claude-code", "teammate-cursor"], ["teammate-cursor", "chatgpt"]]) {
      const r = parseTask(JSON.stringify({ ...base, from_client: from, to_client: to, setup_sessions: [{ ...base.setup_sessions[0], client: from }] }), "t09-x.json");
      assert.ok(r.ok);
      assert.deepEqual(r.warnings, [], `${from} → ${to}`);
    }
  });

  test("DEMO_CLIENTS matches the tokens in .env.example (what the README and the warning promise)", () => {
    const line = readFileSync(join(REPO_ROOT, ".env.example"), "utf8").split("\n").find((l) => l.startsWith("CANON_CLIENT_TOKENS="));
    assert.ok(line, ".env.example must set CANON_CLIENT_TOKENS");
    const withTokens = [...parseClientTokens(line.slice("CANON_CLIENT_TOKENS=".length)).values()].filter((c) => !(INTERNAL_CLIENTS as readonly string[]).includes(c));
    assert.deepEqual([...DEMO_CLIENTS].sort(), withTokens.sort());
  });

  test("a non-object is rejected with a clear message", () => {
    const r = parseTask("[1,2]", "t09-x.json");
    assert.ok(!r.ok);
    assert.match(r.errors[0], /must be a JSON object/);
  });
});
