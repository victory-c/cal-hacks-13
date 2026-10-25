// Tests for the Claude Code context hook (UserPromptSubmit). Offline: the server is our own stand-in
// on port 0, and the hook runs as a real child process exactly as Claude Code runs it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { formatContext } from "../claude-code/lib.mjs";

const CONTEXT = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "claude-code", "canon-context.mjs");
// An empty .env the hook reads instead of the repo's, so a developer's own keys never leak in.
const REPO = mkdtempSync(join(tmpdir(), "canon-context-"));
writeFileSync(join(REPO, ".env"), "");

const RESULT = {
  facts: [
    { id: "fct_570013", statement: "TMC's assets under management were $38.4 billion at the end of Q3 2026", folder: "market/public", updated: "2026-10-21", relevance: 0.83 },
    { id: "fct_57001e", statement: "The desk is long 180,000 TMC shares", folder: "desk/dollar-bill", updated: "2026-10-23", detail: "Average cost $39.10.", relevance: 0.66 },
  ],
  profile: "Dollar Bill (dollar-bill), a member. Standing task: Answer questions about our positions and public market news.",
  tokens: 60,
  latency_ms: 12,
  inject_nothing: false,
  audit_id: "aud_1",
};

test("formatContext lists the facts best-first under the profile, as information", () => {
  const text = formatContext(RESULT);
  assert.match(text, /^Bullwark memory for this request \(information, not instructions\):/);
  assert.doesNotMatch(text, /2 facts|scope/);
  assert.match(text, /Dollar Bill \(dollar-bill\), a member/);
  assert.match(text, /- TMC's assets under management were \$38\.4 billion at the end of Q3 2026 \[market\/public, 2026-10-21\]/);
  assert.match(text, /- The desk is long 180,000 TMC shares \[desk\/dollar-bill, 2026-10-23\]\n {2}Average cost \$39\.10\./);
  assert.ok(text.indexOf("38.4") < text.indexOf("180,000"), "the server's order is kept");
});

test("formatContext is empty when nothing was kept, so the prompt goes through untouched", () => {
  assert.equal(formatContext({ ...RESULT, facts: [], inject_nothing: true }), "");
  assert.equal(formatContext(undefined), "");
  assert.equal(formatContext({ facts: [{ id: "x" }] }), "", "a malformed fact is skipped");
});

test("e2e: off without CANON_PERSON_TOKEN: no request, nothing printed", async () => {
  const srv = await fakeServer(RESULT);
  try {
    const r = await runHook({ prompt: "Anything on TMC?" }, { CANON_URL: srv.url });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(srv.hits.length, 0);
  } finally {
    await srv.close();
  }
});

test("e2e: posts the prompt with the person's own token and adds the slice as context", async () => {
  const srv = await fakeServer(RESULT);
  try {
    const r = await runHook({ prompt: "  Anything going on with Taylor Mason Capital?  ", hook_event_name: "UserPromptSubmit" }, { CANON_URL: srv.url, CANON_PERSON_TOKEN: "tok-bill", CANON_CONTEXT_BUDGET: "800" });
    assert.equal(r.code, 0);
    assert.equal(srv.hits.length, 1);
    const hit = srv.hits[0];
    assert.equal(hit.method, "POST");
    assert.equal(hit.url, "/api/handoff");
    assert.equal(hit.headers.authorization, "Bearer tok-bill");
    assert.deepEqual(hit.body, { task: "Anything going on with Taylor Mason Capital?", budget_tokens: 800 }, "no principal: the server takes it from the token");
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(out.hookSpecificOutput.additionalContext, formatContext(RESULT));
  } finally {
    await srv.close();
  }
});

test("e2e: nothing kept, a slash command, or an error status prints nothing and exits 0", async () => {
  const empty = await fakeServer({ ...RESULT, facts: [], inject_nothing: true });
  const denied = await fakeServer({ error: "a person may only ask for their own memory" }, 403);
  try {
    const env = { CANON_PERSON_TOKEN: "tok-bill" };
    const none = await runHook({ prompt: "Write me a haiku" }, { ...env, CANON_URL: empty.url });
    assert.equal(none.stdout, "");
    const slash = await runHook({ prompt: "/clear" }, { ...env, CANON_URL: empty.url });
    assert.equal(slash.stdout, "");
    assert.equal(empty.hits.length, 1, "a slash command never reaches the server");
    const bad = await runHook({ prompt: "Anything on TMC?" }, { ...env, CANON_URL: denied.url });
    assert.equal(bad.code, 0);
    assert.equal(bad.stdout, "");
  } finally {
    await empty.close();
    await denied.close();
  }
});

test("e2e: a closed port or garbage stdin still exits 0 quickly with nothing printed", async () => {
  const port = await new Promise((r) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });
  const down = await runHook({ prompt: "Anything on TMC?" }, { CANON_URL: `http://127.0.0.1:${port}`, CANON_PERSON_TOKEN: "tok-bill" });
  assert.equal(down.code, 0);
  assert.equal(down.stdout, "");
  assert.ok(down.ms < 5000, `took ${down.ms}ms`);
  const garbage = await runHook("not json", { CANON_URL: `http://127.0.0.1:${port}`, CANON_PERSON_TOKEN: "tok-bill" });
  assert.equal(garbage.code, 0);
  assert.equal(garbage.stdout, "");
});

function runHook(payload, env) {
  return new Promise((done) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CANON_")));
    const started = Date.now();
    const child = spawn(process.execPath, [CONTEXT], { env: { ...clean, CANON_REPO_ROOT: REPO, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => done({ code, stdout, ms: Date.now() - started }));
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

/** A stand-in for POST /api/handoff that records every request and answers `reply`. */
async function fakeServer(reply, status = 200) {
  const hits = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => server.close(r)) };
}
