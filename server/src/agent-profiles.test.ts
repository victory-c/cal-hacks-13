// Agent profiles over real HTTP: a creator picks their agent's memory from the groups they can
// see, edits it without touching any wall Compliance put up, sees what the agent wrote and noted
// for them, and the server refuses any agent save that carries a fact the agent no longer holds.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AGENT_SCOPE_CHANGED } from "@canon/shared";
import type { Fact, Grant, Judge, ScopeRule } from "@canon/shared";

import { startServer } from "./app.ts";
import type { RunningServer } from "./app.ts";
import { documentTitle } from "./member.ts";
import { KeywordRetriever } from "./retrieval/keyword.ts";
import type { WorldFixtures } from "./scopes.ts";
import { FileStore } from "./store.ts";

const memberRule = (principal: string): ScopeRule => ({ principal, task: "Public market holdings and research notes", exclude: { groups: ["deal"], labels: [] }, set_by: "mod", updated_at: "2026-10-24T00:00:00Z" });
const world = (): WorldFixtures => ({
  groups: [
    { id: "market/public", display: "Public market", description: "Public market data" },
    { id: "research/notes", display: "Research notes", description: "The research team's notes" },
    { id: "deal/secret", display: "Project Secret", description: "Pending deal" },
  ],
  principals: [
    { id: "mod", kind: "person", name: "Moderator", tier: "moderator" },
    { id: "alice", kind: "person", name: "Alice", tier: "member" },
    { id: "bob", kind: "person", name: "Bob", tier: "member" },
  ],
  rules: [memberRule("alice"), memberRule("bob")],
  scopes: [], quarantine: [], audit: [],
  // Built by the real pipeline at start-up (exclusions in code, then the judge), people only.
  initial_scopes: ["alice", "bob"],
});
const grants: Grant[] = ["mod", "alice", "bob"].map((id) => ({ client: id, principal: id, read: [], write: [] } as Grant))
  .concat([{ client: "dispatcher", read: [], write: [] }, { client: "distiller", read: [], write: [] }]);
const tokens = new Map(grants.map((grant) => [`tok-${grant.client}`, grant.client]));
const fact = (id: string, folder: string, statement: string): Fact => ({ id, folder, author: "alice", statement, tier: "hot", jev_keep: 0.9, source: { client: "ingest", session: "ses_aa0011" }, updated: "2026-10-24" });
// Exclusion questions ("x…") answer no, relevance questions yes: what code decides is what's tested.
const judge: Judge = { name: "fake", ask: async (_state, questions) => questions.map((q) => ({ id: q.id, type: "noul" as const, p: q.id.startsWith("x") ? 0 : 1 })) };
const call = (server: RunningServer, path: string, client: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  fetch(`${server.url}${path}`, { method, headers: { authorization: `Bearer tok-${client}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

interface AgentView {
  id: string; name: string; task: string; status: string; fact_count: number; refresh: boolean; leave_out: string;
  memory_groups: Array<{ id: string; name: string; included: boolean; count: number }>;
  documents: Array<{ file: string; title: string; text: string }>;
  memories: Array<{ file: string; text: string }>;
  steps: Array<{ text: string; kind: string; status: string }>;
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "bullwark-agent-profiles-"));
  const store = new FileStore(dir);
  await store.putFact(fact("fct_aa0011", "market/public", "TMC's assets under management were $38.4 billion"));
  await store.putFact(fact("fct_aa0022", "research/notes", "Listed managers trade at 9x to 12x forward earnings"));
  await store.putFact(fact("fct_bb0011", "deal/secret", "SECRET BID AT 77"));
  const server = await startServer({ dataDir: dir, world: world(), tokens, grants, judge, retriever: new KeywordRetriever(), log: () => {} });
  return { dir, server, done: async () => { await server.close(); await rm(dir, { recursive: true, force: true }); } };
}
const agentsOf = async (server: RunningServer, who: string) => ((await (await call(server, "/api/agents", who)).json()) as { agents: AgentView[] }).agents;
const create = async (server: RunningServer, excluded: string[]) =>
  (await (await call(server, "/api/agents", "alice", { name: "Sector note drafter", task: "Draft the asset manager sector note", exclusions: { groups: excluded, labels: [], text: [] } })).json()) as { id: string };

test("a creator picks their agent's memory from their own groups; nothing they cannot see is offered", async () => {
  const { server, done } = await setup();
  try {
    const { id } = await create(server, ["research/notes"]);
    const [agent] = await agentsOf(server, "alice");
    assert.equal(agent.id, id);
    assert.deepEqual(agent.memory_groups, [
      { id: "market/public", name: "Public market", included: true, count: 1 },
      { id: "research/notes", name: "Research notes", included: false, count: 0 },
    ], "only Alice's own groups, with her choice");
    assert.equal(agent.fact_count, 1);
    assert.equal(JSON.stringify(agent).includes("deal"), false, "the walled group is never named or counted");
    assert.deepEqual(await agentsOf(server, "bob"), [], "nobody else sees the agent");
  } finally { await done(); }
});

test("a creator edits their agent's groups; exclusions they cannot see stay exactly as they were", async () => {
  const { server, done } = await setup();
  try {
    const { id } = await create(server, ["research/notes", "deal/secret"]);
    const res = await call(server, `/api/principals/${id}/rule`, "alice", { task: "Draft the sector note from research", preserve_exclusions: true, exclude_groups: ["market/public"] }, "PUT");
    assert.equal(res.status, 200);
    const rule = (await (await call(server, `/api/scope-rules/${id}`, "mod")).json()) as ScopeRule;
    assert.deepEqual(rule.exclude.groups.sort(), ["deal/secret", "market/public"], "research/notes lifted, market/public added, the walled group kept");
    assert.equal(rule.task, "Draft the sector note from research");
    const [agent] = await agentsOf(server, "alice");
    assert.deepEqual(agent.memory_groups.map((g) => [g.id, g.included, g.count]), [["market/public", false, 0], ["research/notes", true, 1]]);

    assert.equal((await call(server, `/api/principals/${id}/rule`, "alice", { task: "x", preserve_exclusions: true, exclude_groups: ["Not A Group"] }, "PUT")).status, 400);
    assert.equal((await call(server, `/api/principals/${id}/rule`, "alice", { task: "x", preserve_exclusions: true, exclude: { groups: [], labels: [] } }, "PUT")).status, 400, "a creator never sends a whole exclusion list");
    assert.equal((await call(server, `/api/principals/${id}/rule`, "bob", { task: "x", preserve_exclusions: true, exclude_groups: [] }, "PUT")).status, 403);
  } finally { await done(); }
});

test("after Compliance sets an agent's rule, its creator can only narrow it, and never reads it back", async () => {
  const { server, done } = await setup();
  try {
    const { id } = await create(server, []);
    assert.equal((await call(server, `/api/scope-rules/${id}`, "mod", { task: "Draft the asset manager sector note", exclude: { groups: ["research/notes"], labels: [] } }, "PUT")).status, 200);
    // Alice tries to lift Compliance's exclusion while adding her own.
    assert.equal((await call(server, `/api/principals/${id}/rule`, "alice", { task: "Draft the asset manager sector note", preserve_exclusions: true, exclude_groups: ["market/public"] }, "PUT")).status, 200);
    const rule = (await (await call(server, `/api/scope-rules/${id}`, "mod")).json()) as ScopeRule;
    assert.deepEqual(rule.exclude.groups.sort(), ["market/public", "research/notes"], "Compliance's exclusion stays up");
    assert.equal(rule.set_by, "mod");
    const [agent] = await agentsOf(server, "alice");
    assert.equal(agent.fact_count, 0);
    assert.ok(agent.memory_groups.every((g) => !g.included), "shown by what the agent holds, never by reading the rule back");
  } finally { await done(); }
});

test("the server refuses an agent save that carries a fact the agent no longer holds, or names anyone else", async () => {
  const { server, done } = await setup();
  try {
    const { id } = await create(server, []);
    const note = (sid: string, meta: Record<string, unknown>, principal = "alice") => ({
      id: sid, client: "dispatcher", kind: "note", external: false, principal, started_at: "2026-10-25T00:00:00Z", ended_at: "2026-10-25T00:00:00Z",
      messages: [{ role: "user", content: "Sector note drafter saved: the brief lacks position size." }], meta: { agent: id, stop_generation: 0, ...meta },
    });
    assert.equal((await call(server, "/api/sessions", "dispatcher", note("ses_ab0001", { fact_ids: ["fct_aa0011", "fct_aa0022"] }))).status, 200);
    const gone = await call(server, "/api/sessions", "dispatcher", note("ses_ab0002", { fact_ids: ["fct_aa0011", "fct_bb0011"] }));
    assert.equal(gone.status, 409);
    assert.deepEqual(await gone.json(), { error: AGENT_SCOPE_CHANGED });
    assert.equal(await server.store.getSession("ses_ab0002"), undefined, "nothing from that folder is stored");
    assert.equal((await call(server, "/api/sessions", "dispatcher", note("ses_ab0003", { fact_ids: "fct_aa0011" }))).status, 409, "malformed ids refuse too");
    assert.equal((await call(server, "/api/sessions", "dispatcher", note("ses_ab0004", { fact_ids: [] }, "bob"))).status, 403, "an agent's outputs are only its creator's");
  } finally { await done(); }
});

test("the member view shows what the agent wrote and noted, and withholds it once a fact it read is gone", async () => {
  const { server, done } = await setup();
  try {
    const { id } = await create(server, []);
    const run = { id: "run_ab0001", agent: id, created_by: "alice", task: "Draft the asset manager sector note", state: "running", runtime: "claude", sandbox: "data/agents/run_ab0001", steps: 2, restarts: 0, started_at: "2026-10-25T00:00:00Z" };
    const publish = (event: unknown) => call(server, "/api/events", "dispatcher", { event });
    const step = (n: number, extra: Record<string, unknown>) => publish({ type: "agent.step", step: { run_id: run.id, n, at: "2026-10-25T00:00:05Z", ...extra } });
    assert.equal((await publish({ type: "agent.run", run })).status, 200);
    await step(1, { kind: "tool", text: "read_file facts/fct_aa0011.md" });
    let [agent] = await agentsOf(server, "alice");
    assert.equal(agent.status, "running");
    assert.equal(agent.steps.at(-1)?.status, "running", "the step in flight is marked live");
    assert.equal(agent.steps.at(-1)?.kind, "tool");

    await step(2, { kind: "file", text: "saved out/memories/progress.md to alice's memory", file: "out/memories/progress.md", content: "Brief drafted; position size still open.", fact_ids: ["fct_aa0011"] });
    await step(2, { kind: "file", text: "saved out/sector-note.md to alice's memory", file: "out/sector-note.md", content: "# Asset managers, Q3\n\nAUM fell 3%.", fact_ids: ["fct_aa0011", "fct_aa0022"] });
    await publish({ type: "agent.run", run: { ...run, state: "done", ended_at: "2026-10-25T00:00:30Z" } });
    [agent] = await agentsOf(server, "alice");
    assert.equal(agent.status, "done");
    assert.deepEqual(agent.documents.map((d) => [d.file, d.title]), [["out/sector-note.md", "Asset managers, Q3"]]);
    assert.deepEqual(agent.memories.map((m) => m.text), ["Brief drafted; position size still open."]);
    assert.equal(agent.refresh, false);
    assert.ok(agent.steps.every((s) => s.status === "done"));

    // A document that drew on a fact outside the agent's scope now (a later rule edit) is withheld.
    await step(3, { kind: "file", text: "saved out/old.md to alice's memory", file: "out/old.md", content: "SECRET BID AT 77", fact_ids: ["fct_bb0011"] });
    [agent] = await agentsOf(server, "alice");
    assert.equal(JSON.stringify(agent).includes("SECRET"), false);
    assert.equal(agent.refresh, true, "the view asks for a new run and names nothing");
  } finally { await done(); }
});

test("documentTitle: the first heading, else a readable file name", () => {
  assert.equal(documentTitle("intro\n## TMC: our position\nbody", "out/x.md"), "TMC: our position");
  assert.equal(documentTitle("no heading here", "out/tmc_brief-v2.md"), "tmc brief v2");
});
