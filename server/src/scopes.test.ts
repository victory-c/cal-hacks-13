// Scopes REST surface (A2) over real HTTP on port 0, seeded with the synthetic world: tier
// enforcement (one neutral 403 body on moderator routes, sent whether the target exists or not),
// internal-client gates, code-level exclusion filtering, the agent-scope-subset property and the
// contract shapes from shared/src/types/api.ts.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { DEMO_GRANTS, FakeJudge, folderAllows } from "@canon/shared";
import type {
  AuditEvent,
  CanonEvent,
  Fact,
  Group,
  HandoffResult,
  Principal,
  QuarantineItem,
  Scope,
  ScopeRule,
} from "@canon/shared";

import { startServer } from "./app.ts";
import type { RunningServer } from "./app.ts";
import { KeywordRetriever } from "./retrieval/keyword.ts";
import { seedDataDir } from "./seed.ts";

const tokens = new Map([
  ["tok-maya", "maya"],
  ["tok-dan", "dan"],
  ["tok-priya", "priya"],
  ["tok-leo", "leo"],
  ["tok-dist", "distiller"],
  ["tok-disp", "dispatcher"],
]);

const MODERATORS_ONLY = { error: "moderators only" };

describe("scopes REST surface (A2)", () => {
  let dir: string;
  let running: RunningServer;
  let events: CanonEvent[];
  const originalInfo = console.info;

  const api = (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.json !== undefined) headers["content-type"] = "application/json";
    return fetch(`${running.url}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  };
  const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;

  before(async () => {
    console.info = () => {};
    dir = await mkdtemp(join(tmpdir(), "canon-scopes-"));
    await seedDataDir(dir); // the world facts (fct_fa1c…, fct_ab11…, …) referenced by scopes.json
    running = await startServer({ port: 0, dataDir: dir, tokens, grants: [...DEMO_GRANTS], judge: new FakeJudge(), retriever: new KeywordRetriever(), log: () => {} });
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

  test("GET /api/groups: moderators and internal clients read it; a member gets the neutral 403", async () => {
    const maya = await api("/api/groups", { token: "tok-maya" });
    assert.equal(maya.status, 200);
    const { groups } = await body<{ groups: Group[] }>(maya);
    assert.deepEqual(groups.map((g) => g.id).sort(), ["deal/falcon", "desk/trading", "firm/ops", "market/public", "research/logistics"]);

    assert.equal((await api("/api/groups", { token: "tok-dist" })).status, 200, "triage reads the groups");

    const dan = await api("/api/groups", { token: "tok-dan" });
    assert.equal(dan.status, 403);
    assert.deepEqual(await dan.json(), MODERATORS_ONLY);
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

  test("POST /api/principals: a new member gets a scope with the exclusions applied in code", async () => {
    const res = await api("/api/principals", {
      method: "POST",
      token: "tok-maya",
      json: { id: "noor", name: "Noor", tier: "member", rule: { task: "Cover the freight market from public information", exclude: { groups: ["deal"], labels: [] } } },
    });
    assert.equal(res.status, 200);
    const noor = await body<Principal>(res);
    assert.deepEqual(noor, { id: "noor", kind: "person", name: "Noor", tier: "member" });

    const { facts } = await body<{ facts: Fact[] }>(await api("/api/scopes/noor/facts", { token: "tok-maya" }));
    assert.ok(facts.length > 0, "the stub scope holds the non-excluded hot facts");
    assert.ok(facts.every((f) => !folderAllows(["deal", "inbox"], f.folder)), "deal/* removed in code; inbox never joins");

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
    assert.equal(member.status, 403, "handoff is for internal clients, never members directly");
    assert.equal((await api("/api/handoff", { method: "POST", token: "tok-dist", json: { principal: "ghost", task: "x" } })).status, 404, "internal callers may see a 404");
    assert.equal((await api("/api/handoff", { method: "POST", token: "tok-dist", json: { principal: "agt_leodesk", task: "" } })).status, 400);
  });

  test("PUT /api/scope-rules/:principal rebuilds the scope by removal only (stub never adds)", async () => {
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
      assert.ok(!afterScope.fact_ids.includes(gone), `${gone} carries the excluded label`);
    }
    for (const kept of ["fct_ab110003", "fct_10610001", "fct_0f0e0001", "fct_0f0e0002"]) {
      assert.ok(afterScope.fact_ids.includes(kept), `${kept} stays`);
    }
    assert.ok(afterScope.fact_ids.every((id) => beforeScope.fact_ids.includes(id)), "a rebuild only removes");

    const update = events.find((e) => e.type === "scope.updated" && e.principal === "priya" && e.reason === "rule_changed");
    assert.ok(update && update.type === "scope.updated");
    assert.deepEqual(update.added, []);
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
    const res = await api("/api/dispatch", { method: "POST", token: "tok-leo", json: { agent: "agt_leodesk", by: "leo" } });
    assert.equal(res.status, 200);
    const { id } = await body<{ id: string }>(res);
    assert.match(id, /^dsp_[0-9a-f]+$/);
    const requested = events.find((e) => e.type === "dispatch.requested" && e.id === id);
    assert.ok(requested && requested.type === "dispatch.requested");
    assert.deepEqual(requested.request, { agent: "agt_leodesk", by: "leo" });

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
});
