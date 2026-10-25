// The member client against a fake Canon: the routes and bodies it sends, how it reads errors,
// and how live events become what the page shows (always from current REST snapshots).

import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeCanon } from "../fake-canon.ts";
import type { Recorded } from "../fake-canon.ts";
import { CanonClient, HttpError } from "./canon.ts";
import type { MemberEvent } from "./contract.ts";

const SERVER = "https://preview.example";
const fact = (id: string, statement: string) => ({ id, statement, group: "market/public", labels: [], source: "itm", author: "ben", happened_at: "", learned_at: "", status: "hot" });
const run = (over: Record<string, unknown> = {}) => ({ id: "research-analyst", creator: "ben", name: "Research analyst", status: "ready", steps: [], files: [], inbox: [], task: "Update the note", ...over });

test("a token rides in the Authorization header; reads unwrap their envelopes", async (t) => {
  const canon = fakeCanon(t, {
    "GET /api/me": { id: "ben", kind: "person", name: "Ben Kim", firm: "Axe Capital" },
    "GET /api/facts": { facts: [fact("fct_1", "TMC paused its buyback")] },
    "GET /api/agents": { agents: [run()] },
  });
  const client = new CanonClient(SERVER, "tok_ben");
  assert.equal((await client.me()).name, "Ben Kim");
  assert.deepEqual((await client.facts()).map((f) => f.id), ["fct_1"]);
  assert.deepEqual((await client.agents()).map((a) => a.id), ["research-analyst"]);
  for (const c of canon.calls) {
    assert.equal(c.headers.authorization, "Bearer tok_ben");
    assert.equal(c.credentials, "same-origin");
  }
});

test("commands hit the contract routes with the contract bodies, ids encoded", async (t) => {
  const canon = fakeCanon(t, {
    "PATCH /api/facts/fct%2Fodd": (r: Recorded) => ({ ...fact("fct/odd", (r.body as { statement: string }).statement) }),
    "POST /api/facts/fct_1/retire": new Response(null, { status: 204 }),
    "POST /api/items": { item_id: "ses_1" },
    "POST /api/agents": { id: "agt_1", build_id: "bld_1" },
    "DELETE /api/agents/agt_1": new Response(null, { status: 204 }),
    "POST /api/agents/agt_1/stop": {},
  });
  const client = new CanonClient(SERVER, "tok");
  assert.equal((await client.editFact("fct/odd", "Edited")).statement, "Edited");
  assert.equal(await client.retireFact("fct_1"), undefined);
  assert.deepEqual(await client.addItem({ kind: "note", source: "My notes", text: "Fees fell again" }), { item_id: "ses_1" });
  const body = { name: "Fee tracker", task: "Track fees", exclusions: { groups: [], labels: [], text: ["firm ops"] }, docs: ["summary" as const], schedule: "Only when I press Run" as const };
  assert.deepEqual(await client.createAgent(body), { id: "agt_1", build_id: "bld_1" });
  await client.deleteAgent("agt_1");
  await client.stopAgent("agt_1");
  assert.deepEqual(canon.calls.map((c) => `${c.method} ${c.path}`), [
    "PATCH /api/facts/fct%2Fodd", "POST /api/facts/fct_1/retire", "POST /api/items", "POST /api/agents", "DELETE /api/agents/agt_1", "POST /api/agents/agt_1/stop",
  ]);
  assert.deepEqual(canon.calls[0]!.body, { statement: "Edited" });
  assert.deepEqual(canon.calls[2]!.body, { kind: "note", source: "My notes", text: "Fees fell again" });
  assert.deepEqual(canon.calls[3]!.body, body);
  assert.equal(canon.calls[3]!.headers["content-type"], "application/json");
  assert.equal(canon.calls[1]!.headers["content-type"], undefined, "no body, no content type");
});

test("errors carry the status and the server's message; a body without one names the call", async (t) => {
  fakeCanon(t, {
    "GET /api/me": Response.json({ error: "unknown token" }, { status: 401 }),
    "GET /api/facts": new Response("gateway down", { status: 502 }),
  });
  const client = new CanonClient(SERVER, "bad");
  await assert.rejects(client.me(), (e: unknown) => e instanceof HttpError && e.status === 401 && e.message === "unknown token");
  await assert.rejects(client.facts(), (e: unknown) => e instanceof HttpError && e.status === 502 && e.message === "GET /api/facts → 502");
});

test("group names: display, then name, then the id; a missing route falls back to {} but other errors surface", async (t) => {
  fakeCanon(t, { "GET /api/groups": { groups: [{ id: "market/public", display: "Public market" }, { id: "firm/ops", name: "Firm operations" }, { id: "x/y" }] } });
  assert.deepEqual(await new CanonClient(SERVER, "tok").groupNames(), { "market/public": "Public market", "firm/ops": "Firm operations", "x/y": "x/y" });
});

test("group names fall back to {} only on 404", async (t) => {
  let status = 404;
  fakeCanon(t, { "GET /api/groups": () => Response.json({ error: "nope" }, { status }) });
  const client = new CanonClient(SERVER, "tok");
  assert.deepEqual(await client.groupNames(), {});
  status = 500;
  await assert.rejects(client.groupNames(), (e: unknown) => e instanceof HttpError && e.status === 500);
});

test("running an agent that isn't in the caller's list sends nothing and is a 404", async (t) => {
  const canon = fakeCanon(t, { "GET /api/agents": { agents: [] } });
  await assert.rejects(new CanonClient(SERVER, "tok").runAgent("someone-elses"), (e: unknown) => e instanceof HttpError && e.status === 404);
  assert.ok(canon.calls.every((c) => c.method === "GET"));
});

test("live agent events refetch the run and map run states to started or finished", async (t) => {
  let status = "running";
  const canon = fakeCanon(t, { "GET /api/agents": () => ({ agents: [run({ status })] }) });
  const seen: MemberEvent[] = [];
  const close = new CanonClient(SERVER, "tok").subscribe((e) => seen.push(e), () => {});
  await canon.settle();
  canon.push("agent.run", { type: "agent.run", at: "t1", run: { agent: "research-analyst", id: "run_1" } });
  await canon.settle();
  status = "done";
  canon.push("agent.run", { type: "agent.run", at: "t2", run: { agent: "research-analyst", id: "run_1" } });
  await canon.settle();
  canon.push("agent.step", { type: "agent.step", at: "t3", step: { run_id: "run_unknown" }, run: { agent: "not-mine" } });
  await canon.settle();
  close(); canon.close();
  assert.deepEqual(seen.map((e) => `${e.type}@${e.at}`), ["agent.started@t1", "agent.finished@t2"], "an agent outside the caller's list is dropped");
});

test("a retired fact asks the page to refresh its memory; unknown event types are ignored", async (t) => {
  const canon = fakeCanon(t, { "GET /api/me": { id: "ben", kind: "person", name: "Ben Kim" } });
  const seen: MemberEvent[] = [];
  const close = new CanonClient(SERVER, "tok").subscribe((e) => seen.push(e), () => {});
  await canon.settle();
  canon.push("fact.retired", { type: "fact.retired", at: "t1", fact_id: "fct_1" });
  canon.push("distill.finished", { type: "distill.finished", at: "t2" });
  await canon.settle();
  close(); canon.close();
  assert.deepEqual(seen, [{ type: "scope.changed", at: "t1", principal: "ben", added: [], removed: [] }]);
});

test("after unsubscribing, late events reach no one", async (t) => {
  const canon = fakeCanon(t, { "GET /api/facts": { facts: [fact("fct_1", "Current")] } });
  const seen: MemberEvent[] = [];
  const close = new CanonClient(SERVER, "tok").subscribe((e) => seen.push(e), () => {});
  await canon.settle();
  canon.push("fact.saved", { type: "fact.saved", at: "t1", fact: { id: "fct_1" } });
  close(); // closes before the handler's refetch resolves
  await canon.settle();
  canon.close();
  assert.deepEqual(seen, []);
});

test("the stream reports connecting, then live", async (t) => {
  const canon = fakeCanon(t, {});
  const statuses: string[] = [];
  const close = new CanonClient(SERVER, "tok").subscribe(() => {}, (s) => statuses.push(s));
  await canon.settle();
  close(); canon.close();
  assert.deepEqual(statuses, ["connecting", "live"]);
});
