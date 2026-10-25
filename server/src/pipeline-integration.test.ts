import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CapturedSession, Fact, Grant, Judge, ScopeRule } from "@canon/shared";
import { startServer } from "./app.ts";
import type { RunningServer } from "./app.ts";
import { EventBus } from "./events.ts";
import { runContext, runSave, runSearch, runWhoami } from "./mcp.ts";
import { KeywordRetriever } from "./retrieval/keyword.ts";
import type { WorldFixtures } from "./scopes.ts";
import { FileStore, sessionFingerprint } from "./store.ts";

const rule = (principal: string): ScopeRule => ({ principal, task: "Public market holdings", exclude: { groups: ["deal"], labels: [] }, set_by: "mod", updated_at: "2026-10-24T00:00:00Z" });
const world = (): WorldFixtures => ({ groups: [{ id: "market/public", description: "Public market data" }, { id: "deal/secret", description: "Pending deal" }], principals: [{ id: "mod", kind: "person", name: "Moderator", tier: "moderator" }, { id: "alice", kind: "person", name: "Alice", tier: "member" }, { id: "bob", kind: "person", name: "Bob", tier: "member" }], rules: [rule("alice"), rule("bob")], scopes: [{ principal: "alice", fact_ids: ["fct_aa0011"], built_at: "2026-10-24T00:00:00Z", rule_updated_at: rule("alice").updated_at }, { principal: "bob", fact_ids: [], built_at: "2026-10-24T00:00:00Z", rule_updated_at: rule("bob").updated_at }], quarantine: [], audit: [] });
const grants: Grant[] = [{ client: "mod", principal: "mod", read: [], write: [] }, { client: "alice", principal: "alice", read: [], write: [] }, { client: "bob", principal: "bob", read: [], write: [] }, { client: "distiller", read: [], write: [] }, { client: "ingest", read: [], write: [] }, { client: "claude-code", read: [], write: [] }];
const tokens = new Map(grants.map((grant) => [`tok-${grant.client}`, grant.client]));
const fact = (id: string, folder = "market/public", author = "alice"): Fact => ({ id, folder, author, statement: folder.startsWith("deal") ? "SECRET BID AT 77" : "Public market holdings are 200000 shares", tier: "hot", jev_keep: 0.9, source: { client: "ingest", session: "ses_aa0011" }, updated: "2026-10-24" });
const judge: Judge = { name: "fake", ask: async (_state, questions) => questions.map((q) => { assert.equal(q.type, "noul"); return { id: q.id, type: "noul" as const, p: q.id.startsWith("x") ? 0 : 1 }; }) };
const request = (server: RunningServer, path: string, client: string, body?: unknown, method = body === undefined ? "GET" : "POST") => fetch(`${server.url}${path}`, { method, headers: { authorization: `Bearer tok-${client}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function setup(customJudge: Judge = judge) {
  const dir = await mkdtemp(join(tmpdir(), "bullwark-integration-")); const store = new FileStore(dir);
  await store.putFact(fact("fct_aa0011")); await store.putFact(fact("fct_bb0011", "deal/secret", "mod"));
  const server = await startServer({ dataDir: dir, world: world(), tokens, grants, judge: customJudge, retriever: new KeywordRetriever(), log: () => {} });
  return { dir, server };
}

test("principal MCP and HTTP share a scope; moderator memory includes every hot fact", async () => {
  const { dir, server } = await setup();
  try {
    const deps = { store: server.store, bus: server.bus, retriever: server.retriever, judge: server.judge, world: server.world, grants, grant: grants[1], client: "alice" };
    assert.deepEqual(runWhoami(deps), { client: "alice", principal: "alice", name: "Alice", tier: "member", task: "Public market holdings" });
    const context = await runContext(deps, { task: "market holdings" });
    assert.equal(context.facts.length, 1); assert.ok(context.profile); assert.equal("candidates" in context, false); assert.equal("missing" in context, false);
    const forbidden = await runSearch(deps, { query: "SECRET BID", folders: ["deal/secret"] }); assert.deepEqual(forbidden, { facts: [] });
    assert.equal((await request(server, "/api/grants", "alice")).status, 403);
    const health = await (await request(server, "/health", "alice")).json() as { facts: number; sessions?: number };
    assert.equal(health.facts, 1); assert.equal("sessions" in health, false);
    const who = await (await request(server, "/api/me", "alice")).json() as { id: string }; assert.equal(who.id, "alice"); assert.equal(JSON.stringify(who).includes("exclude"), false);
    const facts = await (await request(server, "/api/facts", "alice")).json() as { facts: Array<{ group: string; status: string }> }; assert.equal(facts.facts[0].group, "market/public"); assert.equal(facts.facts[0].status, "hot"); assert.equal(JSON.stringify(facts).includes("SECRET"), false);
    const all = await runContext({ ...deps, client: "mod", grant: grants[0] }, { task: "SECRET BID" }); assert.ok(all.facts.some((f) => f.id === "fct_bb0011"));
    const saved = await runSave(deps, { text: "Public holdings now 210000 shares" }); const session = await server.store.getSession(saved.session_id); assert.equal(session?.principal, "alice"); assert.equal(session.kind, "note"); assert.equal(session.external, false);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("capture ownership is principal bound despite different source clients; operators cannot impersonate", async () => {
  const { dir, server } = await setup();
  try {
    const body = { id: "ses_cc0011", client: "claude-code", started_at: "2026-10-24T00:00:00Z", ended_at: "2026-10-24T00:00:01Z", external: false, messages: [{ role: "user", content: "Market holdings" }] };
    assert.equal((await request(server, "/api/sessions", "alice", body)).status, 200);
    assert.equal((await server.store.getSession(body.id))?.principal, "alice");
    assert.equal((await request(server, "/api/sessions", "bob", body)).status, 403);
    assert.equal((await request(server, "/api/sessions", "claude-code", { ...body, id: "ses_cc0012", principal: "alice" })).status, 403);
    assert.equal((await request(server, "/api/sessions", "ingest", { ...body, id: "ses_cc0013", principal: "nobody" })).status, 404);
    const pending = await (await request(server, "/api/sessions?pending=1", "distiller")).json() as { sessions: CapturedSession[] }; assert.equal(pending.sessions.length, 1);
    const fingerprint = sessionFingerprint(pending.sessions[0]); assert.equal((await request(server, `/api/sessions/${body.id}/distilled`, "distiller", { fingerprint })).status, 200);
    assert.deepEqual(await (await request(server, "/api/sessions?pending=1", "distiller")).json(), { sessions: [] });
    assert.equal((await request(server, "/api/sessions?pending=1", "alice")).status, 403);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("world changes and immutable audit survive restart; failed rule builds preserve previous state", async () => {
  let fail = false; const throwing: Judge = { name: "fake", ask: async (state, qs) => { if (fail) throw new Error("synthetic outage"); return judge.ask(state, qs); } };
  const { dir, server } = await setup(throwing); let current = server;
  try {
    const added = await request(server, "/api/principals", "mod", { id: "carol", name: "Carol", tier: "member", rule: { task: "Public holdings", exclude: { groups: ["deal"], labels: [] } } }); assert.equal(added.status, 200);
    const build = server.world.audit.find((entry) => entry.kind === "scope.built" && entry.principal === "carol")!; const buildIds = [...build.fact_ids!];
    const next = fact("fct_aa0022"); await server.store.putFact(next); server.bus.emit({ type: "fact.saved", fact: next, decision: { action: "add", folder: next.folder, tier: next.tier, keep_p: 0.9, folder_p: 1, judge: "fake" } });
    for (let i = 0; i < 100 && !server.world.scopes.get("carol")?.fact_ids.includes(next.id); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const before = structuredClone(server.world.rules.get("alice")); const scope = structuredClone(server.world.scopes.get("alice")); fail = true;
    const failed = await request(server, "/api/scope-rules/alice", "mod", { task: "different", exclude: { groups: [], labels: [] } }, "PUT"); assert.equal(failed.status, 500); assert.deepEqual(server.world.rules.get("alice"), before); assert.deepEqual(server.world.scopes.get("alice"), scope); fail = false;
    await server.close(); assert.deepEqual(build.fact_ids, buildIds);
    current = await startServer({ dataDir: dir, world: world(), tokens, grants, judge, retriever: new KeywordRetriever(), log: () => {} });
    assert.ok(current.world.principals.has("carol")); assert.ok(current.world.scopes.get("carol")?.fact_ids.includes(next.id)); assert.deepEqual(current.world.audit.find((entry) => entry.id === build.id)?.fact_ids, buildIds);
    const auditIds = current.world.audit.map((entry) => entry.id); assert.equal(new Set(auditIds).size, auditIds.length);
  } finally { await current.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});

test("nested SSE emissions have ascending unique ids and snapshots cannot alias mutable state", () => {
  const bus = new EventBus(); const seen: number[] = [];
  bus.subscribe((event) => { if (event.type === "fact.retired") bus.emit({ type: "scope.updated", principal: "alice", reason: "fact_left", added: [], removed: [event.id], size: 0 }); });
  bus.subscribe((event) => seen.push(event.event_id!));
  bus.emit({ type: "fact.retired", id: "fct_aa0011", superseded_by: "fct_aa0011" });
  assert.deepEqual(seen, [1, 2]);
  const ids = ["fct_aa0011"]; bus.emit({ type: "scope.updated", principal: "alice", reason: "built", added: ids, removed: [], size: 1 }); ids.push("fct_bb0011");
  const last = bus.replay().at(-1); assert.ok(last?.type === "scope.updated"); assert.deepEqual(last.added, ["fct_aa0011"]);
});

test("member mutations are scoped and indistinguishable outside memory; moderator items bind selected author", async () => {
  const { dir, server } = await setup();
  try {
    const hidden = await request(server, "/api/facts/fct_bb0011", "alice", { statement: "probe" }, "PATCH");
    const missing = await request(server, "/api/facts/fct_ffffff", "alice", { statement: "probe" }, "PATCH");
    assert.equal(hidden.status, 404); assert.equal(missing.status, 404); assert.equal(await hidden.text(), await missing.text());
    const own = await request(server, "/api/facts/fct_aa0011", "alice", { statement: "Public market holdings are 210000 shares" }, "PATCH"); assert.equal(own.status, 200); assert.equal((await own.json() as { group: string }).group, "market/public");
    assert.equal((await request(server, "/api/items", "alice", { kind: "memo", source: "Synthetic memo", text: "Public holdings", author: "mod" })).status, 403);
    const captured = await request(server, "/api/items", "mod", { kind: "memo", source: "Synthetic memo", text: "Public holdings", author: "alice" }); assert.equal(captured.status, 200);
    const item = await captured.json() as { item_id: string }; const session = await server.store.getSession(item.item_id); assert.equal(session?.principal, "alice"); assert.equal(session?.client, "ingest");
    assert.equal((await request(server, "/api/facts/fct_aa0011/retire", "alice", {})).status, 200); assert.equal(server.world.scopes.get("alice")?.fact_ids.includes("fct_aa0011"), false);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("unavailable neutral answers cannot grant scope membership or serve unjudged handoffs", async () => {
  const unavailable: Judge = { name: "fake", ask: async (_state, questions) => questions.map((q) => ({ id: q.id, type: "noul" as const, p: 0.5, unavailable: true })) };
  const { dir, server } = await setup(unavailable);
  try {
    const result = await request(server, "/api/principals", "mod", { id: "carol", name: "Carol", tier: "member", rule: { task: "Public holdings", exclude: { groups: [], labels: [] } } }); assert.equal(result.status, 200); assert.deepEqual(server.world.scopes.get("carol")?.fact_ids, []);
    const result2 = await request(server, "/api/handoff", "alice", { task: "market holdings" }); const handoff = await result2.json() as { facts: unknown[]; inject_nothing: boolean }; assert.deepEqual(handoff.facts, []); assert.equal(handoff.inject_nothing, true);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("narrowing removes stale agent traces immediately and discards late events from the old scope", async () => {
  const { dir, server } = await setup();
  try {
    const created = await request(server, "/api/agents", "alice", { name: "Public assistant", task: "market holdings", exclusions: { groups: ["deal"], labels: [], text: [] } });
    const agent = await created.json() as { id: string }; assert.equal(created.status, 200);
    const run = { id: "run_aa0011", agent: agent.id, created_by: "alice", task: "market holdings", state: "running", runtime: "fake", sandbox: "synthetic", steps: 1, restarts: 0, started_at: "2026-10-24T00:00:00Z" };
    const publish = (event: unknown) => request(server, "/api/events", "distiller", { event });
    await publish({ type: "agent.run", run }); await publish({ type: "agent.step", step: { run_id: run.id, n: 1, kind: "result", text: "Previously visible holdings", at: "2026-10-24T00:00:00Z" } });
    const before = await (await request(server, "/api/agents", "alice")).json() as { agents: Array<{ steps: unknown[] }> }; assert.equal(before.agents[0].steps.length, 1);
    server.bus.emit({ type: "scope.updated", principal: agent.id, reason: "fact_left", added: [], removed: ["fct_aa0011"], size: 0 });
    const after = await (await request(server, "/api/agents", "alice")).json() as { agents: Array<{ steps: unknown[]; status: string; files: unknown[]; outputs: unknown[] }> }; assert.deepEqual(after.agents[0].steps, []); assert.deepEqual(after.agents[0].files, []); assert.deepEqual(after.agents[0].outputs, []); assert.equal(after.agents[0].status, "restarting");
    const late = await (await publish({ type: "agent.step", step: { run_id: run.id, n: 2, kind: "result", text: "Late revoked context", at: "2026-10-24T00:00:00Z" } })).json() as { ignored: boolean }; assert.equal(late.ignored, true);
    await publish({ type: "agent.run", run: { ...run, restarts: 1 } }); await publish({ type: "agent.step", step: { run_id: run.id, n: 1, kind: "plan", text: "Fresh scoped plan", at: "2026-10-24T00:00:00Z" } });
    assert.equal(server.world.agentSteps.get(run.id)?.length, 1);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("closing during a living-scope judge waits for the durable join", async () => {
  let slow = false;
  const delayed: Judge = { name: "fake", ask: async (state, qs) => { if (slow) await new Promise((resolve) => setTimeout(resolve, 30)); return judge.ask(state, qs); } };
  const { dir, server } = await setup(delayed);
  try {
    slow = true; const next = fact("fct_aa0033", "market/public", "mod"); await server.store.putFact(next);
    server.bus.emit({ type: "fact.saved", fact: next, decision: { action: "add", folder: next.folder, tier: next.tier, keep_p: 0.9, folder_p: 1, judge: "fake" } });
    await server.close();
    const restored = await startServer({ dataDir: dir, world: world(), tokens, grants, judge, retriever: new KeywordRetriever(), log: () => {} });
    try { assert.ok(restored.world.scopes.get("alice")?.fact_ids.includes(next.id)); assert.ok(restored.world.audit.some((entry) => entry.kind === "fact.joined_scope" && entry.fact_ids?.includes(next.id))); } finally { await restored.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("new groups stay closed until Compliance changes a rule and never leak through member agent rules", async () => {
  const { dir, server } = await setup();
  try {
    const created = await (await request(server, "/api/agents", "alice", { name: "Public assistant", task: "market holdings", exclusions: { groups: [], labels: [], text: [] } })).json() as { id: string };
    assert.equal((await request(server, "/api/groups", "mod", { id: "restricted-new", name: "New private bucket", description: "Confidential notes" })).status, 200);
    assert.ok(server.world.rules.get("alice")?.exclude.groups.includes("restricted-new"));
    const agentRule = await (await request(server, `/api/scope-rules/${created.id}`, "alice")).text(); assert.equal(agentRule.includes("restricted-new"), false);
    const next = fact("fct_aa0044", "restricted-new", "alice"); await server.store.putFact(next); server.bus.emit({ type: "fact.saved", fact: next, decision: { action: "add", folder: next.folder, tier: next.tier, keep_p: 0.9, folder_p: 1, judge: "fake" } });
    await server.close(); assert.equal(server.world.scopes.get("alice")?.fact_ids.includes(next.id), false); assert.equal(server.world.scopes.get(created.id)?.fact_ids.includes(next.id), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("public fact provenance never exposes the private headline of its mixed source", async () => {
  const { dir, server } = await setup();
  try {
    await server.store.putSession({ id: "ses_aa0011", client: "ingest", principal: "alice", title: "SECRET STONEWALL acquisition bid memo", kind: "memo", started_at: "2026-10-24T00:00:00Z", messages: [{ role: "user", content: "Private bid details and a public market holding." }] });
    server.world.scopes.get("bob")!.fact_ids.push("fct_aa0011");
    const bob = await (await request(server, "/api/facts", "bob")).json() as { facts: Array<{ source: string; source_title?: string }> };
    assert.equal(JSON.stringify(bob).includes("STONEWALL"), false); assert.equal(bob.facts[0].source, "memo · ingest"); assert.equal("source_title" in bob.facts[0], false);
    const author = await (await request(server, "/api/facts", "alice")).json() as { facts: Array<{ source_title?: string }> }; assert.equal(author.facts[0].source_title, "SECRET STONEWALL acquisition bid memo");
    const moderator = await (await request(server, "/api/facts", "mod")).json() as { facts: Array<{ source_title?: string }> }; assert.ok(moderator.facts.some((fact) => fact.source_title === "SECRET STONEWALL acquisition bid memo"));
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("internal sandbox reads enforce a creator narrowing while a child scope is still stale", async () => {
  const { dir, server } = await setup();
  try {
    const agent = await (await request(server, "/api/agents", "alice", { name: "Public assistant", task: "market holdings", exclusions: { groups: [], labels: [], text: [] } })).json() as { id: string };
    assert.ok(server.world.scopes.get(agent.id)?.fact_ids.includes("fct_aa0011"));
    server.world.scopes.get("alice")!.fact_ids = []; // a parent's successful rebuild precedes the child's judge call
    const sandbox = await (await request(server, `/api/scopes/${agent.id}/facts`, "distiller")).json() as { facts: unknown[] }; assert.deepEqual(sandbox.facts, []);
    const scope = await (await request(server, `/api/scopes/${agent.id}`, "distiller")).json() as { fact_ids: string[] }; assert.deepEqual(scope.fact_ids, []);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("completed agent runs, result steps and inbox survive server restart", async () => {
  const { dir, server } = await setup(); let current = server;
  try {
    const agent = await (await request(server, "/api/agents", "alice", { name: "Public assistant", task: "market holdings", exclusions: { groups: [], labels: [], text: [] } })).json() as { id: string };
    const run = { id: "run_aa0055", agent: agent.id, created_by: "alice", task: "market holdings", state: "done", runtime: "fake", sandbox: "synthetic", steps: 1, restarts: 0, started_at: "2026-10-24T00:00:00Z", ended_at: "2026-10-24T00:00:01Z" };
    const publish = (event: unknown) => request(current, "/api/events", "distiller", { event });
    assert.equal((await publish({ type: "agent.run", run })).status, 200);
    assert.equal((await publish({ type: "agent.step", step: { run_id: run.id, n: 1, kind: "result", text: "The synthetic portfolio holds 200000 shares.", at: run.ended_at } })).status, 200);
    assert.equal((await publish({ type: "agent.inbox", item: { id: "inb_aa0055", run_id: run.id, kind: "new_fact", urgent: false, text: "Synthetic holdings updated", at: run.ended_at } })).status, 200);
    const before = await (await request(current, "/api/agents", "alice")).json();
    await current.close();
    current = await startServer({ dataDir: dir, world: world(), tokens, grants, judge, retriever: new KeywordRetriever(), log: () => {} });
    const after = await (await request(current, "/api/agents", "alice")).json(); assert.deepEqual(after, before);
    const restored = after as { agents: Array<{ status: string; steps: unknown[]; inbox: unknown[]; outputs: unknown[] }> }; assert.equal(restored.agents[0].status, "done"); assert.equal(restored.agents[0].steps.length, 1); assert.equal(restored.agents[0].inbox.length, 1); assert.equal(restored.agents[0].outputs.length, 1);
    // A later revocation must also stay revoked across a subsequent restart.
    current.bus.emit({ type: "scope.updated", principal: agent.id, reason: "fact_left", added: [], removed: ["fct_aa0011"], size: 0 });
    await current.close();
    current = await startServer({ dataDir: dir, world: world(), tokens, grants, judge, retriever: new KeywordRetriever(), log: () => {} });
    const narrowed = await (await request(current, "/api/agents", "alice")).json() as { agents: Array<{ status: string; steps: unknown[]; inbox: unknown[]; outputs: unknown[] }> }; assert.equal(narrowed.agents[0].status, "restarting"); assert.deepEqual(narrowed.agents[0].steps, []); assert.deepEqual(narrowed.agents[0].outputs, []); assert.deepEqual(narrowed.agents[0].inbox, []);
    const late = await (await publish({ type: "agent.run", run })).json() as { ignored: boolean }; assert.equal(late.ignored, true);
  } finally { await current.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});
