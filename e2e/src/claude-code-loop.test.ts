// The core loop end to end on the offline providers (docs/PIPELINE-PRD.md §4.7): the real server
// on port 0 with a fresh data dir seeded with the demo world, the real distiller handler against
// it over HTTP (the heuristic writer, a simulated triage judge for this world), and the real
// Claude Code hooks as child processes with Claude-Code-shaped transcripts. One person token,
// Dollar Bill's, for both directions. His desk log becomes his facts and reaches his next prompt;
// a line about the bid, filed under deal/ by triage, never reaches him; canon_save lands as his
// fact; a restart keeps all of it; and no door says anything about what he cannot see.
//
// Two sessions, not one: triage files a draft in inbox when its item names a group other than
// Jev's pick (triage.ts, "the item names deal/stonewall, jev picked desk/dollar-bill"), so a desk
// log that also carried the rumor would send the TMC trade facts to moderators only. Dollar Bill
// logs the trades in one Claude Code session and the floor rumor in another, as he would.
//
// The simulated scope judge is keyword overlap (scope-judge.ts): a fact joins an agent's scope for
// its task only when the two share a word, so the desk log says "position", as the desk assistant's
// task does. Live Jev needs no such help (PIPELINE-PRD appendix A).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { DEMO_GRANTS, FakeJudge, MCP_TOOLS } from "@canon/shared";
import type { Answer, CanonEvent, CapturedSession, Fact, Question } from "@canon/shared";
import { startServer } from "@canon/server/src/app.ts";
import type { RunningServer } from "@canon/server/src/app.ts";
import { KeywordRetriever } from "@canon/server/src/retrieval/keyword.ts";
import { simulatedScopeAnswers } from "@canon/server/src/scope-judge.ts";
import { FIXTURES_DIR, seedDataDir } from "@canon/server/src/seed.ts";
import { createClient } from "@canon/distiller/src/client.ts";
import { HeuristicDistiller } from "@canon/distiller/src/engines/index.ts";
import { createHandler } from "@canon/distiller/src/worker.ts";
import type { Handler } from "@canon/distiller/src/worker.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CAPTURE = join(REPO, "hooks", "claude-code", "canon-capture.mjs");
const CONTEXT = join(REPO, "hooks", "claude-code", "canon-context.mjs");
const DESK_TRANSCRIPT = join(REPO, "e2e", "fixtures", "dollar-bill-desk-log.jsonl");
const RUMOR_TRANSCRIPT = join(REPO, "e2e", "fixtures", "dollar-bill-floor-rumor.jsonl");
/** Claude Code's session ids are UUIDs; the hook hashes them into `ses_` ids. */
const DESK_SESSION = "e2e00001-0000-4000-8000-000000000001";
const RUMOR_SESSION = "e2e00002-0000-4000-8000-000000000002";

const tokens = new Map([
  ["e2e-wags", "wags"],
  ["e2e-axe", "axe"],
  ["e2e-ben", "ben"],
  ["e2e-bill", "dollar-bill"],
  ["e2e-cc", "claude-code"],
  ["e2e-ingest", "ingest"],
  ["e2e-dispatcher", "dispatcher"],
  ["e2e-distiller", "distiller"],
]);
/** The one value on Dollar Bill's machine: CANON_PERSON_TOKEN. */
const BILL = "e2e-bill";
const DISTILLER = "e2e-distiller";

const LEAK = /52\.75|Stonewall|deal\//;
const REFUSAL = /refus|restricted|not allowed|cannot|excluded/i;

/**
 * The simulated triage judge for this world. The shipped offline judge (financeFakeJudge) files by
 * the Falcon world's group ids, so the e2e test answers triage's questions itself: a draft that
 * names Stonewall is deal talk, one that names the position is desk talk, the rest is public. The
 * choice is always one of the question's options; anything else falls through to FakeJudge.
 */
function demoTriageJudge(): FakeJudge {
  const groupFor = (text: string): string => {
    if (/stonewall/i.test(text)) return "deal/stonewall";
    if (/\b(?:TMC|shares?|position|basket|desk)\b/i.test(text)) return "desk/dollar-bill";
    return "market/public";
  };
  return new FakeJudge({
    override: (q: Question): Answer | undefined => {
      if (q.type === "noul") {
        if (q.id === "inject") return { id: q.id, type: "noul", p: 0.05 };
        if (q.id.startsWith("keep:")) return { id: q.id, type: "noul", p: 0.9 };
        if (q.id.startsWith("label:")) return { id: q.id, type: "noul", p: 0.2 };
        return undefined;
      }
      if (q.type === "choice") {
        const pick = (choice: string): Answer => ({ id: q.id, type: "choice", choice, p: 0.9 });
        if (q.id.startsWith("group:")) {
          const g = groupFor(q.text); // the question quotes the draft statement
          return pick(q.options.includes(g) ? g : "unsure");
        }
        if (q.id.startsWith("rel:")) return pick("unrelated");
        if (q.id.startsWith("relto:")) return pick("none");
      }
      return undefined;
    },
  });
}

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Runs a hook exactly as Claude Code does: payload on stdin, env, exit code back. No CANON_* from this shell leaks in. */
function runHook(script: string, payload: unknown, env: Record<string, string>): Promise<HookRun> {
  return new Promise((done) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CANON_")));
    const started = Date.now();
    const child = spawn(process.execPath, [script], { env: { ...clean, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("close", (code) => done({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe("the Claude Code loop, end to end on the offline providers (PIPELINE-PRD §4.7)", () => {
  let dataDir: string;
  /** Stands in for the person's checkout: CANON_REPO_ROOT with an empty .env, so this repo's .env is never read. */
  let hookRoot: string;
  let running: RunningServer;
  let handler: Handler;
  const events: CanonEvent[] = [];
  /** session.captured events forwarded to the handler, as the worker's SSE loop would. */
  const forwarded: Promise<void>[] = [];
  /** console.info/warn from the server, the judge and the distiller, kept for assertions and failure messages. */
  const logs: string[] = [];
  const original = { info: console.info, warn: console.warn };

  let deskSessionId = "";
  let rumorSessionId = "";
  let deskFacts: Fact[] = [];
  let rumorFact: Fact;
  let noteFactId = "";

  const hookEnv = (): Record<string, string> => ({ CANON_URL: running.url, CANON_PERSON_TOKEN: BILL, CANON_REPO_ROOT: hookRoot, CANON_DEBUG: "1" });
  const sessionEnd = (sessionId: string, transcript: string) => ({ session_id: sessionId, transcript_path: transcript, cwd: hookRoot, permission_mode: "default", hook_event_name: "SessionEnd", reason: "exit" });
  const promptSubmit = (prompt: string) => ({ session_id: DESK_SESSION, transcript_path: DESK_TRANSCRIPT, cwd: hookRoot, permission_mode: "default", hook_event_name: "UserPromptSubmit", prompt });
  const scopeOf = (principal: string): string[] => [...(running.world.scopes.get(principal)?.fact_ids ?? [])];
  const mine = (): Fact[] => running.store.listFacts().filter((f) => f.author === "dollar-bill");

  /** Subscribes to a server's bus: every event is recorded, every capture reaches the handler. */
  const attach = (server: RunningServer) =>
    server.bus.subscribe((e) => {
      events.push(e);
      if (e.type === "session.captured") forwarded.push(handler(e));
    });
  const newHandler = (url: string): Handler =>
    createHandler({ client: createClient({ baseUrl: url, token: DISTILLER }), distiller: new HeuristicDistiller(), judge: demoTriageJudge(), live: false, replayGraceMs: 0 });
  const start = () => startServer({ port: 0, dataDir, tokens, grants: [...DEMO_GRANTS], judge: new FakeJudge({ override: simulatedScopeAnswers }), retriever: new KeywordRetriever(), log: () => {} });
  /** Every forwarded capture distilled and posted, and every living-scope update it caused finished. */
  const distilled = async (): Promise<void> => {
    await Promise.all(forwarded.splice(0));
    await handler.settle();
    await running.living.drain();
  };
  /** One MCP tools/call over the stateless Streamable HTTP endpoint, as the given token. */
  const mcp = async (token: string, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const res = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    assert.equal(res.status, 200, `${name} as ${token}`);
    const text = await res.text();
    const data = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
    const rpc = JSON.parse(data) as { result?: { structuredContent?: Record<string, unknown>; isError?: boolean; content?: Array<{ text: string }> } };
    assert.ok(rpc.result && !rpc.result.isError, `${name}: ${JSON.stringify(rpc).slice(0, 200)}`);
    return rpc.result.structuredContent ?? (JSON.parse(rpc.result.content?.[0]?.text ?? "{}") as Record<string, unknown>);
  };
  /**
   * The ses_ id the hook's debug line says it posted, confirmed by the server's session.captured
   * event for that id (the event's `client` is the token's, dollar-bill; the stored session keeps
   * the claude-code label).
   */
  const capturedBy = (run: HookRun): string => {
    const id = /SessionEnd (ses_[0-9a-f]{8}) \d+ msgs/.exec(run.stderr)?.[1];
    assert.ok(id, `no session id in the hook's debug line:\n${run.stderr}`);
    const event = events.find((e) => e.type === "session.captured" && e.session.id === id);
    assert.ok(event && event.type === "session.captured", `no session.captured for ${id}`);
    assert.equal(event.session.ended, true, "SessionEnd is the final capture");
    return id;
  };

  before(async () => {
    console.info = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    dataDir = await mkdtemp(join(tmpdir(), "canon-e2e-"));
    hookRoot = await mkdtemp(join(tmpdir(), "canon-e2e-home-"));
    await writeFile(join(hookRoot, ".env"), "");
    await seedDataDir(dataDir, FIXTURES_DIR, "seed");
    running = await start();
    handler = newHandler(running.url);
    attach(running);
  });
  after(async () => {
    console.info = original.info;
    console.warn = original.warn;
    await running?.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(hookRoot, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------------------- 1. write

  test("capture: SessionEnd runs canon-capture.mjs with the person token; the server files the session as Dollar Bill's", async (t) => {
    assert.ok(scopeOf("dollar-bill").length > 0, "the 0:00 scope was built");

    const desk = await runHook(CAPTURE, sessionEnd(DESK_SESSION, DESK_TRANSCRIPT), hookEnv());
    assert.equal(desk.code, 0, desk.stderr);
    assert.equal(desk.stdout, "", "stdout stays empty: Claude Code reads it as a hook decision");
    assert.match(desk.stderr, /^\[canon\] SessionEnd ses_[0-9a-f]{8} 4 msgs → 200\n$/, desk.stderr);
    deskSessionId = capturedBy(desk);

    const session = (await running.store.getSession(deskSessionId)) as CapturedSession;
    assert.equal(session.client, "claude-code", "the capture source is a label");
    assert.equal(session.principal, "dollar-bill", "the author comes from the token, not the body");
    assert.equal(session.external, false);
    assert.equal(session.kind, "ai_session");
    assert.ok(typeof session.ended_at === "string" && !Number.isNaN(Date.parse(session.ended_at)));
    assert.deepEqual(session.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"], "one message per turn; tool results and the attachment are not conversation");
    for (const m of session.messages) {
      assert.ok(!m.content.startsWith("Bullwark memory"), "injected memory is never captured back");
      assert.ok(!m.content.includes("180,000 TMC"), "a fact from the injected memory leaked into a captured message");
    }
    assert.match(session.messages[0].content, /^Desk log for today\. I added 20,000 TMC shares at \$41\.50/);
    assert.match(session.messages[1].content, /\[tools: Write\]$/);

    const rumor = await runHook(CAPTURE, sessionEnd(RUMOR_SESSION, RUMOR_TRANSCRIPT), hookEnv());
    assert.equal(rumor.code, 0, rumor.stderr);
    assert.match(rumor.stderr, /SessionEnd ses_[0-9a-f]{8} 2 msgs → 200/);
    rumorSessionId = capturedBy(rumor);
    assert.notEqual(rumorSessionId, deskSessionId);
    assert.equal((await running.store.getSession(rumorSessionId))?.principal, "dollar-bill");
    t.diagnostic(`capture hook: ${desk.ms} ms and ${rumor.ms} ms (child process, SessionEnd)`);
  });

  test("distill: the handler fetches, writes and triages each session; trades go to desk/dollar-bill, the rumor to deal/stonewall, all authored dollar-bill", async (t) => {
    assert.equal(forwarded.length, 2, "both captures reached the handler");
    await distilled();

    const facts = mine();
    assert.ok(facts.length >= 3, `facts authored by dollar-bill: ${facts.length}\n${logs.join("\n")}`);
    assert.ok(!facts.some((f) => f.folder === "inbox"), `nothing of his waits in inbox: ${facts.map((f) => `${f.id} ${f.folder}`).join(", ")}`);

    deskFacts = facts.filter((f) => f.source.session === deskSessionId);
    assert.equal(deskFacts.length, 2, `two desk drafts: the add and the trim plan\n${logs.join("\n")}`);
    for (const f of deskFacts) {
      assert.equal(f.folder, "desk/dollar-bill", f.statement);
      assert.equal(f.tier, "hot");
      assert.equal(f.source.client, "claude-code");
    }
    assert.ok(deskFacts.some((f) => f.statement.includes("20,000 TMC shares at $41.50") && f.statement.includes("long 200,000 TMC")), deskFacts.map((f) => f.statement).join("\n"));
    assert.ok(deskFacts.some((f) => /^Plan: trim the TMC position by 25,000/.test(f.statement)), deskFacts.map((f) => f.statement).join("\n"));

    const rumors = facts.filter((f) => f.source.session === rumorSessionId);
    assert.equal(rumors.length, 1, `one draft from the rumor session\n${logs.join("\n")}`);
    rumorFact = rumors[0];
    assert.equal(rumorFact.folder, "deal/stonewall", "triage filed the bid talk with the deal");
    assert.match(rumorFact.statement, /Stonewall bid for TMC at \$52 per share/);

    // The worker's own account of the run, with measured times.
    const distil = logs.filter((l) => /heuristic distilled \d+ drafts in \d+ ms \(simulated\)/.test(l));
    const triaged = logs.filter((l) => /fake triaged \d+ drafts against \d+ facts and 5 groups in \d+ ms/.test(l));
    const saved = logs.filter((l) => /saved \d+, retired 0, filed 0 quarantine items, relayed \d+ events in \d+ ms/.test(l));
    assert.equal(distil.length, 2, logs.join("\n"));
    assert.equal(triaged.length, 2, logs.join("\n"));
    assert.equal(saved.length, 2, logs.join("\n"));
    assert.ok(triaged.some((l) => l.includes("groups desk/dollar-bill 2")) && triaged.some((l) => l.includes("groups deal/stonewall 1")), triaged.join("\n"));
    const finished = events.filter((e) => e.type === "distill.finished");
    assert.deepEqual(new Set(finished.map((e) => e.session_id)), new Set([deskSessionId, rumorSessionId]));
    assert.ok(finished.every((e) => e.engine === "heuristic"));
    assert.equal(events.filter((e) => e.type === "triage.decided").length, 3, "one relayed decision per draft");
    for (const l of [...distil, ...triaged, ...saved]) t.diagnostic(l);
  });

  test("living scopes: his desk facts join his scope and his desk assistant's; the deal/ fact joins neither, with the audit to show it", () => {
    const bill = scopeOf("dollar-bill");
    const assistant = scopeOf("desk-assistant");
    for (const f of deskFacts) {
      assert.ok(bill.includes(f.id), `${f.id} joined dollar-bill`);
      assert.ok(assistant.includes(f.id), `${f.id} joined desk-assistant through its creator`);
    }
    assert.ok(!bill.includes(rumorFact.id), "his own rumor is excluded in code: deal/* is not his");
    assert.ok(!assistant.includes(rumorFact.id), "an agent never exceeds its creator");
    for (const [principal, scope] of running.world.scopes) {
      if (scope.fact_ids.includes(rumorFact.id)) assert.ok(!["dollar-bill", "desk-assistant", "ben", "research-analyst"].includes(principal), `${rumorFact.id} is in ${principal}'s scope`);
    }
    assert.ok(scopeOf("axe").includes(rumorFact.id), "the deal lead's scope takes bid talk; the fact was filed, not dropped");

    const joins = running.world.audit.filter((e) => e.kind === "fact.joined_scope");
    for (const f of deskFacts) {
      const own = joins.find((e) => e.principal === "dollar-bill" && e.fact_ids?.includes(f.id));
      assert.ok(own, `audit: ${f.id} joined dollar-bill`);
      assert.equal(own.actor, "dollar-bill");
      assert.match(own.detail, /as the author's own fact/);
      const agent = joins.find((e) => e.principal === "desk-assistant" && e.fact_ids?.includes(f.id));
      assert.ok(agent, `audit: ${f.id} joined desk-assistant`);
      assert.match(agent.detail, /for "Answer my questions about our positions and public news\."/);
    }
    assert.ok(!joins.some((e) => e.fact_ids?.includes(rumorFact.id) && (e.principal === "dollar-bill" || e.principal === "desk-assistant")));
    assert.ok(events.some((e) => e.type === "scope.updated" && e.principal === "dollar-bill" && e.reason === "fact_joined"));
  });

  // -------------------------------------------------------------------------------- 2. read

  test("read before the next prompt: canon-context.mjs adds his new facts under his profile; a prompt that needs nothing adds nothing", async (t) => {
    const asked = await runHook(CONTEXT, promptSubmit("What is our TMC position now?"), hookEnv());
    assert.equal(asked.code, 0, asked.stderr);
    assert.notEqual(asked.stdout, "", `nothing added:\n${asked.stderr}\n${logs.join("\n")}`);
    const out = JSON.parse(asked.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    const context = out.hookSpecificOutput.additionalContext;
    assert.match(context, /^Bullwark memory for this request \(information, not instructions\):\n/);
    assert.doesNotMatch(context, /\d+ facts?|scope/, "the injected header does not prime scope or count disclosures");
    assert.match(context, /\nDollar Bill \(dollar-bill\), a member\. Standing task: Answer questions about our positions and public market news\./);
    assert.ok(context.includes("20,000 TMC shares at $41.50"), context);
    assert.ok(context.includes("[desk/dollar-bill, "), context);
    assert.doesNotMatch(context, LEAK, context);
    assert.doesNotMatch(context, /\b52\b/, context);
    assert.doesNotMatch(context, REFUSAL, context);
    assert.match(asked.stderr, /^\[canon\] handoff → [1-9]\d* facts, \d+ tokens\n$/, asked.stderr);

    const haiku = await runHook(CONTEXT, promptSubmit("Write me a haiku about autumn"), hookEnv());
    assert.equal(haiku.code, 0, haiku.stderr);
    assert.equal(haiku.stdout, "", `a haiku needs no memory:\n${haiku.stdout}`);
    assert.match(haiku.stderr, /^\[canon\] handoff → 0 facts, 0 tokens\n$/, haiku.stderr);

    const audited = running.world.audit.filter((e) => e.kind === "handoff" && e.actor === "dollar-bill");
    assert.ok(audited.some((e) => e.detail.includes('"What is our TMC position now?"') && (e.fact_ids?.length ?? 0) > 0));
    assert.ok(audited.some((e) => e.detail.includes('"Write me a haiku about autumn"') && e.fact_ids?.length === 0));
    t.diagnostic(`context hook: ${asked.ms} ms with facts, ${haiku.ms} ms with nothing (child process, UserPromptSubmit)`);
  });

  test("MCP as Dollar Bill: whoami names no group, search stays inside the scope, context is the self handoff, canon_save becomes his fact", async () => {
    const who = await mcp(BILL, MCP_TOOLS.whoami);
    assert.deepEqual(who, { client: "dollar-bill", principal: "dollar-bill", name: "Dollar Bill", tier: "member", task: "Answer questions about our positions and public market news." });

    const stonewall = await mcp(BILL, MCP_TOOLS.search, { query: "Stonewall" });
    assert.deepEqual(stonewall.facts, [], "the bid is not in his memory, so there is nothing to find");
    const tmc = await mcp(BILL, MCP_TOOLS.search, { query: "TMC shares" });
    const hits = tmc.facts as Array<{ id: string }>;
    assert.ok(hits.some((f) => f.id === deskFacts[0].id || f.id === deskFacts[1].id), "his new desk facts are searchable");
    assert.ok(hits.every((f) => scopeOf("dollar-bill").includes(f.id)));

    const ctx = await mcp(BILL, MCP_TOOLS.context, { task: "our TMC position" });
    const facts = ctx.facts as Array<{ id: string; statement: string; folder: string }>;
    assert.ok(facts.length > 0);
    assert.ok(facts.every((f) => scopeOf("dollar-bill").includes(f.id)), "only facts in his scope");
    assert.ok(facts.some((f) => deskFacts.some((d) => d.id === f.id)), "the captured desk fact is served on demand too");
    assert.match(String(ctx.profile), /^Dollar Bill \(dollar-bill\), a member\./);
    assert.equal("candidates" in ctx, false, "what was considered is not his to know");
    assert.equal("missing" in ctx, false, "no hint about what the memory lacks");
    assert.equal(ctx.enough, true);

    const saved = await mcp(BILL, MCP_TOOLS.save, { text: "Remember: I decided to trim the TMC position by 25,000 shares before the Q4 letter on November 16." });
    assert.equal(saved.queued, true);
    const noteId = String(saved.session_id);
    const note = (await running.store.getSession(noteId)) as CapturedSession;
    assert.equal(note.principal, "dollar-bill");
    assert.equal(note.kind, "note");
    assert.equal(note.external, false);
    assert.equal(note.meta?.source, "canon_save");
    assert.equal(forwarded.length, 1, "canon_save queues a capture for the distiller");
    await distilled();

    const noteFacts = mine().filter((f) => f.source.session === noteId);
    assert.equal(noteFacts.length, 1, logs.slice(-12).join("\n"));
    noteFactId = noteFacts[0].id;
    assert.equal(noteFacts[0].folder, "desk/dollar-bill");
    assert.match(noteFacts[0].statement, /trim the TMC position by 25,000 shares/);
    assert.ok(scopeOf("dollar-bill").includes(noteFactId), "his note joined his scope");
    assert.ok(scopeOf("desk-assistant").includes(noteFactId));
  });

  // ----------------------------------------------------------------------------- 3. survive

  test("restart: the same data dir restores the world; his scope, the audit and the facts his prompts get are unchanged", async () => {
    const before = { bill: scopeOf("dollar-bill"), assistant: scopeOf("desk-assistant"), axe: scopeOf("axe"), audit: running.world.audit.length, facts: running.store.listFacts().length };
    assert.ok(before.bill.includes(noteFactId) && deskFacts.every((f) => before.bill.includes(f.id)));
    await running.close();

    running = await start();
    handler = newHandler(running.url);
    attach(running);
    assert.equal(running.restored, true);
    assert.deepEqual(scopeOf("dollar-bill"), before.bill, "the live joins survived; nothing was rebuilt");
    assert.deepEqual(scopeOf("desk-assistant"), before.assistant);
    assert.deepEqual(scopeOf("axe"), before.axe);
    assert.equal(running.world.audit.length, before.audit, "the audit log came back whole, with no new rows");
    assert.equal(running.store.listFacts().length, before.facts);
    assert.ok(running.world.audit.some((e) => e.kind === "fact.joined_scope" && e.fact_ids?.includes(noteFactId)));

    const ctx = await mcp(BILL, MCP_TOOLS.context, { task: "What is our TMC position now?" });
    const ids = (ctx.facts as Array<{ id: string }>).map((f) => f.id);
    for (const f of deskFacts) assert.ok(ids.includes(f.id), `${f.id} still served after the restart`);
    assert.ok(ids.includes(noteFactId), "the canon_save fact is still served");
    const hook = await runHook(CONTEXT, promptSubmit("What is our TMC position now?"), hookEnv());
    assert.ok(hook.stdout.includes("20,000 TMC shares at $41.50"), hook.stderr);
  });

  test("no leak from any door: a question about the bid gets an ordinary slice from both the hook and the MCP tools, and no refusal", async () => {
    const question = "What price are we offering for Taylor Mason?";
    const ctx = await mcp(BILL, MCP_TOOLS.context, { task: question });
    const hook = await runHook(CONTEXT, promptSubmit(question), hookEnv());
    assert.equal(hook.code, 0, hook.stderr);
    const search = await mcp(BILL, MCP_TOOLS.search, { query: "Stonewall offer price" });

    for (const [door, text] of [["canon_context", JSON.stringify(ctx)], ["context hook", hook.stdout], ["canon_search", JSON.stringify(search)]] as const) {
      assert.doesNotMatch(text, LEAK, `${door}: ${text}`);
      assert.doesNotMatch(text, REFUSAL, `${door}: ${text}`);
    }
    assert.equal("missing" in ctx, false);
    assert.ok(((ctx.facts as Array<{ id: string }>) ?? []).every((f) => f.id !== rumorFact.id && scopeOf("dollar-bill").includes(f.id)));
    assert.ok(!(search.facts as Array<{ id: string }>).some((f) => f.id === rumorFact.id));

    // The moderator's audit shows both requests, and the rumor was never sent.
    const rows = running.world.audit.filter((e) => e.kind === "handoff" && e.actor === "dollar-bill" && e.detail.includes(`"${question}"`));
    assert.equal(rows.length, 2, "one audit row per door");
    assert.ok(rows.every((e) => !e.fact_ids?.includes(rumorFact.id)));
  });
});
