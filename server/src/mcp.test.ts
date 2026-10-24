import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { FakeJudge, factTokens } from "@canon/shared";
import type { CanonEvent, Fact, Grant, Judge } from "@canon/shared";

import { EventBus } from "./events.ts";
import { runContext, runSave, runSearch, runWhoami } from "./mcp.ts";
import type { McpDeps } from "./mcp.ts";
import { KeywordRetriever } from "./retrieval/keyword.ts";
import { FileStore } from "./store.ts";

const grant: Grant = { client: "claude-code", read: ["projects", "career"], write: ["projects"] };

const fact = (id: string, folder: Fact["folder"], statement: string): Fact => ({
  id,
  statement,
  folder,
  tier: "hot",
  jev_keep: 0.8,
  source: { client: "claude-code", session: "ses_0001" },
  updated: "2026-10-23",
});

// All three mention "hook" so the keyword stub returns all of them as candidates.
const A = fact("fct_000a", "career/projects", "Built Canon's live capture hook for Claude Code sessions, posting to the server as the transcript grows");
const B = fact("fct_000b", "projects/canon", "The Claude Code hook sends a CapturedSession with the whole message list; the server replaces it");
const C = fact("fct_000c", "career/skills", "Knows how to write a git pre-commit hook in bash");
const PRIVATE = fact("fct_000d", "private/health", "A hook-shaped private note");

/** Judge that answers with fixed relevance per fact id and a fixed "enough". */
const judgeWith = (p: Record<string, number>, enough: number) =>
  new FakeJudge({
    override: (q) => (q.type === "noul" ? { id: q.id, type: "noul", p: q.id === "enough" ? enough : (p[q.id] ?? 0) } : undefined),
  });

describe("MCP tool bodies", () => {
  let dir: string;
  let deps: McpDeps;
  let events: CanonEvent[];
  const originalInfo = console.info;

  before(async () => {
    console.info = () => {}; // FakeJudge announces itself on every construction
    dir = await mkdtemp(join(tmpdir(), "canon-mcp-"));
    const store = new FileStore(dir);
    const retriever = new KeywordRetriever();
    await retriever.index([A, B, C, PRIVATE]);
    const bus = new EventBus();
    events = [];
    bus.subscribe((e) => events.push(e));
    deps = { client: "claude-code", grant, store, retriever, bus, judge: judgeWith({}, 0) };
  });
  after(async () => {
    console.info = originalInfo;
    await rm(dir, { recursive: true, force: true });
  });

  test("canon_context keeps p > 0.7 sorted by p, cuts to the token budget, and emits context.served", async () => {
    const judge = judgeWith({ [A.id]: 0.8, [B.id]: 0.95, [C.id]: 0.4 }, 0.9);
    events.length = 0;
    const budget = factTokens(B) + 2; // room for B, not for A
    const out = await runContext({ ...deps, judge }, { task: "wire the Claude Code hook", budget_tokens: budget });

    assert.deepEqual(
      out.facts.map((f) => [f.id, f.relevance]),
      [[B.id, 0.95]],
    );
    assert.equal(out.tokens, factTokens(B));
    assert.equal(out.candidates, 3, "the private fact is outside the grant");
    assert.equal(out.enough, true);
    assert.equal(out.missing, undefined);
    assert.equal(out.facts[0].folder, B.folder);
    assert.ok(!("tier" in out.facts[0]));

    const served = events.find((e) => e.type === "context.served");
    assert.ok(served && served.type === "context.served");
    assert.deepEqual(served.fact_ids, [B.id]);
    assert.equal(served.candidates, 3);
    assert.equal(served.tokens, out.tokens);
    assert.equal(served.enough, true);
    assert.equal(typeof served.judge_ms, "number");
    assert.equal(typeof served.retrieval_ms, "number");
  });

  test("canon_context with a large budget returns every relevant fact in p order", async () => {
    const judge = judgeWith({ [A.id]: 0.8, [B.id]: 0.95, [C.id]: 0.4 }, 0.9);
    const out = await runContext({ ...deps, judge }, { task: "wire the Claude Code hook" });
    assert.deepEqual(
      out.facts.map((f) => f.id),
      [B.id, A.id],
    );
    assert.equal(out.tokens, factTokens(A) + factTokens(B));
  });

  test("canon_context says what is missing when nothing relevant is stored", async () => {
    const judge = judgeWith({}, 0.9);
    const none = await runContext({ ...deps, judge }, { task: "quarterly tax filing" });
    assert.deepEqual(none.facts, []);
    assert.equal(none.candidates, 0);
    assert.equal(none.enough, false);
    assert.equal(none.missing, "No stored fact covers: quarterly tax filing");

    // Candidates exist but Jev says none is relevant: still not enough, even if "enough" is high.
    const irrelevant = await runContext({ ...deps, judge: judgeWith({ [A.id]: 0.1 }, 0.9) }, { task: "hook" });
    assert.equal(irrelevant.candidates, 3);
    assert.equal(irrelevant.enough, false);
    assert.match(irrelevant.missing ?? "", /^No stored fact covers: hook$/);
  });

  test("canon_context survives a judge failure: no facts, enough=false, the reason in `missing`, event still emitted", async () => {
    const broken: Judge = {
      name: "fake",
      ask: async () => {
        throw new Error("Jev timed out after 5000 ms");
      },
    };
    const originalError = console.error;
    console.error = () => {};
    events.length = 0;
    try {
      const out = await runContext({ ...deps, judge: broken }, { task: "wire the Claude Code hook" });
      assert.deepEqual(out.facts, []);
      assert.equal(out.candidates, 3, "retrieval still ran");
      assert.equal(out.enough, false);
      assert.match(out.missing ?? "", /^Judge fake failed \(Jev timed out after 5000 ms\), so 3 candidate\(s\) could not be checked for: wire the Claude Code hook$/);
      const served = events.find((e) => e.type === "context.served");
      assert.ok(served && served.type === "context.served");
      assert.equal(served.enough, false);
      assert.deepEqual(served.fact_ids, []);
      assert.equal(typeof served.judge_ms, "number");
    } finally {
      console.error = originalError;
    }
  });

  test("canon_search searches granted folders and refuses one outside the grant", async () => {
    events.length = 0;
    const ok = await runSearch(deps, { query: "hook" });
    assert.ok(ok.ok);
    assert.deepEqual(ok.output.facts.map((f) => f.id).sort(), [A.id, B.id, C.id]);

    const narrowed = await runSearch(deps, { query: "hook", folders: ["projects"] });
    assert.ok(narrowed.ok);
    assert.deepEqual(
      narrowed.output.facts.map((f) => f.id),
      [B.id],
    );

    const refused = await runSearch(deps, { query: "hook", folders: ["career", "private"] });
    assert.ok(!refused.ok);
    assert.equal(refused.refused, "refused: claude-code cannot read private. Call canon_whoami to see your folders.");
    const denied = events.find((e) => e.type === "access.denied");
    assert.ok(denied && denied.type === "access.denied");
    assert.equal(denied.folder, "private");
    assert.equal(denied.tool, "canon_search");
  });

  test("canon_save writes a one-message session to the archive and emits session.captured", async () => {
    events.length = 0;
    const out = await runSave(deps, { text: "Prefer Postgres over SQLite for anything multi-user", folder: "projects/canon" });
    assert.equal(out.queued, true);
    assert.match(out.session_id, /^ses_[0-9a-f]{8}$/);
    const session = await deps.store.getSession(out.session_id);
    assert.equal(session?.client, "claude-code");
    assert.deepEqual(session?.messages, [{ role: "user", content: "Prefer Postgres over SQLite for anything multi-user" }]);
    assert.equal(session?.meta?.folder_hint, "projects/canon");
    assert.equal(session?.principal, undefined, "an operator grant names no principal, so none is guessed");
    assert.ok(session?.ended_at);
    const captured = events.find((e) => e.type === "session.captured");
    assert.ok(captured && captured.type === "session.captured");
    assert.equal(captured.session.id, out.session_id);
    assert.equal(captured.session.ended, true);
    // Nothing went to hot facts.
    assert.equal(deps.store.counts().facts, 0);
  });

  test("canon_save binds a per-person client's principal, like POST /api/sessions", async () => {
    const dan: Grant = { client: "dan", read: [], write: [], principal: "dan" };
    const out = await runSave({ ...deps, client: "dan", grant: dan }, { text: "LOI call moved to Monday", folder: "deal/falcon" });
    const session = await deps.store.getSession(out.session_id);
    assert.equal(session?.principal, "dan", "the saved memory is the principal's own");
  });

  test("canon_whoami returns the grant", () => {
    assert.deepEqual(runWhoami(deps), { client: "claude-code", read: ["projects", "career"], write: ["projects"] });
  });
});
