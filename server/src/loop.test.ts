// The core loop's server side on the demo world (docs/PIPELINE-PRD.md): a person's token reads
// its own scope through REST, the member event stream and the MCP tools; the world survives a
// restart; and the four defects the review found stay fixed. Real server on port 0, offline
// providers (the simulated scope judge, the keyword retriever), fresh data dir seeded with the
// demo world at 0:00.

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { DEMO_GRANTS, FakeJudge, MCP_TOOLS } from "@canon/shared";
import type { AuditEvent, CanonEvent, CapturedSession, ContractFact, Fact, MeResponse, Question, Scope, ScopeRule } from "@canon/shared";

import { startServer } from "./app.ts";
import type { RunningServer } from "./app.ts";
import { MODERATORS_ONLY } from "./scopes.ts";
import { KeywordRetriever } from "./retrieval/keyword.ts";
import { simulatedScopeAnswers } from "./scope-judge.ts";
import { FIXTURES_DIR, seedDataDir } from "./seed.ts";

const tokens = new Map([
  ["t-wags", "wags"],
  ["t-axe", "axe"],
  ["t-ben", "ben"],
  ["t-bill", "dollar-bill"],
  ["t-cc", "claude-code"],
  ["t-ing", "ingest"],
  ["t-disp", "dispatcher"],
  ["t-dist", "distiller"],
]);

/** The simulated scope judge, with two test hooks: a task that makes it throw, and a question kind it answers slowly. */
function testJudge(opts: { slowMs?: number } = {}): FakeJudge {
  return new FakeJudge({
    override: (q, state) => {
      if (/Fail this build/.test(q.text) || /Fail this build/.test(state)) throw new Error("judge down");
      return simulatedScopeAnswers(q, state);
    },
  });
}

class SlowJudge extends FakeJudge {
  constructor(private readonly slowMs: number) {
    super({ override: simulatedScopeAnswers });
  }
  override async ask(state: string, questions: Question[]) {
    if (questions.some((q) => q.id.startsWith("rf:"))) await new Promise((r) => setTimeout(r, this.slowMs));
    return super.ask(state, questions);
  }
}

describe("the core loop on the demo world (PIPELINE-PRD)", () => {
  let dir: string;
  let running: RunningServer;
  const originalInfo = console.info;
  const events: CanonEvent[] = [];

  const api = (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.json !== undefined) headers["content-type"] = "application/json";
    return fetch(`${running.url}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  };
  const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;
  const scopeOf = (principal: string): string[] => [...(running.world.scopes.get(principal)?.fact_ids ?? [])];
  const until = async (pred: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 300; i++) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail(`timed out waiting for ${what}`);
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
  /** Reads the SSE stream for `ms`, returning parsed frames in order. */
  const stream = async (path: string, ms = 350): Promise<Array<{ id: string; event: CanonEvent }>> => {
    const ac = new AbortController();
    const res = await fetch(`${running.url}${path}`, { signal: ac.signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
    } catch {
      // aborted on purpose
    } finally {
      clearTimeout(timer);
    }
    const frames: Array<{ id: string; event: CanonEvent }> = [];
    for (const block of buf.split("\n\n")) {
      const id = /^id: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (id && data) frames.push({ id, event: JSON.parse(data) as CanonEvent });
    }
    return frames;
  };
  const distillerFact = (id: string, folder: Fact["folder"], statement: string, extra: Partial<Fact> = {}): Fact => ({
    id,
    statement,
    folder,
    tier: "hot",
    jev_keep: 0.9,
    source: { client: "ingest", session: "ses_e2e0e2e0" },
    updated: "2026-10-24",
    ...extra,
  });
  const postFact = (fact: Fact, action: "add" | "supersede" = "add", supersedes?: string) =>
    api("/api/facts", {
      method: "POST",
      token: "t-dist",
      json: { facts: [{ fact, decision: { action, tier: fact.tier, folder: fact.folder, keep_p: 0.9, folder_p: 0.9, judge: "fake", ...(supersedes ? { supersedes } : {}) } }] },
    });

  before(async () => {
    console.info = () => {};
    dir = await mkdtemp(join(tmpdir(), "canon-loop-"));
    await seedDataDir(dir, FIXTURES_DIR, "seed");
    running = await startServer({ port: 0, dataDir: dir, tokens, grants: [...DEMO_GRANTS], judge: testJudge(), retriever: new KeywordRetriever(), log: () => {} });
    running.bus.subscribe((e) => events.push(e));
  });
  after(async () => {
    console.info = originalInfo;
    await running?.close();
    await rm(dir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------------ reads (P1 routes)

  test("GET /api/me: a person's id, name, tier, task and firm; never exclusions; an operator token is not a principal", async () => {
    const bill = await body<MeResponse>(await api("/api/me", { token: "t-bill" }));
    assert.deepEqual(bill, { id: "dollar-bill", kind: "person", name: "Dollar Bill", tier: "member", task: "Answer questions about our positions and public market news.", firm: "Axe Capital" });
    assert.ok(!JSON.stringify(bill).includes("deal"), "no exclusion leaks into /me");
    const wags = await body<MeResponse>(await api("/api/me", { token: "t-wags" }));
    assert.equal(wags.tier, "moderator");
    assert.equal(wags.task, undefined);
    assert.equal((await api("/api/me", { token: "t-cc" })).status, 404);
    assert.equal((await api("/api/me")).status, 401);
  });

  test("GET /api/facts for a person is their scope in the contract's shape; operators keep the scaffold's", async () => {
    const mine = await body<{ facts: ContractFact[] }>(await api("/api/facts", { token: "t-bill" }));
    assert.ok(mine.facts.length > 0);
    assert.deepEqual(new Set(mine.facts.map((f) => f.id)), new Set(scopeOf("dollar-bill")), "exactly the scope");
    for (const f of mine.facts) {
      assert.ok(!f.group.startsWith("deal"), `${f.id} is a deal fact`);
      assert.deepEqual(Object.keys(f).filter((k) => ["group", "labels", "source", "happened_at", "learned_at", "status"].includes(k)).length, 6, "contract fields present");
      assert.equal("folder" in f, false, "no scaffold field");
    }
    const aum = mine.facts.find((f) => f.id === "fct_570013");
    assert.ok(aum);
    assert.equal(aum.author, "ben");
    assert.equal(aum.source_kind, "memo", "the item's kind rides along");
    assert.match(aum.source_title ?? "", /Q3 2026 shareholder letter/);
    assert.deepEqual(aum.labels, ["taylor-mason"]);
    // Filters narrow inside the scope.
    const desk = await body<{ facts: ContractFact[] }>(await api("/api/facts?group=desk", { token: "t-bill" }));
    assert.ok(desk.facts.length > 0 && desk.facts.every((f) => f.group === "desk/dollar-bill"));
    const q = await body<{ facts: ContractFact[] }>(await api("/api/facts?q=38.4", { token: "t-bill" }));
    assert.deepEqual(q.facts.map((f) => f.id), ["fct_570013"]);
    const labelled = await body<{ facts: ContractFact[] }>(await api("/api/facts?label=taylor-mason", { token: "t-bill" }));
    assert.ok(labelled.facts.length > 0 && labelled.facts.every((f) => f.labels.includes("taylor-mason")));
    // A moderator sees everything, deal facts included; the distiller keeps the scaffold shape.
    const all = await body<{ facts: ContractFact[] }>(await api("/api/facts", { token: "t-wags" }));
    assert.ok(all.facts.some((f) => f.group === "deal/stonewall"));
    const scaffold = await body<{ facts: Fact[] }>(await api("/api/facts", { token: "t-dist" }));
    assert.ok(scaffold.facts.length > 0 && scaffold.facts.every((f) => "folder" in f));
  });

  test("GET /api/groups for a member: only the groups their scope draws from, by display name", async () => {
    const mine = await body<{ groups: Array<Record<string, unknown>> }>(await api("/api/groups", { token: "t-bill" }));
    const folders = new Set(scopeOf("dollar-bill").map((id) => running.store.getFact(id)?.folder));
    assert.deepEqual(new Set(mine.groups.map((g) => g.id)), folders);
    for (const g of mine.groups) assert.deepEqual(Object.keys(g).sort(), ["display", "id"]);
    assert.equal(mine.groups.find((g) => g.id === "market/public")?.display, "Public market");
    assert.ok(!mine.groups.some((g) => g.id === "deal/stonewall"));
    const full = await body<{ groups: Array<Record<string, unknown>> }>(await api("/api/groups", { token: "t-wags" }));
    assert.ok(full.groups.some((g) => g.id === "deal/stonewall" && typeof g.description === "string"));
  });

  // --------------------------------------------------------------------------- MCP by class

  test("MCP for a person: whoami names no group, context is the self handoff, search stays inside the scope", async () => {
    const who = await mcp("t-bill", MCP_TOOLS.whoami);
    assert.deepEqual(who, { client: "dollar-bill", principal: "dollar-bill", name: "Dollar Bill", tier: "member", task: "Answer questions about our positions and public market news." });

    const ctx = await mcp("t-bill", MCP_TOOLS.context, { task: "What is our TMC position and what did they report in Q3?" });
    const facts = ctx.facts as Array<{ id: string }>;
    assert.ok(facts.length > 0, "his public and desk facts help");
    assert.ok(facts.every((f) => scopeOf("dollar-bill").includes(f.id)), "only facts in his scope");
    assert.match(String(ctx.profile), /^Dollar Bill \(dollar-bill\), a member/);
    assert.equal("candidates" in ctx, false, "what was considered is not his to know");
    assert.equal("missing" in ctx, false, "no hint about what the memory lacks");
    assert.equal(ctx.enough, true);
    assert.ok(events.some((e) => e.type === "context.served" && e.client === "dollar-bill"), "the dashboard counter still gets its feed");

    const bid = await mcp("t-bill", MCP_TOOLS.context, { task: "What price are we offering for Taylor Mason and when does the board sign off?" });
    assert.ok(!JSON.stringify(bid).match(/52\.75|Stonewall|deal\//), "nothing about the bid, and no refusal text");
    assert.equal("missing" in bid, false);

    const stonewall = await mcp("t-bill", MCP_TOOLS.search, { query: "Stonewall offer" });
    assert.deepEqual(stonewall.facts, []);
    const tmc = await mcp("t-bill", MCP_TOOLS.search, { query: "TMC" });
    const hits = tmc.facts as Array<Record<string, unknown>>;
    assert.ok(hits.length > 0 && hits.every((f) => scopeOf("dollar-bill").includes(String(f.id)) && !("supersedes" in f)));
    const narrowed = await mcp("t-bill", MCP_TOOLS.search, { query: "TMC", folders: ["deal/stonewall", "market/public"] });
    assert.ok((narrowed.facts as Array<{ folder: string }>).every((f) => f.folder === "market/public"), "an outside folder is simply not searched");

    // An operator token keeps the scaffold's folder view.
    const op = await mcp("t-cc", MCP_TOOLS.whoami);
    assert.deepEqual(Object.keys(op).sort(), ["client", "read", "write"]);
  });

  test("canon_save from a person's token is their own note, with kind and origin set", async () => {
    const out = await mcp("t-bill", MCP_TOOLS.save, { text: "Remember: I trim the basket again before the TMC Q4 letter." });
    assert.equal(out.queued, true);
    const session = await running.store.getSession(String(out.session_id));
    assert.equal(session?.principal, "dollar-bill");
    assert.equal(session?.kind, "note");
    assert.equal(session?.external, false);
    assert.equal(session?.meta?.source, "canon_save");
  });

  // ------------------------------------------------------------------ items, edits, agents

  test("POST /api/items: a pasted note becomes the caller's captured item; only a moderator names another author", async () => {
    const res = await api("/api/items", { method: "POST", token: "t-bill", json: { kind: "note", source: "Desk notes", text: "Trimmed the basket by 5% today." } });
    assert.equal(res.status, 200);
    const { item_id } = await body<{ item_id: string }>(res);
    const session = (await running.store.getSession(item_id)) as CapturedSession;
    assert.equal(session.principal, "dollar-bill");
    assert.equal(session.kind, "note");
    assert.equal(session.title, "Desk notes");
    assert.equal(session.client, "ingest");
    assert.equal((await api("/api/items", { method: "POST", token: "t-bill", json: { kind: "note", source: "x", text: "y", author: "ben" } })).status, 403);
    assert.equal((await api("/api/items", { method: "POST", token: "t-wags", json: { kind: "memo", source: "Pasted by Wags", text: "For Ben.", author: "ben" } })).status, 200);
    assert.equal((await api("/api/items", { method: "POST", token: "t-bill", json: { kind: "ai_session", source: "x", text: "y" } })).status, 400);

    // His stream shows the item in the contract's name, and nothing moderators-only.
    const frames = await stream(`/events?token=${encodeURIComponent("t-bill")}`);
    const types = new Set(frames.map((f) => f.event.type));
    const item = frames.find((f) => f.event.type === "item.captured" && (f.event as { item_id: string }).item_id === item_id)?.event as { kind: string; source: string; author: string } | undefined;
    assert.ok(item, "item.captured for his own item");
    assert.deepEqual([item.kind, item.source, item.author], ["note", "Desk notes", "dollar-bill"]);
    for (const forbidden of ["audit.logged", "scope.stage", "scope.updated", "quarantine.flagged", "triage.decided", "fact.filed", "handoff.served"]) {
      assert.ok(!types.has(forbidden as CanonEvent["type"]), `${forbidden} never reaches a member`);
    }
    assert.ok(!JSON.stringify(frames).includes("deal/stonewall"), "no deal group is named on his stream");
    assert.equal((await fetch(`${running.url}/events?token=nope`)).status, 401);
  });

  test("PATCH and retire work inside the scope; outside it the fact does not exist", async () => {
    const edited = await api("/api/facts/fct_570013", { method: "PATCH", token: "t-bill", json: { statement: "TMC's AUM was $38.4 billion at the end of Q3 2026 (down 3%)." } });
    assert.equal(edited.status, 200);
    assert.match((await body<ContractFact>(edited)).statement, /^TMC's AUM was/);
    assert.equal(running.store.getFact("fct_570013")?.statement.startsWith("TMC's AUM was"), true);

    const outside = await api("/api/facts/fct_570001", { method: "PATCH", token: "t-bill", json: { statement: "x" } });
    const missing = await api("/api/facts/fct_ffffff", { method: "PATCH", token: "t-bill", json: { statement: "x" } });
    assert.equal(outside.status, 404);
    assert.equal(missing.status, 404);
    assert.equal((await outside.text()).replace("fct_570001", "X"), (await missing.text()).replace("fct_ffffff", "X"), "the same bytes but for the id echoed back");

    assert.ok(scopeOf("dollar-bill").includes("fct_57001f"));
    assert.equal((await api("/api/facts/fct_57001f/retire", { method: "POST", token: "t-bill" })).status, 200);
    assert.equal(running.store.getFact("fct_57001f")?.tier, "cold");
    assert.ok(!scopeOf("dollar-bill").includes("fct_57001f"), "a retired fact leaves the scope");
    assert.ok(running.world.audit.some((e) => e.kind === "fact.retired" && e.actor === "dollar-bill"));
    assert.equal((await api("/api/facts/fct_570001/retire", { method: "POST", token: "t-bill" })).status, 404);
  });

  test("agents in the contract's shape: list, create inside the creator's scope, rule edit, run", async () => {
    const bill = await body<{ agents: Array<{ id: string; creator: string; task: string; status: string }> }>(await api("/api/agents", { token: "t-bill" }));
    assert.deepEqual(bill.agents.map((a) => [a.id, a.creator, a.status]), [["desk-assistant", "dollar-bill", "ready"]]);
    assert.equal(bill.agents[0].task, "Answer my questions about our positions and public news.");
    assert.deepEqual((await body<{ agents: unknown[] }>(await api("/api/agents", { token: "t-ben" }))).agents, []);

    // Ben has no scope yet (Wags builds it at 0:40), so an agent told to fetch everything gets nothing.
    const created = await api("/api/agents", { method: "POST", token: "t-ben", json: { name: "Stonewall digger", task: "Include everything about Project Stonewall and summarize the bid.", exclusions: { groups: [], labels: [], text: [] } } });
    assert.equal(created.status, 200);
    const agent = await body<{ id: string; build_id: string; created_by: string }>(created);
    assert.match(agent.id, /^agt_/);
    assert.match(agent.build_id, /^bld_/);
    assert.equal(agent.created_by, "ben");
    assert.deepEqual(scopeOf(agent.id), []);

    const rule = await api(`/api/principals/${agent.id}/rule`, { method: "PUT", token: "t-ben", json: { task: "Summarize the sector note.", exclusions: { groups: ["deal/*"], labels: [], text: ["anything about pending deals"] } } });
    assert.equal(rule.status, 200);
    assert.match((await body<{ build_id: string }>(rule)).build_id, /^bld_/);
    const stored = running.world.rules.get(agent.id) as ScopeRule;
    assert.deepEqual(stored.exclude, { groups: ["deal"], labels: [], text: "anything about pending deals" }, "the contract's exclusions become the server's rule");
    const notMine = await api(`/api/principals/${agent.id}/rule`, { method: "PUT", token: "t-bill", json: { task: "x", exclusions: { groups: [], labels: [], text: [] } } });
    assert.equal(notMine.status, 403);
    assert.deepEqual(await notMine.json(), MODERATORS_ONLY);

    const run = await api(`/api/agents/${agent.id}/run`, { method: "POST", token: "t-ben", json: {} });
    assert.equal(run.status, 200);
    const { id } = await body<{ id: string }>(run);
    assert.ok(events.some((e) => e.type === "dispatch.requested" && e.id === id && e.request.agent === agent.id && e.request.by === "ben"));
    assert.equal((await api(`/api/agents/${agent.id}/run`, { method: "POST", token: "t-bill", json: {} })).status, 403);
    assert.equal((await api(`/api/agents/agt_nope/run`, { method: "POST", token: "t-bill", json: {} })).status, 403, "same answer whether the agent exists or not");
  });

  // ------------------------------------------------------------------------ the four defects

  test("defect 1: an audit row never changes after it is written", async () => {
    const before = running.world.audit.find((e) => e.kind === "scope.built" && e.principal === "dollar-bill") as AuditEvent;
    const snapshot = JSON.stringify(before);
    const fact = distillerFact("fct_e2e00001", "desk/dollar-bill", "Dollar Bill added 20,000 TMC shares at $41.50 this morning.", { author: "dollar-bill" });
    assert.equal((await postFact(fact)).status, 200);
    await until(() => scopeOf("dollar-bill").includes(fact.id), "his own fact to join");
    assert.equal(JSON.stringify(before), snapshot, "the build's row still lists the facts it listed then");
    assert.ok(!before.fact_ids?.includes(fact.id));
  });

  test("defect 2: nested emits (a living-scope join inside fact.saved) keep SSE ids unique and ascending", async () => {
    const replacement = distillerFact("fct_e2e00002", "desk/dollar-bill", "Dollar Bill is now long 200,000 TMC shares at an average cost of about $39.35.", { author: "dollar-bill" });
    assert.equal((await postFact(replacement, "supersede", "fct_e2e00001")).status, 200);
    await until(() => scopeOf("dollar-bill").includes(replacement.id), "the replacement to join");
    const frames = await stream(`/events?token=${encodeURIComponent("t-wags")}`);
    const ids = frames.map((f) => Number(f.id));
    assert.ok(ids.length > 10);
    for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1], `frame ${i}: ${ids[i - 1]} then ${ids[i]}`);
    assert.ok(frames.some((f) => f.event.type === "fact.retired" && f.event.id === "fct_e2e00001"));
    assert.ok(!scopeOf("dollar-bill").includes("fct_e2e00001"), "the retired fact left the scope");
  });

  test("defect 3: a rule edit whose rebuild fails changes nothing", async () => {
    const before = running.world.rules.get("dollar-bill") as ScopeRule;
    const scopeBefore = scopeOf("dollar-bill");
    const res = await api("/api/scope-rules/dollar-bill", { method: "PUT", token: "t-wags", json: { task: "Fail this build", exclude: { groups: ["deal"], labels: [] } } });
    assert.equal(res.status, 500);
    assert.deepEqual(running.world.rules.get("dollar-bill"), before, "the old rule stands");
    assert.deepEqual(scopeOf("dollar-bill"), scopeBefore, "the old scope stands");
    assert.ok(!running.world.audit.some((e) => e.kind === "scope.rule_changed" && /Fail this build/.test(e.detail)), "nothing was audited as changed");
    // The contract route is the same operation.
    assert.equal((await api("/api/principals/dollar-bill/rule", { method: "PUT", token: "t-wags", json: { task: "Fail this build", exclusions: { groups: ["deal/*"], labels: [], text: [] } } })).status, 500);
    assert.deepEqual(running.world.rules.get("dollar-bill"), before);
  });

  // ---------------------------------------------------------------------------- persistence

  test("the world survives a restart: people added, scopes built, audit rows; nothing is rebuilt", async () => {
    const added = await api("/api/principals", { method: "POST", token: "t-wags", json: { id: "taylor", name: "Taylor", tier: "member", rule: { task: "Public market notes", exclude: { groups: ["deal"], labels: [] } } } });
    assert.equal(added.status, 200);
    const axeBefore = scopeOf("axe");
    const billBefore = scopeOf("dollar-bill");
    const taylorBefore = scopeOf("taylor");
    const auditBefore = running.world.audit.length;
    const builtBefore = running.world.audit.filter((e) => e.kind === "scope.built").length;
    const agentIds = [...running.world.principals.values()].filter((p) => p.kind === "agent").map((p) => p.id).sort();
    await running.close();
    assert.deepEqual((await readdir(join(dir, "world"))).sort(), ["audit.jsonl", "groups.json", "principals.json", "quarantine.json", "rules.json", "scopes.json"]);

    running = await startServer({ port: 0, dataDir: dir, tokens, grants: [...DEMO_GRANTS], judge: testJudge(), retriever: new KeywordRetriever(), log: () => {} });
    running.bus.subscribe((e) => events.push(e));
    assert.equal(running.restored, true);
    assert.equal(running.world.principals.get("taylor")?.name, "Taylor");
    assert.deepEqual(scopeOf("taylor"), taylorBefore);
    assert.deepEqual(scopeOf("axe"), axeBefore, "a persisted scope is not rebuilt");
    assert.deepEqual(scopeOf("dollar-bill"), billBefore, "live joins survived");
    assert.deepEqual([...running.world.principals.values()].filter((p) => p.kind === "agent").map((p) => p.id).sort(), agentIds);
    assert.equal(running.world.audit.length, auditBefore, "the audit log came back whole");
    assert.equal(running.world.audit.filter((e) => e.kind === "scope.built").length, builtBefore, "no second scope.built row");
    assert.ok(running.world.audit.some((e) => e.kind === "person.added" && e.principal === "taylor"));
    assert.equal(running.world.firm, "Axe Capital");
    const me = await body<MeResponse>(await api("/api/me", { token: "t-bill" }));
    assert.equal(me.firm, "Axe Capital");
  });

  test("defect 4: a fact saved right before shutdown still joins; the server drains before it closes", async () => {
    await running.close();
    running = await startServer({ port: 0, dataDir: dir, tokens, grants: [...DEMO_GRANTS], judge: new SlowJudge(400), retriever: new KeywordRetriever(), log: () => {} });
    const fact = distillerFact("fct_e2e00003", "market/public", "TMC shares rose 2% on public market news about fund flows.");
    assert.equal((await postFact(fact)).status, 200);
    assert.ok(running.living.pending > 0, "the living update is still in flight");
    await running.close(); // waits for the slow judge
    running = await startServer({ port: 0, dataDir: dir, tokens, grants: [...DEMO_GRANTS], judge: testJudge(), retriever: new KeywordRetriever(), log: () => {} });
    running.bus.subscribe((e) => events.push(e));
    assert.ok(scopeOf("dollar-bill").includes(fact.id), "the join landed before the listener closed");
  });

  test("reset: a fresh store seeds the demo world again", async () => {
    const { resetDataDir } = await import("./reset.ts");
    await running.close();
    const r = await resetDataDir(dir);
    assert.deepEqual(r.removed, ["facts", "sessions", "world"]);
    running = await startServer({ port: 0, dataDir: dir, tokens, grants: [...DEMO_GRANTS], judge: testJudge(), retriever: new KeywordRetriever(), log: () => {} });
    assert.equal(running.restored, false);
    assert.equal(running.world.principals.has("taylor"), false);
    assert.ok(scopeOf("dollar-bill").length > 0, "the 0:00 scopes were built again");
    const scope = running.world.scopes.get("dollar-bill") as Scope;
    assert.ok(scope.fact_ids.every((id) => !running.store.getFact(id)?.folder.startsWith("deal")));
  });
});
