// Tests for the Claude Code capture hook. Fast and offline: the HTTP server is our own on
// port 0, the hook runs as a real child process exactly as Claude Code would run it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { KIND, MESSAGE_MAX, buildSession, gitInfo, makeTitle, normalizePrincipal, parseTranscript, readDotEnv, sessionIdFor, stripHarness } from "../claude-code/lib.mjs";
import { capturePath, commandFor, mergeSettings, snippet, writeSettings } from "../claude-code/install.mjs";

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CAPTURE = join(HOOKS_DIR, "claude-code", "canon-capture.mjs");
const INSTALL = join(HOOKS_DIR, "claude-code", "install.mjs");
const TRANSCRIPT = join(HOOKS_DIR, "fixtures", "transcript.jsonl");
const PAYLOAD = JSON.parse(readFileSync(join(HOOKS_DIR, "fixtures", "stop-payload.json"), "utf8"));
// The fixture path is relative to hooks/ so `npm run smoke -w hooks` works; tests need absolute.
PAYLOAD.transcript_path = resolve(HOOKS_DIR, PAYLOAD.transcript_path);

const transcriptText = readFileSync(TRANSCRIPT, "utf8");
const FIXTURE_LINES = transcriptText.trim().split("\n").length;
// 14 lines → 4 messages (one per turn): tool_result-only, isMeta, sidechain, attachment, system and summary
// lines are dropped, and the assistant lines between two user prompts merge into one message.
const EXPECTED_MESSAGES = 4;

// ---------- lib: parseTranscript ----------

test("fixture is a realistic 10–14 line transcript", () => {
  assert.ok(FIXTURE_LINES >= 10 && FIXTURE_LINES <= 14, `got ${FIXTURE_LINES} lines`);
});

test("parseTranscript keeps user/assistant turns, one message per turn", () => {
  const msgs = parseTranscript(transcriptText);
  assert.equal(msgs.length, EXPECTED_MESSAGES);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.match(msgs[0].content, /^Build the Claude Code capture hook/);
  assert.equal(msgs[0].at, "2026-10-24T03:12:05.000Z");
  assert.match(msgs.at(-1).content, /Decided to post on Stop and SessionEnd/);
  for (const m of msgs) assert.ok(typeof m.at === "string", "timestamp kept");
});

test("parseTranscript summarises tools per turn and skips tool_result/isMeta/sidechain", () => {
  const msgs = parseTranscript(transcriptText);
  assert.match(msgs[1].content, /\[tools: Read, Write\]$/);
  assert.match(msgs[3].content, /\[tools: Edit\]$/);
  const all = msgs.map((m) => m.content).join("\n---\n");
  assert.doesNotMatch(all, /File created successfully/, "tool_result content leaked");
  assert.doesNotMatch(all, /local-command-caveat/, "isMeta line leaked");
  assert.doesNotMatch(all, /SIDECHAIN/, "isSidechain line leaked");
  assert.doesNotMatch(all, /turn_duration/, "system line leaked");
  assert.doesNotMatch(all, /INJECTED_MEMORY/, "injected memory must not be captured as a new fact");
});

test("parseTranscript joins text blocks, drops thinking, survives bad lines", () => {
  const lines = [
    "not json at all",
    JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "a" }, { type: "text", text: "b" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } }),
    JSON.stringify({ type: "user", message: { content: "   " } }),
    "",
  ].join("\n");
  const msgs = parseTranscript(lines);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].content, "a\n\nb");
  assert.equal(msgs[0].at, undefined);
  assert.deepEqual(parseTranscript(""), []);
});

// Shapes copied from a real Claude Code 2.1 transcript: the prompt arrives as text blocks with a
// <system-reminder> block in front, slash commands echo as tagged user lines, and one assistant
// turn is spread over a line per block with tool_result user lines in between.
test("parseTranscript handles real Claude Code transcript shapes", () => {
  const j = (o) => JSON.stringify(o);
  const lines = [
    j({ type: "user", timestamp: "2026-10-24T08:00:00.000Z", message: { content: [
      { type: "text", text: "<system-reminder>\nYou are operating in a git worktree.\n</system-reminder>" },
      { type: "text", text: "Ship the capture hook and test it on a real session" },
    ] } }),
    j({ type: "user", isMeta: true, message: { content: "# Workflow authoring reference\n..." } }),
    j({ type: "assistant", timestamp: "2026-10-24T08:00:02.000Z", message: { id: "m1", content: [{ type: "thinking", thinking: "plan" }] } }),
    j({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", name: "Bash", input: {} }] } }),
    j({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
    j({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", name: "Bash", input: {} }, { type: "tool_use", name: "Edit", input: {} }] } }),
    j({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
    j({ type: "assistant", message: { id: "m3", content: [{ type: "text", text: "Captured. Decided to merge each turn into one message." }] } }),
    j({ type: "attachment", attachment: {} }),
    j({ type: "user", message: { content: "<command-name>/model</command-name>\n  <command-message>model</command-message>\n  <command-args>opus</command-args>" } }),
    j({ type: "user", message: { content: "<local-command-stdout>Set model to opus</local-command-stdout>" } }),
    j({ type: "user", timestamp: "2026-10-24T08:05:00.000Z", message: { content: "<system-reminder>note</system-reminder>\nNow open the PR" } }),
  ].join("\n");
  const msgs = parseTranscript(lines);
  assert.deepEqual(msgs, [
    { role: "user", content: "Ship the capture hook and test it on a real session", at: "2026-10-24T08:00:00.000Z" },
    { role: "assistant", content: "Captured. Decided to merge each turn into one message.\n\n[tools: Bash ×2, Edit]", at: "2026-10-24T08:00:02.000Z" },
    { role: "user", content: "Now open the PR", at: "2026-10-24T08:05:00.000Z" },
  ]);
});

test("stripHarness removes injected tags; long messages are capped", () => {
  assert.equal(stripHarness("<task-notification>done</task-notification>\n\n\n\nhi"), "hi");
  assert.equal(stripHarness("keep <b>this</b>"), "keep <b>this</b>", "only harness tags are stripped");
  const long = JSON.stringify({ type: "user", message: { content: "x".repeat(MESSAGE_MAX + 50) } });
  const [msg] = parseTranscript(long);
  assert.ok(msg.content.endsWith("…[truncated]"));
  assert.ok(msg.content.length <= MESSAGE_MAX + 20);
});

// ---------- lib: ids, titles, session ----------

test("sessionIdFor is stable and matches the contract's SESSION_ID_RE", () => {
  const id = sessionIdFor(PAYLOAD.session_id);
  assert.match(id, /^ses_[0-9a-f]{8}$/);
  assert.match(id, /^ses_[0-9a-f]{4,}$/);
  assert.equal(id, sessionIdFor(PAYLOAD.session_id));
  assert.notEqual(id, sessionIdFor("another-session"));
});

test("makeTitle collapses whitespace and cuts at 80 chars", () => {
  assert.equal(makeTitle("  hello\n  world  "), "hello world");
  const long = makeTitle("x".repeat(200));
  assert.equal(long.length, 80);
  assert.equal(makeTitle("short"), "short");
});

test("buildSession fills the CapturedSession shape; ended_at only on SessionEnd", () => {
  const messages = parseTranscript(transcriptText);
  const git = { repo: "victory-c/canon", branch: "b/hook" };

  const live = buildSession({ payload: PAYLOAD, messages, hookEvent: "Stop", git });
  assert.equal(live.client, "claude-code");
  assert.equal(live.id, sessionIdFor(PAYLOAD.session_id));
  assert.equal(live.started_at, messages[0].at);
  assert.equal(live.ended_at, undefined);
  assert.ok(live.title.length <= 80);
  assert.match(live.title, /^Build the Claude Code capture hook/);
  assert.equal(live.messages.length, EXPECTED_MESSAGES);
  assert.deepEqual(live.meta, { cwd: PAYLOAD.cwd, repo: "victory-c/canon", branch: "b/hook", hook_event: "Stop" });

  const ended = buildSession({ payload: PAYLOAD, messages, hookEvent: "SessionEnd", git: {} });
  assert.ok(typeof ended.ended_at === "string" && !Number.isNaN(Date.parse(ended.ended_at)));
  assert.equal(ended.meta.hook_event, "SessionEnd");
  assert.equal("repo" in ended.meta, false, "undefined meta keys are dropped");

  const empty = buildSession({ payload: { session_id: "s" }, messages: [], hookEvent: "Stop" });
  assert.ok(!Number.isNaN(Date.parse(empty.started_at)), "falls back to now");
  assert.equal(empty.title, undefined);
});

test("buildSession v2: kind is always ai_session; principal only when set, trimmed and lowercased", () => {
  const messages = parseTranscript(transcriptText);
  const anon = buildSession({ payload: PAYLOAD, messages, hookEvent: "Stop" });
  assert.equal(anon.kind, "ai_session");
  assert.equal(anon.kind, KIND);
  assert.equal(anon.external, false);
  assert.equal("principal" in anon, false, "no principal key when CANON_PRINCIPAL is unset");

  const dan = buildSession({ payload: PAYLOAD, messages, hookEvent: "Stop", principal: " Dan " });
  assert.equal(dan.principal, "dan");
  assert.equal(dan.kind, "ai_session");
  for (const blank of ["", "   ", undefined, 42]) {
    assert.equal("principal" in buildSession({ payload: PAYLOAD, messages, principal: blank }), false, `principal ${JSON.stringify(blank)}`);
  }
  assert.equal(normalizePrincipal("agt_research_1"), "agt_research_1");
});

// The same table is in extension/src/shared/session.test.ts: the hook, the ingest CLI and the
// extension write one id the same way. Security rule: the principal decides access, so a name or
// an email is never turned into an id (its first token made "Leo Chen" Leo Brandt, and gave Dan
// the ids "okafor" and "d"); only an id is kept, and an agent id is kept whole.
test("normalizePrincipal: only an id is kept; names and emails are not guessed into one", () => {
  const table = [
    [" Dan ", "dan"],
    ["dan", "dan"],
    ["Dollar-Bill", "dollar-bill"],
    ["agt_research_1", "agt_research_1"],
    ["AGT_Research_1", "agt_research_1"],
    ["agt_deal-analyst", "agt_deal-analyst"],
    ["AGT_Deal-Analyst", "agt_deal-analyst"],
    ["agt-desk-2", undefined],
    ["Dan Okafor", undefined],
    ["dan.okafor@harborlane.com", undefined],
    ["Dan Okafor <DAN.OKAFOR@harborlane.com>", undefined],
    ["Leo Chen <leo.chen@harborlane.com>", undefined],
    ["Okafor, Dan", undefined],
    ["D. Okafor", undefined],
    ["Maya (Compliance)", undefined],
    ["   ", undefined],
    ["42", undefined],
  ];
  for (const [input, want] of table) assert.equal(normalizePrincipal(input), want, JSON.stringify(input));
  assert.notEqual(normalizePrincipal("agt_deal-analyst"), normalizePrincipal("agt_desk-2"), "two agents, two ids");
  assert.equal("principal" in buildSession({ payload: PAYLOAD, messages: [], principal: "Dan Okafor" }), false, "a name in CANON_PRINCIPAL sends no principal");
  assert.equal(buildSession({ payload: PAYLOAD, messages: [], principal: "agt_deal-analyst" }).principal, "agt_deal-analyst");
});

// ---------- lib: readDotEnv, gitInfo ----------

test("readDotEnv parses the flat .env format and ignores noise", () => {
  const dir = mkdtempSync(join(tmpdir(), "canon-hook-"));
  const file = join(dir, ".env");
  writeFileSync(
    file,
    [
      "# comment",
      "",
      "CANON_URL=http://localhost:4100   # inline comment",
      "CANON_TOKEN_CLAUDE_CODE=dev-claude-code",
      'QUOTED="with # hash inside"',
      "export EXPORTED=yes",
      "EMPTY=",
      "not a valid line",
    ].join("\n"),
  );
  assert.deepEqual(readDotEnv(file), {
    CANON_URL: "http://localhost:4100",
    CANON_TOKEN_CLAUDE_CODE: "dev-claude-code",
    QUOTED: "with # hash inside",
    EXPORTED: "yes",
    EMPTY: "",
  });
  assert.deepEqual(readDotEnv(join(dir, "missing.env")), {});
});

test("gitInfo never throws: {} outside a repo, an object inside one", () => {
  assert.deepEqual(gitInfo(mkdtempSync(join(tmpdir(), "canon-nogit-"))), {});
  assert.deepEqual(gitInfo(undefined), {});
  const here = gitInfo(HOOKS_DIR);
  assert.equal(typeof here, "object");
  if (here.branch !== undefined) assert.equal(typeof here.branch, "string");
});

// ---------- end to end: canon-capture.mjs as a child process ----------

/** Runs the hook exactly as Claude Code does: payload on stdin, env, exit code back. */
function runHook(payload, env) {
  return new Promise((done) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CANON_")));
    const started = Date.now();
    const child = spawn(process.execPath, [CAPTURE], { env: { ...clean, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => done({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Our stand-in for the Canon server: records every request, answers like POST /api/sessions. */
async function fakeServer() {
  const hits = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: hits.at(-1).body?.id, updated: hits.length > 1 }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  return { url, hits, close };
}

test("e2e: Stop payload → POST /api/sessions with bearer token and the parsed session", async () => {
  const srv = await fakeServer();
  try {
    const r = await runHook(PAYLOAD, { CANON_URL: srv.url, CANON_TOKEN_CLAUDE_CODE: "test-token", CANON_DEBUG: "1" });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "", "stdout must stay empty: Claude Code reads it as a hook decision");
    assert.equal(r.stderr.trim().split("\n").length, 1, `one debug line expected:\n${r.stderr}`);
    assert.match(r.stderr, /→ 200/);

    assert.equal(srv.hits.length, 1);
    const [hit] = srv.hits;
    assert.equal(hit.method, "POST");
    assert.equal(hit.url, "/api/sessions");
    assert.equal(hit.headers.authorization, "Bearer test-token");
    assert.equal(hit.headers["content-type"], "application/json");
    assert.equal(hit.body.id, sessionIdFor(PAYLOAD.session_id));
    assert.equal(hit.body.client, "claude-code");
    assert.equal(hit.body.messages.length, EXPECTED_MESSAGES);
    assert.equal(hit.body.ended_at, undefined);
    assert.equal(hit.body.meta.hook_event, "Stop");
    assert.equal(hit.body.meta.cwd, PAYLOAD.cwd);
  } finally {
    await srv.close();
  }
});

test("e2e: SessionEnd payload carries ended_at", async () => {
  const srv = await fakeServer();
  try {
    const r = await runHook({ ...PAYLOAD, hook_event_name: "SessionEnd", reason: "other" }, {
      CANON_URL: srv.url,
      CANON_TOKEN_CLAUDE_CODE: "test-token",
    });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "", "silent without CANON_DEBUG");
    assert.equal(srv.hits.length, 1);
    assert.ok(typeof srv.hits[0].body.ended_at === "string");
    assert.equal(srv.hits[0].body.meta.hook_event, "SessionEnd");
  } finally {
    await srv.close();
  }
});

test("e2e: person token is shared by capture and context; capture source stays Claude Code and the server binds the principal", async () => {
  const srv = await fakeServer();
  const root = mkdtempSync(join(tmpdir(), "canon-person-"));
  writeFileSync(join(root, ".env"), "CANON_PERSON_TOKEN=person-dotenv\nCANON_PRINCIPAL=someone-else\nCANON_TOKEN_CLAUDE_CODE=operator\n");
  try {
    await runHook(PAYLOAD, { CANON_URL: srv.url, CANON_REPO_ROOT: root });
    assert.equal(srv.hits[0].headers.authorization, "Bearer person-dotenv");
    assert.equal(srv.hits[0].body.client, "claude-code");
    assert.equal(srv.hits[0].body.external, false);
    assert.equal("principal" in srv.hits[0].body, false);
    await runHook(PAYLOAD, { CANON_URL: srv.url, CANON_REPO_ROOT: root, CANON_PERSON_TOKEN: "person-process" });
    assert.equal(srv.hits[1].headers.authorization, "Bearer person-process");
  } finally { await srv.close(); }
});

test("e2e: rejected captures print the server explanation in debug mode", async () => {
  const server = createHttpServer((req, res) => {
    req.resume();
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "principal requires a person or ingest token" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await runHook(PAYLOAD, { CANON_URL: `http://127.0.0.1:${server.address().port}`, CANON_DEBUG: "1" });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /403.*principal requires a person or ingest token/);
    assert.equal(result.stderr.trim().split("\n").length, 1);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("e2e v2: CANON_PRINCIPAL (env, then .env) is sent as principal with kind ai_session", async () => {
  const srv = await fakeServer();
  try {
    // CANON_REPO_ROOT points at our own .env so a developer's real .env cannot leak in.
    const root = mkdtempSync(join(tmpdir(), "canon-principal-"));
    writeFileSync(join(root, ".env"), "# no principal here\n");
    const base = { CANON_URL: srv.url, CANON_TOKEN_CLAUDE_CODE: "test-token", CANON_REPO_ROOT: root, CANON_DEBUG: "1" };

    const anon = await runHook(PAYLOAD, base);
    assert.equal(anon.code, 0, anon.stderr);
    assert.equal(srv.hits[0].body.kind, "ai_session");
    assert.equal("principal" in srv.hits[0].body, false, "unset → no principal key");
    assert.doesNotMatch(anon.stderr, / as /);

    const env = await runHook(PAYLOAD, { ...base, CANON_PRINCIPAL: "Dan" });
    assert.equal(env.code, 0, env.stderr);
    assert.equal(env.stdout, "");
    assert.equal(env.stderr.trim().split("\n").length, 1, `one debug line expected:\n${env.stderr}`);
    assert.match(env.stderr, / as dan → 200/);
    assert.equal(srv.hits[1].body.principal, "dan");
    assert.equal(srv.hits[1].body.kind, "ai_session");
    assert.equal(srv.hits[1].body.id, srv.hits[0].body.id, "same session id either way");

    writeFileSync(join(root, ".env"), "CANON_PRINCIPAL=priya\n");
    const dotenv = await runHook(PAYLOAD, base);
    assert.equal(dotenv.code, 0, dotenv.stderr);
    assert.equal(srv.hits[2].body.principal, "priya", ".env value used when the env has none");
    await runHook(PAYLOAD, { ...base, CANON_PRINCIPAL: "leo" });
    assert.equal(srv.hits[3].body.principal, "leo", "process env wins over .env");
  } finally {
    await srv.close();
  }
});

test("e2e: no CANON_TOKEN_CLAUDE_CODE anywhere → still POSTs with the dev token, one debug line", async () => {
  const srv = await fakeServer();
  try {
    // CANON_REPO_ROOT points at a .env without the token, so a developer's real .env in this
    // checkout cannot leak in (the first .env that exists wins).
    const root = mkdtempSync(join(tmpdir(), "canon-notoken-"));
    writeFileSync(join(root, ".env"), "# no token here\nCANON_PORT=4100\n");
    const r = await runHook(PAYLOAD, { CANON_URL: srv.url, CANON_REPO_ROOT: root, CANON_DEBUG: "1" });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr.trim().split("\n").length, 1, `one debug line expected:\n${r.stderr}`);
    assert.match(r.stderr, /→ 200 \(dev token: CANON_TOKEN_CLAUDE_CODE not set\)/);

    assert.equal(srv.hits.length, 1);
    assert.equal(srv.hits[0].headers.authorization, "Bearer dev-claude-code");
    assert.equal(srv.hits[0].body.client, "claude-code");

    // A token in that .env still wins over the dev default.
    writeFileSync(join(root, ".env"), "CANON_TOKEN_CLAUDE_CODE=from-dotenv\n");
    const withEnv = await runHook(PAYLOAD, { CANON_URL: srv.url, CANON_REPO_ROOT: root, CANON_DEBUG: "1" });
    assert.equal(withEnv.code, 0, withEnv.stderr);
    assert.doesNotMatch(withEnv.stderr, /dev token/);
    assert.equal(srv.hits.at(-1).headers.authorization, "Bearer from-dotenv");
  } finally {
    await srv.close();
  }
});

test("e2e: missing transcript or empty transcript → exit 0, no POST", async () => {
  const srv = await fakeServer();
  try {
    const env = { CANON_URL: srv.url, CANON_TOKEN_CLAUDE_CODE: "test-token", CANON_DEBUG: "1" };
    const missing = await runHook({ ...PAYLOAD, transcript_path: join(tmpdir(), "does-not-exist.jsonl") }, env);
    assert.equal(missing.code, 0);
    assert.match(missing.stderr, /transcript not found/);

    const emptyFile = join(mkdtempSync(join(tmpdir(), "canon-empty-")), "empty.jsonl");
    writeFileSync(emptyFile, '{"type":"summary","summary":"nothing"}\n');
    const empty = await runHook({ ...PAYLOAD, transcript_path: emptyFile }, env);
    assert.equal(empty.code, 0);
    assert.match(empty.stderr, /0 messages/);

    const garbage = await new Promise((done) => {
      const child = spawn(process.execPath, [CAPTURE], { env: { ...process.env, ...env } });
      child.on("close", (code) => done(code));
      child.stdin.end("this is not json");
    });
    assert.equal(garbage, 0, "bad stdin still exits 0");
    assert.equal(srv.hits.length, 0);
  } finally {
    await srv.close();
  }
});

test("e2e: exits 0 within 5s when CANON_URL points at a closed port", async () => {
  const port = await new Promise((r) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });
  const r = await runHook(PAYLOAD, { CANON_URL: `http://127.0.0.1:${port}`, CANON_TOKEN_CLAUDE_CODE: "test-token", CANON_DEBUG: "1" });
  assert.equal(r.code, 0);
  assert.ok(r.ms < 5000, `took ${r.ms}ms`);
  assert.equal(r.stderr.trim().split("\n").length, 1);
  assert.match(r.stderr, /^\[canon\] /);
});

// ---------- install.mjs ----------

test("install snippet points at the real absolute path for Stop and SessionEnd", async () => {
  const s = snippet();
  assert.deepEqual(Object.keys(s.hooks), ["Stop", "SessionEnd"]);
  for (const ev of ["Stop", "SessionEnd"]) {
    const [group] = s.hooks[ev];
    assert.equal(group.hooks[0].type, "command");
    assert.ok(group.hooks[0].command.includes(CAPTURE), group.hooks[0].command);
    assert.ok(group.hooks[0].command.startsWith("node "));
  }
  assert.ok(existsSync(capturePath()));
  assert.equal(commandFor("/plain/path.mjs"), "node /plain/path.mjs");
  assert.equal(commandFor("/with space/path.mjs"), "node '/with space/path.mjs'");

  // The CLI prints the same snippet as JSON on stdout (hint goes to stderr).
  const out = await new Promise((done) => {
    const child = spawn(process.execPath, [INSTALL]);
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => done({ code, stdout }));
  });
  assert.equal(out.code, 0);
  assert.deepEqual(JSON.parse(out.stdout), s);
});

test("install --write merges into settings.json, keeps other hooks, backs up, is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canon-settings-"));
  const settings = join(dir, "settings.json");
  const other = { matcher: "Bash", hooks: [{ type: "command", command: "echo other" }] };
  writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [other], PreToolUse: [other] } }));

  const run = () =>
    new Promise((done) => {
      const child = spawn(process.execPath, [INSTALL, "--write", "--settings", settings]);
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => done({ code, stderr }));
    });

  const first = await run();
  assert.equal(first.code, 0, first.stderr);
  assert.ok(existsSync(`${settings}.bak`), "backup written");
  const merged = JSON.parse(readFileSync(settings, "utf8"));
  assert.deepEqual(merged.permissions, { allow: ["Bash(ls)"] }, "unrelated keys kept");
  assert.deepEqual(merged.hooks.PreToolUse, [other], "other events untouched");
  assert.equal(merged.hooks.Stop.length, 2, "other Stop hook kept, ours appended");
  assert.deepEqual(merged.hooks.Stop[0], other);
  assert.ok(merged.hooks.Stop[1].hooks[0].command.includes(CAPTURE));
  assert.equal(merged.hooks.SessionEnd.length, 1);

  const second = await run();
  assert.equal(second.code, 0);
  const again = JSON.parse(readFileSync(settings, "utf8"));
  assert.deepEqual(again, merged, "re-running changes nothing");

  // Fresh file in a missing directory.
  const fresh = join(dir, "nested", "settings.json");
  writeSettings(fresh);
  assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")), snippet());
  assert.equal(existsSync(`${fresh}.bak`), false, "no backup for a new file");

  // Pure merge: replaces an older Canon entry instead of duplicating it.
  const stale = { hooks: { Stop: [{ hooks: [{ type: "command", command: "node /old/path/canon-capture.mjs" }] }] } };
  const replaced = mergeSettings(stale, "/new/canon-capture.mjs");
  assert.equal(replaced.hooks.Stop.length, 1);
  assert.equal(replaced.hooks.Stop[0].hooks[0].command, "node /new/canon-capture.mjs");
});
