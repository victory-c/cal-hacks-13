// Scopes over real HTTP on port 0, seeded with the synthetic world: tier enforcement (one neutral
// 403 body on moderator routes, sent whether the target exists or not), internal-client gates,
// the real scope builder (exclusions in code → retriever candidates → batched judge yes/no, with
// measured scope.stage events), the agent-scope-subset property, living scopes, the handoff
// pipeline with the pinned profile (search inside the scope → inject-nothing → Jev relevance →
// budget → audit) and the contract shapes from shared/src/types/api.ts. The judge is the fake with the simulated scope answers —
// exactly what the offline demo runs — plus a per-test override hook and a question log, so the
// tests can both steer single answers (a "maybe") and prove what the judge was never asked.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { DEMO_GRANTS, FakeJudge, estimateTokens, folderAllows } from "@canon/shared";
import type {
  Answer,
  AuditEvent,
  CanonEvent,
  Fact,
  Folder,
  Group,
  HandoffResult,
  Judge,
  Principal,
  QuarantineItem,
  Question,
  Scope,
  ScopeRule,
} from "@canon/shared";

import { startServer } from "./app.ts";
import type { RunningServer } from "./app.ts";
import { EventBus } from "./events.ts";
import { KeywordRetriever } from "./retrieval/keyword.ts";
import { simulatedScopeAnswers } from "./scope-judge.ts";
import { FALCON_TEST_GRANTS, ScopeState, buildScope, loadWorldFixtures } from "./scopes.ts";
import { FALCON_FIXTURES_DIR, FIXTURES_DIR, seedDataDir } from "./seed.ts";

const tokens = new Map([
  ["tok-maya", "maya"],
  ["tok-dan", "dan"],
  ["tok-priya", "priya"],
  ["tok-leo", "leo"],
  ["tok-dist", "distiller"],
  ["tok-disp", "dispatcher"],
]);

const MODERATORS_ONLY = { error: "moderators only" };

describe("scopes REST surface, scope builder and handoff (A2, A4+A6, A7+A16)", () => {
  let dir: string;
  let running: RunningServer;
  let events: CanonEvent[];
  const originalInfo = console.info;

  // Every judge batch and every retriever query, so a test can prove what was (and never was)
  // put in front of a model or the search index.
  const askLog: Question[][] = [];
  const searchLog: Array<{ query: string; folders: readonly Folder[] }> = [];
  // A test-scoped answer override; reset to undefined after use. Wins over the simulated answers.
  let testAnswers: ((q: Question) => Answer | undefined) | undefined;

  class RecordingRetriever extends KeywordRetriever {
    override async search(query: string, opts: { folders: readonly Folder[]; k: number }) {
      searchLog.push({ query, folders: opts.folders });
      return super.search(query, opts);
    }
  }

  const api = (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.json !== undefined) headers["content-type"] = "application/json";
    return fetch(`${running.url}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  };
  const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;
  /** Living-scope updates run async off the bus; poll instead of sleeping a fixed time. */
  const until = async (pred: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail(`timed out waiting for ${what}`);
  };

  before(async () => {
    console.info = () => {};
    dir = await mkdtemp(join(tmpdir(), "canon-scopes-"));
    // The Falcon test world: its facts (fct_fa1c…, fct_ab11…, …) are what its scopes.json references.
    await seedDataDir(dir, FIXTURES_DIR, false);
    await seedDataDir(dir, FALCON_FIXTURES_DIR, false);
    const inner = new FakeJudge({ override: (q, s) => testAnswers?.(q) ?? simulatedScopeAnswers(q, s) });
    const judge: Judge = {
      name: "fake",
      ask: (state, questions) => {
        askLog.push(questions);
        return inner.ask(state, questions);
      },
    };
    running = await startServer({ port: 0, dataDir: dir, tokens, grants: [...DEMO_GRANTS, ...FALCON_TEST_GRANTS], judge, retriever: new RecordingRetriever(), world: loadWorldFixtures(), log: () => {} });
    events = [];
    running.bus.subscribe((e) => events.push(e));
  });
  after(async () => {
    await running.close();
    await rm(dir, { recursive: true, force: true });
    console.info = originalInfo;
  });

  test("every scopes route needs a token", async () => {
    for (const [method, path] of [
      ["GET", "/api/groups"],
      ["GET", "/api/principals"],
      ["GET", "/api/scope-rules/dan"],
      ["GET", "/api/scopes/dan"],
      ["GET", "/api/quarantine"],
      ["GET", "/api/audit"],
      ["POST", "/api/handoff"],
      ["POST", "/api/dispatch"],
      ["POST", "/api/events"],
    ] as const) {
      assert.equal((await api(path, { method })).status, 401, `${method} ${path}`);
    }
  });

  test("GET /api/groups: moderators and internal clients read it; a member sees only scoped groups", async () => {
    const maya = await api("/api/groups", { token: "tok-maya" });
    assert.equal(maya.status, 200);
    const { groups } = await body<{ groups: Group[] }>(maya);
    assert.deepEqual(groups.map((g) => g.id).sort(), ["deal/falcon", "desk/trading", "firm/ops", "market/public", "research/logistics"]);

    assert.equal((await api("/api/groups", { token: "tok-dist" })).status, 200, "triage reads the groups");

    const dan = await api("/api/groups", { token: "tok-dan" });
    assert.equal(dan.status, 200);
    const scoped = await dan.json() as { groups: Array<Record<string, unknown>> };
    const visible = new Set(running.world.scopes.get("dan")!.fact_ids.map((id) => running.store.getFact(id)?.folder));
    assert.ok(scoped.groups.every((group) => visible.has(String(group.id)) && !("aliases" in group) && !("description" in group)));
  });

  test("moderator routes return one identical 403 to members, whether the target exists or not", async () => {
    const deny = async (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) => {
      const res = await api(path, { token: "tok-dan", ...init });
      assert.equal(res.status, 403, path);
      assert.deepEqual(await res.json(), MODERATORS_ONLY, path);
    };
    await deny("/api/principals");
    await deny("/api/principals", { method: "POST", json: { id: "eve", name: "Eve", tier: "member" } });
    await deny("/api/principals/dan/tier", { method: "POST", json: { tier: "moderator" } });
    // His own rule (members never see their exclusions), another member's, and a principal that
    // does not exist: byte-identical responses, so nothing is revealed by the difference.
    await deny("/api/scope-rules/dan");
    await deny("/api/scope-rules/priya");
    await deny("/api/scope-rules/ghost");
    await deny("/api/scopes/dan");
    await deny("/api/scopes/ghost");
    await deny("/api/scopes/dan/facts");
    await deny("/api/quarantine");
    await deny("/api/audit");
  });

  test("GET /api/principals and /api/principals/:id: moderators and internal clients; writes stay moderator-only", async () => {
    assert.equal((await api("/api/principals", { token: "tok-dist" })).status, 200, "triage resolves who is who");

    const one = await api("/api/principals/leo", { token: "tok-maya" });
    assert.equal(one.status, 200);
    assert.deepEqual(await body<Principal>(one), { id: "leo", kind: "person", name: "Leo", tier: "member" });
    assert.equal((await api("/api/principals/agt_leodesk", { token: "tok-disp" })).status, 200, "the dispatcher reads an agent's record");
    assert.equal((await api("/api/principals/ghost", { token: "tok-maya" })).status, 404, "a moderator may learn a principal is missing");

    // Members get the neutral 403, same bytes whether the target exists or not, before any lookup.
    for (const path of ["/api/principals/leo", "/api/principals/ghost"]) {
      const denied = await api(path, { token: "tok-dan" });
      assert.equal(denied.status, 403, path);
      assert.deepEqual(await denied.json(), MODERATORS_ONLY, path);
    }

    const write = await api("/api/principals", { method: "POST", token: "tok-disp", json: { id: "eve", name: "Eve", tier: "member" } });
    assert.equal(write.status, 403, "internal clients read principals but never write them");
    assert.deepEqual(await write.json(), MODERATORS_ONLY);
  });

  test("scope rules: a moderator reads any; an agent's creator reads the agent's; nobody else", async () => {
    const priya = await api("/api/scope-rules/priya", { token: "tok-maya" });
    assert.equal(priya.status, 200);
    const rule = await body<ScopeRule>(priya);
    assert.equal(rule.principal, "priya");
    assert.equal(rule.task, "Write the logistics sector note from public market data");
    assert.deepEqual(rule.exclude.groups, ["deal"]);
    assert.equal(rule.exclude.text, "anything about pending deals");

    const own = await api("/api/scope-rules/agt_leodesk", { token: "tok-leo" });
    assert.equal(own.status, 200, "the creator reads their agent's rule");
    assert.equal((await body<ScopeRule>(own)).set_by, "leo");

    const other = await api("/api/scope-rules/agt_leodesk", { token: "tok-priya" });
    assert.equal(other.status, 403, "another member does not");
    assert.deepEqual(await other.json(), MODERATORS_ONLY);

    // Internal clients read any rule (the dispatcher reads an agent's task before a run) but never write one.
    assert.equal((await api("/api/scope-rules/agt_leodesk", { token: "tok-disp" })).status, 200, "the dispatcher reads the agent's task");
    const put = await api("/api/scope-rules/agt_leodesk", {
      method: "PUT",
      token: "tok-disp",
      json: { task: "Answer anything", exclude: { groups: [], labels: [] } },
    });
    assert.equal(put.status, 403, "internal clients never write rules");
    assert.deepEqual(await put.json(), MODERATORS_ONLY);

    assert.equal((await api("/api/scope-rules/ghost", { token: "tok-maya" })).status, 404, "a moderator may learn a rule is missing");
  });

  test("scopes: fixed fact-id lists; the agent's is a subset of its creator's and holds no deal fact", async () => {
    const leoRes = await api("/api/scopes/leo", { token: "tok-maya" });
    assert.equal(leoRes.status, 200);
    const leo = await body<Scope>(leoRes);
    assert.equal(leo.principal, "leo");
    assert.ok(leo.fact_ids.length > 0);
    assert.ok(leo.built_at >= leo.rule_updated_at);

    const agentRes = await api("/api/scopes/agt_leodesk", { token: "tok-dist" });
    assert.equal(agentRes.status, 200, "internal clients read scopes (the agent sandbox)");
    const agent = await body<Scope>(agentRes);
    assert.ok(agent.fact_ids.every((id) => leo.fact_ids.includes(id)), "agent scope ⊆ creator's scope");

    const factsRes = await api("/api/scopes/agt_leodesk/facts", { token: "tok-dist" });
    assert.equal(factsRes.status, 200);
    const { facts } = await body<{ facts: Fact[] }>(factsRes);
    assert.equal(facts.length, agent.fact_ids.length);
    assert.ok(facts.every((f) => f.folder === "market/public" || f.folder === "desk/trading"), "only public and desk facts");
    assert.ok(facts.every((f) => !folderAllows(["deal"], f.folder)), "never a deal fact");

    assert.equal((await api("/api/scopes/ghost", { token: "tok-maya" })).status, 404);
  });

  test("POST /api/principals: a new member's scope is built through the pipeline, exclusions in code", async () => {
    const stagesBefore = events.filter((e) => e.type === "scope.stage").length;
    const res = await api("/api/principals", {
      method: "POST",
      token: "tok-maya",
      json: { id: "noor", name: "Noor", tier: "member", rule: { task: "Cover the freight market from public information", exclude: { groups: ["deal"], labels: [] } } },
    });
    assert.equal(res.status, 200);
    const noor = await body<Principal>(res);
    assert.deepEqual(noor, { id: "noor", kind: "person", name: "Noor", tier: "member" });

    const { facts } = await body<{ facts: Fact[] }>(await api("/api/scopes/noor/facts", { token: "tok-maya" }));
    assert.ok(facts.length > 0, "the task-relevant facts joined");
    assert.ok(facts.some((f) => f.id === "fct_ab110001"), "public market facts match the task");
    assert.ok(facts.every((f) => !folderAllows(["deal", "inbox"], f.folder)), "deal/* removed in code; inbox never joins");
    assert.ok(!facts.some((f) => f.id === "fct_0f0e0001"), "a fact that matches nothing in the task stays out");

    // The scope contract shape, and the builder's stages with measured times (PRD #10).
    const scope = await body<Scope>(await api("/api/scopes/noor", { token: "tok-maya" }));
    assert.deepEqual(Object.keys(scope).sort(), ["built_at", "fact_ids", "principal", "rule_updated_at"]);
    assert.equal(scope.principal, "noor");
    assert.ok(Array.isArray(scope.fact_ids) && scope.fact_ids.every((fid) => typeof fid === "string"));
    assert.ok(!Number.isNaN(Date.parse(scope.built_at)) && !Number.isNaN(Date.parse(scope.rule_updated_at)));
    assert.ok(scope.built_at >= scope.rule_updated_at, "built from the current rule");
    const stages = events.slice(0).filter((e) => e.type === "scope.stage" && e.principal === "noor");
    assert.deepEqual(stages.map((s) => s.type === "scope.stage" && s.stage), ["exclusions", "moss", "jev", "done"], "every stage is shown, in order");
    for (const s of stages) {
      assert.ok(s.type === "scope.stage" && Number.isFinite(s.ms) && s.ms >= 0, "each stage carries a measured time");
      assert.ok(s.type === "scope.stage" && Number.isFinite(s.remaining) && s.remaining >= 0);
    }
    assert.ok(events.filter((e) => e.type === "scope.stage").length >= stagesBefore + 4);
    const built = events.find((e) => e.type === "audit.logged" && e.entry.kind === "scope.built" && e.entry.principal === "noor");
    assert.ok(built && built.type === "audit.logged");
    assert.match(built.entry.detail, /simulated/, "stub providers are labelled simulated in the audit row");
    assert.deepEqual(built.entry.fact_ids, scope.fact_ids, "the audit row records exactly the scope");

    const list = await body<{ principals: Principal[] }>(await api("/api/principals", { token: "tok-maya" }));
    assert.ok(list.principals.some((p) => p.id === "noor"));

    assert.ok(events.some((e) => e.type === "principal.changed" && e.change === "added" && e.principal.id === "noor"));
    assert.ok(events.some((e) => e.type === "scope.updated" && e.principal === "noor" && e.reason === "built"));
    assert.ok(events.some((e) => e.type === "audit.logged" && e.entry.kind === "person.added" && e.entry.principal === "noor"));
    assert.ok(events.some((e) => e.type === "audit.logged" && e.entry.kind === "scope.built" && e.entry.principal === "noor"));

    assert.equal((await api("/api/principals", { method: "POST", token: "tok-maya", json: { id: "noor", name: "Noor", tier: "member", rule: { task: "x", exclude: { groups: [], labels: [] } } } })).status, 409);
    assert.equal((await api("/api/principals", { method: "POST", token: "tok-maya", json: { id: "sam", name: "Sam", tier: "member" } })).status, 400, "a member needs a rule");
    assert.equal((await api("/api/principals", { method: "POST", token: "tok-maya", json: { id: "agt_x", name: "X", tier: "member", rule: { task: "x", exclude: { groups: [], labels: [] } } } })).status, 400, "people never use agt_");

    const tier = await api("/api/principals/noor/tier", { method: "POST", token: "tok-maya", json: { tier: "moderator" } });
    assert.equal(tier.status, 200);
    assert.equal((await body<Principal>(tier)).tier, "moderator");
    assert.ok(events.some((e) => e.type === "principal.changed" && e.change === "tier_changed" && e.principal.id === "noor"));
    assert.equal((await api("/api/principals/agt_leodesk/tier", { method: "POST", token: "tok-maya", json: { tier: "moderator" } })).status, 400, "an agent has no tier");
    assert.equal((await api("/api/principals/ghost/tier", { method: "POST", token: "tok-maya", json: { tier: "member" } })).status, 404);
  });

  test("POST /api/handoff (internal): only in-scope facts are candidates; the profile never shows exclusions", async () => {
    const res = await api("/api/handoff", { method: "POST", token: "tok-disp", json: { principal: "agt_leodesk", task: "Anything going on with Nimbus Logistics?", run_id: "run_0001" } });
    assert.equal(res.status, 200);
    const out = await body<HandoffResult>(res);

    assert.ok(out.facts.length > 0, "public Nimbus news is in scope and relevant");
    assert.ok(out.facts.every((f) => f.folder === "market/public"), "answers come from public market facts");
    assert.ok(out.facts.some((f) => f.id === "fct_ab110001"), "the Q3 print is the top hit");
    const served = JSON.stringify(out);
    assert.ok(!served.includes("fct_fa1c"), "no deal/falcon fact is named, counted or hinted at");
    assert.ok(!served.includes("deal/falcon"), "not even as a group name");

    assert.equal(out.profile.includes("Answer Leo's questions about our positions and public news"), true, "the profile shows the task");
    assert.ok(!/exclu|deal/i.test(out.profile), "never the exclusions");

    assert.ok(out.candidates.length >= out.facts.length, "every in-scope fact considered is listed");
    assert.ok(out.candidates.every((c) => c.cut === null || c.cut === "relevance" || c.cut === "budget"));
    assert.ok(out.candidates.every((c) => c.group === "market/public" || c.group === "desk/trading"), "candidates only ever come from inside the scope");
    assert.equal(typeof out.tokens, "number");
    assert.equal(typeof out.latency_ms, "number");
    assert.equal(out.inject_nothing, false);

    const handoffEvent = events.find((e) => e.type === "handoff.served" && e.principal === "agt_leodesk");
    assert.ok(handoffEvent && handoffEvent.type === "handoff.served");
    assert.equal(handoffEvent.run_id, "run_0001");
    assert.equal(handoffEvent.budget_tokens, 1500);
    assert.deepEqual(handoffEvent.fact_ids, out.facts.map((f) => f.id));

    const { entries } = await body<{ entries: AuditEvent[] }>(await api("/api/audit", { token: "tok-maya" }));
    const row = entries.find((e) => e.id === out.audit_id);
    assert.ok(row, "the handoff is in the audit log");
    assert.equal(row.kind, "handoff");
    assert.equal(row.run_id, "run_0001");
    assert.deepEqual(row.fact_ids, out.facts.map((f) => f.id));

    // The budget cut: a tiny budget drops facts (cut: "budget") down to the pinned profile alone.
    const tiny = await body<HandoffResult>(await api("/api/handoff", { method: "POST", token: "tok-disp", json: { principal: "agt_leodesk", task: "Anything going on with Nimbus Logistics?", budget_tokens: 10 } }));
    assert.equal(tiny.inject_nothing, true);
    assert.deepEqual(tiny.facts, []);
    assert.ok(tiny.candidates.some((c) => c.cut === "budget"), "relevant facts were cut by the budget");
    assert.ok(tiny.profile.length > 0, "the profile is always sent");

    const member = await api("/api/handoff", { method: "POST", token: "tok-leo", json: { principal: "leo", task: "What are my positions?" } });
    assert.equal(member.status, 200, "a person may ask for their own memory");
    assert.equal("candidates" in (await body<Record<string, unknown>>(member)), false, "a person never sees what was considered");
    assert.equal((await api("/api/handoff", { method: "POST", token: "tok-dist", json: { principal: "ghost", task: "x" } })).status, 404, "internal callers may see a 404");
    assert.equal((await api("/api/handoff", { method: "POST", token: "tok-dist", json: { principal: "agt_leodesk", task: "" } })).status, 400);
  });

  // --------------------------------------------------------- the real handoff pipeline (A7+A16)

  const handoff = async (json: Record<string, unknown>): Promise<HandoffResult> => {
    const res = await api("/api/handoff", { method: "POST", token: "tok-disp", json });
    assert.equal(res.status, 200);
    return body<HandoffResult>(res);
  };

  test("handoff: Jev relevance is one batched call after the needs-context check; a judged-out fact is cut as 'relevance' with its p", async () => {
    const asksBefore = askLog.length;
    testAnswers = (q) => (q.id === "hf:fct_ab110002" ? { id: q.id, type: "noul", p: 0.2 } : undefined);
    let out: HandoffResult;
    try {
      out = await handoff({ principal: "agt_leodesk", task: "Anything going on with Nimbus Logistics?" });
    } finally {
      testAnswers = undefined;
    }
    const asked = askLog.slice(asksBefore);
    assert.equal(asked.length, 2, "two decisions, one ask() each: needs-context, then relevance");
    assert.equal(asked[0].length, 1, "the inject-nothing check is its own single-question decision");
    assert.match(asked[0][0].text, /need any stored context/);
    assert.equal(asked[1].length, out.candidates.length, "relevance is one batch with one question per candidate");
    assert.ok(asked[1].every((q) => q.id.startsWith("hf:")));

    assert.ok(!out.facts.some((f) => f.id === "fct_ab110002"), "the judged-out fact was not handed over");
    const cutOne = out.candidates.find((c) => c.fact_id === "fct_ab110002");
    assert.ok(cutOne);
    assert.equal(cutOne.cut, "relevance");
    assert.equal(cutOne.p, 0.2, "Jev's p is shown to the inspector");
    const pOf = (id: string) => out.candidates.find((c) => c.fact_id === id)?.p ?? 0;
    assert.ok(out.facts.length > 0 && out.facts.every((f) => pOf(f.id) >= 0.7), "kept facts clear the relevance bar");
    const ps = out.facts.map((f) => pOf(f.id));
    assert.deepEqual([...ps].sort((a, b) => b - a), ps, "kept facts are ordered best-first");
  });

  test("handoff: the inject-nothing check sends only the pinned profile and skips the relevance call", async () => {
    const asksBefore = askLog.length;
    testAnswers = (q) => (q.id === "needs" ? { id: q.id, type: "noul", p: 0.1 } : undefined);
    let out: HandoffResult;
    try {
      out = await handoff({ principal: "agt_leodesk", task: "Anything going on with Nimbus Logistics?" });
    } finally {
      testAnswers = undefined;
    }
    assert.equal(out.inject_nothing, true);
    assert.deepEqual(out.facts, []);
    assert.equal(out.tokens, 0);
    assert.ok(out.profile.includes("Answer Leo's questions about our positions and public news"), "the pinned profile still goes out");
    assert.ok(out.candidates.length > 0 && out.candidates.every((c) => c.cut === "relevance" && c.p === undefined), "search candidates show as cut, unscored");
    const asked = askLog.slice(asksBefore);
    assert.equal(asked.length, 1, "the relevance batch was never asked");

    // The audit row records exactly what was sent: nothing, by whom, for whom.
    const { entries } = await body<{ entries: AuditEvent[] }>(await api("/api/audit", { token: "tok-maya" }));
    const row = entries.find((e) => e.id === out.audit_id);
    assert.ok(row);
    assert.equal(row.kind, "handoff");
    assert.equal(row.actor, "dispatcher");
    assert.equal(row.principal, "agt_leodesk");
    assert.deepEqual(row.fact_ids, []);
    assert.match(row.detail, /only the pinned profile went out/);
    assert.match(row.detail, /simulated/, "stub providers stay labelled in the audit row");
  });

  test("handoff: a request needing nothing stored injects nothing after one needs-context question", async () => {
    const asksBefore = askLog.length;
    const out = await handoff({ principal: "agt_leodesk", task: "Convert 3.7 kilograms to pounds" });
    assert.equal(out.inject_nothing, true);
    assert.deepEqual(out.facts, []);
    // A small scope is judged whole (JUDGE_ALL_UP_TO), so its facts are candidates, cut unscored.
    assert.ok(out.candidates.every((c) => c.cut === "relevance" && c.p === undefined));
    assert.ok(out.profile.length > 0, "the pinned profile is always sent");
    const asked = askLog.slice(asksBefore);
    assert.equal(asked.length, 1, "only the needs-context question; the relevance batch was never asked");
    assert.match(asked[0][0].text, /need any stored context/);
  });

  test("handoff: a small scope is judged whole, so a paraphrase the search misses still reaches the judge", async () => {
    const scope = await body<Scope>(await api("/api/scopes/agt_leodesk", { token: "tok-maya" }));
    const out = await handoff({ principal: "agt_leodesk", task: "zzqx" }); // shares no word with any fact
    assert.deepEqual(out.candidates.map((c) => c.fact_id).sort(), [...scope.fact_ids].sort());
  });

  test("handoff: the budget keeps the best facts that fit, in code", async () => {
    const full = await handoff({ principal: "agt_leodesk", task: "Anything going on with Nimbus Logistics?" });
    assert.ok(full.facts.length >= 2, "the full budget serves several facts");
    const firstCost = full.candidates.find((c) => c.fact_id === full.facts[0].id)?.tokens;
    assert.ok(typeof firstCost === "number" && firstCost > 0);
    const trimmed = await handoff({ principal: "agt_leodesk", task: "Anything going on with Nimbus Logistics?", budget_tokens: firstCost });
    assert.deepEqual(trimmed.facts.map((f) => f.id), [full.facts[0].id], "only the best fact fits the budget");
    assert.ok(trimmed.tokens <= firstCost);
    assert.ok(trimmed.candidates.some((c) => c.cut === "budget"), "the rest were cut by the budget, not relevance");
    assert.equal(trimmed.inject_nothing, false);
  });

  test("handoff: a request about an excluded deal gets an ordinary slice that names, counts and hints at nothing", async () => {
    const asksBefore = askLog.length;
    // Priya's scope excludes deal/*; she (or her AI) asks straight for the deal anyway.
    const res = await api("/api/handoff", { method: "POST", token: "tok-disp", json: { principal: "priya", task: "What price did we settle for the Falcon LOI on Nimbus?" } });
    assert.equal(res.status, 200, "never a refusal");
    const out = await body<HandoffResult>(res);
    const served = JSON.stringify(out);
    assert.ok(!served.includes("fct_fa1c"), "no deal fact is named");
    assert.ok(!/deal\/falcon|Corvane|38\.50|break fee/i.test(served), "no deal detail leaks through any field");
    assert.ok(!/refus|restricted|not allowed|cannot|excluded/i.test(served), "no refusal text hints that something was withheld");
    assert.ok(out.candidates.every((c) => c.group !== "deal/falcon"), "nothing outside the scope was ever a candidate");
    for (const q of askLog.slice(asksBefore).flat()) {
      assert.ok(!q.text.includes("fct_fa1c") && !/Corvane|38\.50/.test(q.text), "no excluded fact ever reached the judge");
    }
  });

  test("A16: the pinned profile is name, tier and task inside ~200 tokens — never the exclusions", async () => {
    const out = await handoff({ principal: "priya", task: "Update the logistics note" });
    assert.ok(out.profile.includes("Priya"));
    assert.ok(out.profile.includes("member"));
    assert.ok(out.profile.includes("Write the logistics sector note from public market data"), "the task comes from the scope rule");
    assert.ok(estimateTokens(out.profile) <= 200, "the profile stays inside its ~200-token pin");
    // Her rule excludes deal/* with the text "anything about pending deals": none of it may show.
    assert.ok(!/exclu|deal|pending/i.test(out.profile));
  });

  test("handoff: a person reads only their own memory; naming anyone else is one identical 403", async () => {
    const other = await api("/api/handoff", { method: "POST", token: "tok-leo", json: { principal: "dan", task: "x" } });
    const ghost = await api("/api/handoff", { method: "POST", token: "tok-leo", json: { principal: "ghost", task: "x" } });
    assert.equal(other.status, 403);
    assert.equal(ghost.status, 403);
    assert.deepEqual(await other.json(), await ghost.json(), "the same bytes whether the principal exists or not");

    // With no principal, the token's own is used; the reply holds only facts inside that scope.
    const mine = await api("/api/handoff", { method: "POST", token: "tok-leo", json: { task: "What are my positions?" } });
    assert.equal(mine.status, 200);
    const out = await body<Omit<HandoffResult, "candidates">>(mine);
    const leo = await body<Scope>(await api("/api/scopes/leo", { token: "tok-maya" }));
    assert.ok(out.facts.every((f) => leo.fact_ids.includes(f.id)), "only Leo's own scope is served");
    assert.match(out.profile, /^Leo \(leo\)/);
    const { entries } = await body<{ entries: AuditEvent[] }>(await api("/api/audit", { token: "tok-maya" }));
    assert.ok(entries.some((e) => e.id === out.audit_id && e.actor === "leo" && e.principal === "leo"), "audited with the person as actor");
  });

  test("PUT /api/scope-rules/:principal rebuilds the scope through the full pipeline", async () => {
    const beforeScope = await body<Scope>(await api("/api/scopes/priya", { token: "tok-maya" }));
    assert.ok(beforeScope.fact_ids.includes("fct_ab110001"), "the Nimbus Q3 fact starts in Priya's scope");

    const res = await api("/api/scope-rules/priya", {
      method: "PUT",
      token: "tok-maya",
      json: { task: "Write the logistics sector note from public market data", exclude: { groups: ["deal"], labels: ["nimbus"], text: "anything about pending deals" } },
    });
    assert.equal(res.status, 200);
    const rule = await body<ScopeRule>(res);
    assert.equal(rule.set_by, "maya");
    assert.deepEqual(rule.exclude.labels, ["nimbus"]);

    const afterScope = await body<Scope>(await api("/api/scopes/priya", { token: "tok-maya" }));
    for (const gone of ["fct_ab110001", "fct_ab110002", "fct_10610002"]) {
      assert.ok(!afterScope.fact_ids.includes(gone), `${gone} carries the excluded label (code, before any model)`);
    }
    assert.ok(!afterScope.fact_ids.some((id) => id.startsWith("fct_fa1c")), "deal/* stays excluded in code");
    assert.ok(afterScope.fact_ids.includes("fct_ab110003"), "Priya's own public-market fact stays (own facts join unless excluded)");
    assert.ok(afterScope.fact_ids.includes("fct_10610001"), "her sector note stays");
    for (const gone of ["fct_0f0e0001", "fct_0f0e0002"]) {
      assert.ok(!afterScope.fact_ids.includes(gone), `${gone} helps nothing in the task: the real builder drops it`);
    }
    assert.equal(afterScope.rule_updated_at, rule.updated_at, "rebuilt from the new rule");

    const update = events.find((e) => e.type === "scope.updated" && e.principal === "priya" && e.reason === "rule_changed");
    assert.ok(update && update.type === "scope.updated");
    assert.ok(update.removed.includes("fct_ab110001"));
    assert.ok(events.some((e) => e.type === "audit.logged" && e.entry.kind === "scope.rule_changed" && e.entry.principal === "priya"));

    assert.equal((await api("/api/scope-rules/priya", { method: "PUT", token: "tok-maya", json: { task: "", exclude: { groups: [], labels: [] } } })).status, 400);
    assert.equal((await api("/api/scope-rules/priya", { method: "PUT", token: "tok-maya", json: { task: "x", exclude: { groups: ["NOT A GROUP"], labels: [] } } })).status, 400);
  });

  test("agents: members create only their own; the scope is capped by the creator's; delete is creator-or-moderator", async () => {
    const res = await api("/api/agents", {
      method: "POST",
      token: "tok-leo",
      json: { created_by: "leo", name: "News bot", rule: { task: "Summarize public logistics news for the desk", exclude: { groups: [], labels: [] } } },
    });
    assert.equal(res.status, 200);
    const agent = await body<Principal>(res);
    assert.match(agent.id, /^agt_[0-9a-f]+$/);
    assert.deepEqual([agent.kind, agent.created_by, agent.tier], ["agent", "leo", undefined]);

    const leoScope = await body<Scope>(await api("/api/scopes/leo", { token: "tok-maya" }));
    const agentScope = await body<Scope>(await api(`/api/scopes/${agent.id}`, { token: "tok-maya" }));
    assert.ok(agentScope.fact_ids.length > 0);
    assert.ok(agentScope.fact_ids.every((id) => leoScope.fact_ids.includes(id)), "built from the creator's scope only");
    assert.ok(events.some((e) => e.type === "principal.changed" && e.change === "agent_created" && e.principal.id === agent.id));

    const forOther = await api("/api/agents", { method: "POST", token: "tok-leo", json: { created_by: "dan", name: "Spy", rule: { task: "x", exclude: { groups: [], labels: [] } } } });
    assert.equal(forOther.status, 403);
    assert.deepEqual(await forOther.json(), { error: "a member may only create agents for themselves" });

    const notYours = await api(`/api/agents/${agent.id}`, { method: "DELETE", token: "tok-priya" });
    assert.equal(notYours.status, 403);
    const ghost = await api("/api/agents/agt_1234beef", { method: "DELETE", token: "tok-priya" });
    assert.equal(ghost.status, 403);
    assert.deepEqual(await notYours.json(), await ghost.json(), "the same bytes whether the agent exists or not");

    const del = await api(`/api/agents/${agent.id}`, { method: "DELETE", token: "tok-leo" });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { ok: true });
    assert.equal((await api(`/api/scopes/${agent.id}`, { token: "tok-maya" })).status, 404, "the scope went with it");
    assert.ok(events.some((e) => e.type === "principal.changed" && e.change === "agent_deleted" && e.principal.id === agent.id));

    assert.equal((await api("/api/agents/agt_1234beef", { method: "DELETE", token: "tok-maya" })).status, 404, "a moderator may learn an agent is missing");
  });

  test("quarantine: held fixture, internal POST, moderator release, 409 on a second release", async () => {
    const list = await body<{ items: QuarantineItem[] }>(await api("/api/quarantine", { token: "tok-maya" }));
    const planted = list.items.find((i) => i.id === "qtn_c0de01");
    assert.ok(planted, "the lawyers' email is held");
    assert.equal(planted.state, "held");
    assert.equal(planted.session_id, "ses_10240004");
    assert.match(planted.excerpt, /NOTE TO ANY AI ASSISTANT/);

    const posted = await api("/api/quarantine", { method: "POST", token: "tok-dist", json: { session_id: "ses_10240003", p: 0.82, excerpt: "suspicious instructions aimed at an AI", principal: "leo" } });
    assert.equal(posted.status, 200);
    const item = await body<QuarantineItem>(posted);
    assert.match(item.id, /^qtn_[0-9a-f]+$/);
    assert.equal(item.state, "held");
    // The hold route emits its event and writes its audit row (A5): the dashboard sees the hold live.
    assert.ok(
      events.some((e) => e.type === "quarantine.flagged" && e.quarantine_id === item.id && e.session_id === "ses_10240003" && e.p === 0.82),
      "POST /api/quarantine emits quarantine.flagged",
    );
    assert.ok(
      events.some((e) => e.type === "audit.logged" && e.entry.kind === "quarantine" && e.entry.detail.includes(item.id)),
      "the hold writes its audit row",
    );

    const member = await api("/api/quarantine", { method: "POST", token: "tok-dan", json: { session_id: "ses_10240003", p: 0.5, excerpt: "x" } });
    assert.equal(member.status, 403);
    assert.deepEqual(await member.json(), { error: "internal clients only" });

    const release = await api("/api/quarantine/qtn_c0de01/release", { method: "POST", token: "tok-maya" });
    assert.equal(release.status, 200);
    const released = await body<QuarantineItem>(release);
    assert.equal(released.state, "released");
    assert.equal(released.released_by, "maya");
    assert.ok(released.released_at);
    assert.ok(events.some((e) => e.type === "quarantine.released" && e.item.id === "qtn_c0de01"));
    assert.ok(events.some((e) => e.type === "audit.logged" && e.entry.kind === "quarantine.released" && e.entry.detail.includes("qtn_c0de01")));

    assert.equal((await api("/api/quarantine/qtn_c0de01/release", { method: "POST", token: "tok-maya" })).status, 409);
    assert.equal((await api("/api/quarantine/qtn_ffff/release", { method: "POST", token: "tok-maya" })).status, 404);
  });

  test("GET /api/audit: moderators only, with ?principal= and ?since= filters", async () => {
    const all = await body<{ entries: AuditEvent[] }>(await api("/api/audit", { token: "tok-maya" }));
    assert.ok(all.entries.some((e) => e.id === "aud_0a000001"), "the fixture quarantine entry is there");
    assert.ok(all.entries.every((e, i) => i === 0 || all.entries[i - 1].at <= e.at), "sorted by time");

    const agent = await body<{ entries: AuditEvent[] }>(await api("/api/audit?principal=agt_leodesk", { token: "tok-maya" }));
    assert.ok(agent.entries.length > 0);
    assert.ok(agent.entries.every((e) => e.principal === "agt_leodesk"));

    const since = await body<{ entries: AuditEvent[] }>(await api("/api/audit?since=2026-10-24T00:00:00.000Z", { token: "tok-maya" }));
    assert.ok(since.entries.length > 0);
    assert.ok(since.entries.every((e) => e.at >= "2026-10-24T00:00:00.000Z"));
    assert.ok(!since.entries.some((e) => e.id === "aud_0a000001"), "the 10-23 entry is filtered out");

    assert.equal((await api("/api/audit?since=yesterday", { token: "tok-maya" })).status, 400);
  });

  test("POST /api/dispatch: the agent's creator or a moderator; body.by must be the caller", async () => {
    const res = await api("/api/dispatch", { method: "POST", token: "tok-leo", json: { agent: "agt_leodesk", by: "leo", stop_generation: 999 } });
    assert.equal(res.status, 200);
    const { id } = await body<{ id: string }>(res);
    assert.match(id, /^dsp_[0-9a-f]+$/);
    const requested = events.find((e) => e.type === "dispatch.requested" && e.id === id);
    assert.ok(requested && requested.type === "dispatch.requested");
    assert.deepEqual(requested.request, { agent: "agt_leodesk", by: "leo", stop_generation: 0 }, "the server stamps the cancellation generation, ignoring client claims");

    const other = await api("/api/dispatch", { method: "POST", token: "tok-priya", json: { agent: "agt_leodesk", by: "priya" } });
    assert.equal(other.status, 403);
    const ghost = await api("/api/dispatch", { method: "POST", token: "tok-priya", json: { agent: "agt_ghost", by: "priya" } });
    assert.equal(ghost.status, 403);
    assert.deepEqual(await other.json(), await ghost.json(), "the same bytes whether the agent exists or not");

    assert.equal((await api("/api/dispatch", { method: "POST", token: "tok-leo", json: { agent: "agt_leodesk", by: "dan" } })).status, 403, "by must be the caller");
    assert.equal((await api("/api/dispatch", { method: "POST", token: "tok-maya", json: { agent: "agt_leodesk", by: "maya" } })).status, 200, "a moderator may dispatch any agent");
  });

  test("POST /api/events: internal clients relay RELAYED_EVENTS; anything else is rejected", async () => {
    const res = await api("/api/events", {
      method: "POST",
      token: "tok-dist",
      json: { event: { type: "triage.decided", session_id: "ses_10240003", statement: "LKSP was up 6% on 2026-10-19", decision: { outcome: "fact", keep_p: 0.9, group: "desk/trading", group_p: 0.8, labels: [], injection_p: 0.01, relation: "unrelated", reason: "test", judge: "fake" } } },
    });
    assert.equal(res.status, 200);
    const { ok, at } = await body<{ ok: boolean; at: string }>(res);
    assert.equal(ok, true);
    assert.ok(events.some((e) => e.type === "triage.decided" && e.at === at), "re-broadcast on the bus with the stamped time");

    assert.equal((await api("/api/events", { method: "POST", token: "tok-dist", json: { event: { type: "fact.saved" } } })).status, 400, "only RELAYED_EVENTS types");
    const member = await api("/api/events", { method: "POST", token: "tok-leo", json: { event: { type: "agent.step" } } });
    assert.equal(member.status, 403);
  });

  // ------------------------------------------------------------ the real builder (A4+A6)

  test("scope builder: excluded facts never reach Moss or Jev, even when the task asks for them", async () => {
    const asksBefore = askLog.length;
    const res = await api("/api/principals", {
      method: "POST",
      token: "tok-maya",
      json: { id: "omar", name: "Omar", tier: "member", rule: { task: "Track Nimbus Logistics and anything about Project Falcon", exclude: { groups: ["deal"], labels: [] } } },
    });
    assert.equal(res.status, 200);
    const scope = await body<Scope>(await api("/api/scopes/omar", { token: "tok-maya" }));
    assert.ok(scope.fact_ids.includes("fct_ab110001"), "the public Nimbus facts join");
    assert.ok(!scope.fact_ids.some((fid) => fid.startsWith("fct_fa1c")), "no deal fact joins, although the task names Falcon");

    const asked = askLog.slice(asksBefore).flat();
    assert.ok(asked.length > 0, "the judge was consulted for the build");
    for (const q of asked) {
      assert.ok(!q.text.includes("fct_fa1c"), `an excluded fact reached the judge: ${q.text}`);
      assert.ok(!/Corvane|38\.50|LOI/.test(q.text), `deal-only detail reached the judge: ${q.text}`);
    }
    const search = searchLog.find((s) => s.query.startsWith("Track Nimbus"));
    assert.ok(search, "one retriever query per build");
    assert.ok(search.folders.every((f) => !folderAllows(["deal", "inbox"], f)), "the retriever only ever searches the post-exclusion groups");
  });

  test("scope builder: a 'maybe' on the exclusion question counts as excluded", async () => {
    testAnswers = (q) => (q.id === "xf:fct_ab110003" ? { id: q.id, type: "noul", p: 0.5 } : undefined); // a maybe on live Jev's scale, not a yes
    try {
      const res = await api("/api/principals", {
        method: "POST",
        token: "tok-maya",
        json: { id: "tess", name: "Tess", tier: "member", rule: { task: "Cover cold chain logistics names", exclude: { groups: ["deal"], labels: [], text: "bananas and umbrellas" } } },
      });
      assert.equal(res.status, 200);
    } finally {
      testAnswers = undefined;
    }
    const scope = await body<Scope>(await api("/api/scopes/tess", { token: "tok-maya" }));
    assert.ok(scope.fact_ids.includes("fct_de5c0001"), "a relevant fact the judge cleared joined (the relevance path works)");
    assert.ok(!scope.fact_ids.includes("fct_ab110003"), "the maybe-excluded fact stayed out although it matches the task");
  });

  test("scope builder: an agent scope that escapes its creator's fails loudly at build time", async () => {
    const world = new ScopeState(loadWorldFixtures());
    const retriever = new KeywordRetriever();
    await retriever.index(running.store.listFacts({ tier: "hot" }));
    const judge = new FakeJudge({
      override: (q) => {
        // A moderator narrows Leo while the agent's model call is in flight: the base was computed
        // from the old scope, so the yes answers would now exceed the creator.
        if (q.id.startsWith("rf:")) {
          world.scopes.get("leo")!.fact_ids = [];
          return { id: q.id, type: "noul", p: 0.9 };
        }
        return { id: q.id, type: "noul", p: 0.05 };
      },
    });
    const deps = { world, store: running.store, bus: new EventBus(), grants: [...DEMO_GRANTS, ...FALCON_TEST_GRANTS], judge, retriever };
    const agent = world.principals.get("agt_leodesk");
    const rule = world.rules.get("agt_leodesk");
    assert.ok(agent && rule);
    await assert.rejects(buildScope(deps, agent, rule, "maya"), /not a subset/, "violated subset is a loud error, never a silent trim");
  });

  // ------------------------------------------------------------- living scopes (PRD #11)

  const saveFacts = (entries: Array<{ fact: Fact; supersedes?: string }>) =>
    api("/api/facts", {
      method: "POST",
      token: "tok-dist",
      json: {
        facts: entries.map(({ fact, supersedes }) => ({
          fact,
          decision: { tier: fact.tier, folder: fact.folder, action: supersedes ? "supersede" : "add", ...(supersedes ? { supersedes } : {}), keep_p: 0.9, folder_p: 0.9, judge: "fake" },
        })),
      },
    });
  const factBase = { tier: "hot" as const, jev_keep: 0.9, updated: "2026-10-24" };

  test("living scopes: a member's own new fact always joins, and reaches their agent when it clears the agent's rule", async () => {
    const fact: Fact = {
      ...factBase,
      id: "fct_11fe0001",
      statement: "Leo opened a starter position in Larkspur Cold Chain (LKSP) on 2026-10-24",
      folder: "desk/trading",
      source: { client: "ingest", session: "ses_11fe0001" },
      author: "leo",
    };
    assert.equal((await saveFacts([{ fact }])).status, 200);

    await until(() => events.some((e) => e.type === "scope.updated" && e.principal === "leo" && e.reason === "fact_joined" && e.added.includes(fact.id)), "Leo's scope to gain his own fact");
    const leo = await body<Scope>(await api("/api/scopes/leo", { token: "tok-maya" }));
    assert.ok(leo.fact_ids.includes(fact.id), "own facts always join");

    await until(() => events.some((e) => e.type === "scope.updated" && e.principal === "agt_leodesk" && e.added.includes(fact.id)), "the agent to receive it at its next step");
    const agent = await body<Scope>(await api("/api/scopes/agt_leodesk", { token: "tok-maya" }));
    assert.ok(agent.fact_ids.includes(fact.id), "the creator holds it and it clears the agent's rule");
    assert.ok(agent.fact_ids.every((fid) => leo.fact_ids.includes(fid)), "the agent still never exceeds its creator");

    assert.ok(events.some((e) => e.type === "audit.logged" && e.entry.kind === "fact.joined_scope" && e.entry.principal === "leo" && e.entry.fact_ids?.includes(fact.id)), "the join is audited");
    const dan = await body<Scope>(await api("/api/scopes/dan", { token: "tok-maya" }));
    assert.ok(!dan.fact_ids.includes(fact.id), "someone else's scope gains nothing it has no use for");
  });

  test("living scopes: an inbox fact joins no scope, not even its author's", async () => {
    const fact: Fact = {
      ...factBase,
      id: "fct_11fe0002",
      statement: "Unplaced note about public market logistics data from Priya",
      folder: "inbox",
      source: { client: "ingest", session: "ses_11fe0002" },
      author: "priya",
    };
    assert.equal((await saveFacts([{ fact }])).status, 200);
    await new Promise((r) => setTimeout(r, 30)); // the handler bails before its first await, but don't rely on that
    assert.ok(!events.some((e) => e.type === "scope.updated" && e.reason === "fact_joined" && e.added.includes(fact.id)), "no scope gained it");
    assert.ok(!events.some((e) => e.type === "audit.logged" && e.entry.kind === "fact.joined_scope" && e.entry.fact_ids?.includes(fact.id)));
    const priya = await body<Scope>(await api("/api/scopes/priya", { token: "tok-maya" }));
    assert.ok(!priya.fact_ids.includes(fact.id), "not even the author's scope holds it until a moderator files it");
  });

  test("living scopes: others' facts join through the checks; excluded ones never reach the judge; retired ones leave", async () => {
    const pub: Fact = {
      ...factBase,
      id: "fct_11fe0003",
      statement: "Public market news: freight and logistics sector volumes rose in October",
      folder: "market/public",
      source: { client: "ingest", session: "ses_11fe0003" },
      author: "dan",
    };
    assert.equal((await saveFacts([{ fact: pub }])).status, 200);
    for (const who of ["priya", "leo", "agt_leodesk"]) {
      await until(() => events.some((e) => e.type === "scope.updated" && e.principal === who && e.added.includes(pub.id)), `${who} to gain the public fact`);
    }

    // A deal fact: Dan's own memory, so it joins him with no model call; everyone else's rule
    // excludes deal/* in code, so the judge is never asked about it at all.
    const asksBefore = askLog.length;
    const deal: Fact = {
      ...factBase,
      id: "fct_11fe0004",
      statement: "Falcon exclusivity extended after the Nimbus Logistics board meeting",
      folder: "deal/falcon",
      source: { client: "ingest", session: "ses_11fe0004" },
      author: "dan",
      labels: ["falcon", "nimbus"],
    };
    assert.equal((await saveFacts([{ fact: deal }])).status, 200);
    await until(() => events.some((e) => e.type === "scope.updated" && e.principal === "dan" && e.added.includes(deal.id)), "Dan's scope to gain his own deal fact");
    assert.equal(askLog.length, asksBefore, "the excluded fact never reached the judge: exclusions ran in code");
    for (const who of ["priya", "leo", "agt_leodesk"]) {
      const scope = await body<Scope>(await api(`/api/scopes/${who}`, { token: "tok-maya" }));
      assert.ok(!scope.fact_ids.includes(deal.id), `${who} never held the deal fact`);
    }

    // History: a superseding fact retires the old one, which leaves every scope; the new one joins.
    const pub2: Fact = {
      ...factBase,
      id: "fct_11fe0005",
      statement: "Public market news: logistics sector volumes revised down for October",
      folder: "market/public",
      source: { client: "ingest", session: "ses_11fe0005" },
      author: "dan",
      supersedes: pub.id,
    };
    assert.equal((await saveFacts([{ fact: pub2, supersedes: pub.id }])).status, 200);
    await until(() => events.some((e) => e.type === "scope.updated" && e.principal === "priya" && e.reason === "fact_left" && e.removed.includes(pub.id)), "the retired fact to leave");
    await until(() => events.some((e) => e.type === "scope.updated" && e.principal === "priya" && e.added.includes(pub2.id)), "its replacement to join");
    const priya = await body<Scope>(await api("/api/scopes/priya", { token: "tok-maya" }));
    assert.ok(!priya.fact_ids.includes(pub.id) && priya.fact_ids.includes(pub2.id), "replaced, not duplicated");
    assert.ok(events.some((e) => e.type === "audit.logged" && e.entry.kind === "fact.left_scope" && e.entry.fact_ids?.includes(pub.id)), "the departure is audited");
  });

  test("a rule edit rebuilds the member's scope and cascades to their agents before the next step", async () => {
    const res = await api("/api/scope-rules/leo", {
      method: "PUT",
      token: "tok-maya",
      json: { task: "Run the trading desk's book from its positions", exclude: { groups: ["deal", "market"], labels: [] } },
    });
    assert.equal(res.status, 200);

    const leo = await body<Scope>(await api("/api/scopes/leo", { token: "tok-maya" }));
    assert.ok(!leo.fact_ids.some((fid) => fid.startsWith("fct_ab11") || fid === "fct_11fe0005"), "market/* left Leo's scope in code");
    assert.ok(leo.fact_ids.includes("fct_11fe0001"), "his own desk fact stays");

    const agent = await body<Scope>(await api("/api/scopes/agt_leodesk", { token: "tok-maya" }));
    assert.ok(agent.fact_ids.length > 0, "the agent keeps what still clears both rules");
    assert.ok(agent.fact_ids.every((fid) => leo.fact_ids.includes(fid)), "the agent was rebuilt inside the creator's new scope");
    assert.ok(!agent.fact_ids.some((fid) => fid.startsWith("fct_ab11") || fid === "fct_11fe0005"), "the narrowed creator narrowed the agent");
    assert.ok(events.some((e) => e.type === "scope.updated" && e.principal === "agt_leodesk" && e.reason === "rule_changed"), "the cascade is visible on the feed");
  });

  test("an agent created by a moderator still never holds an inbox fact", async () => {
    // fct_11fe0002 sits in the inbox (saved above) and shares this task's words on purpose: a
    // moderator creator sees every hot fact, but their agent's pool still drops the inbox in code.
    const res = await api("/api/agents", {
      method: "POST",
      token: "tok-maya",
      json: { created_by: "maya", name: "Maya's filing assistant", rule: { task: "Summarize public market logistics notes", exclude: { groups: [], labels: [] } } },
    });
    assert.equal(res.status, 200);
    const agent = await body<Principal>(res);

    const scope = await body<Scope>(await api(`/api/scopes/${agent.id}`, { token: "tok-maya" }));
    assert.ok(scope.fact_ids.length > 0, "the moderator's agent draws from the hot facts");
    assert.ok(!scope.fact_ids.includes("fct_11fe0002"), "the matching inbox fact never joined");
    const { facts } = await body<{ facts: Fact[] }>(await api(`/api/scopes/${agent.id}/facts`, { token: "tok-maya" }));
    assert.ok(facts.every((f) => !folderAllows(["inbox"], f.folder)), "no inbox fact in the sandbox");
    assert.ok(askLog.flat().every((q) => !q.text.includes("fct_11fe0002")), "the inbox fact never even reached a judge in any build");
  });
});

describe("world fixtures (the contract in distiller/fixtures/world)", () => {
  test("a deal group's code name is always one of its aliases", () => {
    // Triage files by alias match, so a code name that only lived in the id would never route:
    // deal/falcon must list "Falcon" and "Project Falcon" (shared/src/types/scopes.ts, Group).
    for (const g of loadWorldFixtures().groups) {
      if (!g.id.startsWith("deal/")) continue;
      const code = g.id.slice("deal/".length);
      const name = code.charAt(0).toUpperCase() + code.slice(1);
      assert.ok(g.aliases?.includes(name), `${g.id} must list its code name "${name}" as an alias`);
      assert.ok(g.aliases?.includes(`Project ${name}`), `${g.id} must list "Project ${name}" as an alias`);
    }
  });
});
