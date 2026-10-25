import assert from "node:assert/strict";
import { test } from "node:test";
import { CanonModClient } from "./canon.ts";
import { CanonClient, HttpError } from "../member/canon.ts";
import { fakeCanon } from "../fake-canon.ts";
import type { ModEvent } from "./contract.ts";

test("filing a fact does not clear its existing label barriers", async (t) => {
  const calls: { path: string; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (path: string, options: RequestInit) => { calls.push({ path, body: JSON.parse(options.body as string) }); return Response.json({}); });
  await new CanonModClient("https://preview.example", "test").fileFacts(["fct_ab12"], "market/public");
  assert.deepEqual(calls, [{ path: "https://preview.example/api/facts/fct_ab12/file", body: { group: "market/public" } }]);
});

test("member and moderator dispatch their agent's stored task", async (t) => {
  const posted: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_path: string, options: RequestInit) => {
    if (options.method === "GET") return Response.json({ agents: [{ id: "research-analyst", task: "Compare public manager earnings" }] });
    posted.push(JSON.parse(options.body as string));
    return Response.json({ id: "run_1234" });
  });
  await new CanonModClient("https://preview.example", "test").runAgent("research-analyst");
  await new CanonClient("https://preview.example", "test").runAgent("research-analyst");
  assert.deepEqual(posted, [{ task: "Compare public manager earnings" }, { task: "Compare public manager earnings" }]);
});

test("cookie clients omit bearer headers and ask Canon to preserve hidden agent barriers on edits", async (t) => {
  const posted: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_path: string, options: RequestInit) => {
    assert.equal(options.credentials, "same-origin");
    assert.equal((options.headers as Record<string, string>).authorization, undefined);
    posted.push(JSON.parse(options.body as string));
    return Response.json({ build_id: "bld_1234" });
  });
  await new CanonClient("https://preview.example", "").updateAgent("research-analyst", { name: "Fixed name", task: "Revised task", exclusions: { groups: [], labels: [], text: ["firm operations"] }, docs: [], schedule: "Only when I press Run" });
  // The member's own leave-out sentence is sent; Canon only ever adds it to a rule Compliance set.
  assert.deepEqual(posted, [{ task: "Revised task", preserve_exclusions: true, exclude_text: "firm operations" }]);
});

test("a canonical save event is displayed from the current authorized snapshot, never its old payload", async (t) => {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  t.mock.method(globalThis, "fetch", async (path: string) => path.endsWith("/events") ? new Response(stream) : Response.json({ facts: [{ id: "fct_1234", group: "market/public", statement: "Current permitted statement", labels: [], status: "hot" }] }));
  const seen: unknown[] = [];
  const client = new CanonClient("https://preview.example", "test");
  const close = client.subscribe((event) => seen.push(event), () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller!.enqueue(new TextEncoder().encode('event: fact.saved\ndata: {"type":"fact.saved","at":"now","fact":{"id":"fct_1234","statement":"Stale raw statement"}}\n\nevent: fact.saved\ndata: {"type":"fact.saved","at":"now","fact":{"id":"fct_revoked","statement":"Revoked raw statement"}}\n\n'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  close(); controller!.close();
  assert.deepEqual(seen, [{ type: "fact.saved", at: "now", fact: { id: "fct_1234", group: "market/public", statement: "Current permitted statement", labels: [], status: "hot" } }]);
});

// ---- Fuller coverage against a fake Canon (routes, envelopes, errors, event mapping).


const SERVER = "https://preview.example";
const modFact = (id: string, group: string) => ({ id, statement: id, group, labels: [], source: "itm", author: "wags", happened_at: "", learned_at: "", status: "hot" });

test("principals merge each one's rule and scope; a principal without a scope gets an empty one", async (t) => {
  fakeCanon(t, {
    "GET /api/principals": { principals: [{ id: "dollar-bill", kind: "person", name: "Dollar Bill", tier: "member" }, { id: "ben", kind: "person", name: "Ben Kim", tier: "member" }] },
    "GET /api/principals/dollar-bill/scope": { rule: { task: "Positions and public news", exclusions: { groups: ["deal/*"], labels: [], text: [] } }, fact_ids: ["fct_1", "fct_2"] },
    "GET /api/principals/ben/scope": Response.json({ error: "not found" }, { status: 404 }),
  });
  const ps = await new CanonModClient(SERVER, "tok").principals();
  assert.deepEqual(ps.map((p) => [p.id, p.rule?.task ?? null, p.fact_ids.length]), [["dollar-bill", "Positions and public news", 2], ["ben", null, 0]]);
});

test("a scope read that fails for any other reason surfaces instead of looking empty", async (t) => {
  fakeCanon(t, {
    "GET /api/principals": { principals: [{ id: "ben", kind: "person", name: "Ben Kim" }] },
    "GET /api/principals/ben/scope": Response.json({ error: "boom" }, { status: 500 }),
  });
  await assert.rejects(new CanonModClient(SERVER, "tok").principals(), (e: unknown) => e instanceof HttpError && e.status === 500 && e.message === "boom");
});

test("facts put inbox facts first without duplicating ones the main list already has", async (t) => {
  fakeCanon(t, {
    "GET /api/facts": { facts: [modFact("fct_1", "market/public"), modFact("fct_2", "inbox")] },
    "GET /api/inbox": { facts: [modFact("fct_2", "inbox"), modFact("fct_3", "inbox")] },
  });
  assert.deepEqual((await new CanonModClient(SERVER, "tok").facts()).map((f) => f.id), ["fct_3", "fct_1", "fct_2"]);
});

test("filing several facts sends one call per fact, in order", async (t) => {
  const canon = fakeCanon(t, { "POST /api/facts/fct_1/file": {}, "POST /api/facts/fct_2/file": {} });
  await new CanonModClient(SERVER, "tok").fileFacts(["fct_1", "fct_2"], "market/public");
  assert.deepEqual(canon.calls.map((c) => [c.path, c.body]), [["/api/facts/fct_1/file", { group: "market/public" }], ["/api/facts/fct_2/file", { group: "market/public" }]]);
});

test("people, tiers, rules, groups and quarantine use the contract routes and bodies", async (t) => {
  const rule = { task: "Sector note", exclusions: { groups: ["deal/stonewall"], labels: [], text: [] } };
  const canon = fakeCanon(t, {
    "POST /api/principals": { id: "p_1", kind: "person", name: "Taylor", tier: "member", rule: null, fact_ids: [] },
    "POST /api/principals/ben/tier": new Response(null, { status: 204 }),
    "PUT /api/principals/ben/rule": { build_id: "bld_1" },
    "POST /api/groups": { id: "custom/counsel", name: "Counsel", description: "" },
    "POST /api/items": { item_id: "ses_9" },
    "POST /api/quarantine/q_1/release": {},
  });
  const client = new CanonModClient(SERVER, "tok");
  assert.equal((await client.addPerson("Taylor", "member")).id, "p_1");
  await client.setTier("ben", "moderator");
  assert.deepEqual(await client.setRule("ben", rule), { build_id: "bld_1" });
  assert.equal((await client.createGroup("Counsel", "")).id, "custom/counsel");
  await client.addItem({ kind: "email", source: "Counsel email", text: "…", author: "axe" });
  await client.release("q_1");
  assert.deepEqual(canon.calls.map((c) => c.body), [{ name: "Taylor", tier: "member" }, { tier: "moderator" }, rule, { name: "Counsel", description: "" }, { kind: "email", source: "Counsel email", text: "…", author: "axe" }, undefined]);
});

test("list reads unwrap their envelopes", async (t) => {
  fakeCanon(t, {
    "GET /api/groups": { groups: [{ id: "market/public", name: "Public market", description: "" }] },
    "GET /api/quarantine": { items: [{ id: "q_1", kind: "email", source: "Counsel email", author: "axe", reason: "Instructions aimed at an AI", at: "" }] },
    "GET /api/handoffs": { handoffs: [{ id: "hnd_1" }] },
    "GET /api/audit": { entries: [{ at: "", principal: "ben", group: null, text: "Scope built" }] },
  });
  const client = new CanonModClient(SERVER, "tok");
  assert.equal((await client.groups())[0]!.name, "Public market");
  assert.equal((await client.quarantine())[0]!.id, "q_1");
  assert.equal((await client.handoffs())[0]!.id, "hnd_1");
  assert.equal((await client.audit())[0]!.text, "Scope built");
});

test("live events: quarantine, filing, tier changes and handoffs become console events", async (t) => {
  const handoff = { id: "hnd_1", at: "t4", principal: "desk-assistant", request: "TMC?", candidates: [], tokens_est: 0, budget_est: 0, timings_ms: { search: 1, judge: 2, total: 3 }, simulated: false };
  const canon = fakeCanon(t, {
    "GET /api/quarantine": { items: [{ id: "q_1", kind: "email", source: "Counsel email", author: "axe", reason: "Instructions aimed at an AI", at: "t1" }] },
    "GET /api/principals": { principals: [{ id: "ben", kind: "person", name: "Ben Kim", tier: "moderator" }] },
    "GET /api/principals/ben/scope": { rule: null, fact_ids: [] },
    "GET /api/handoffs": { handoffs: [handoff] },
  });
  const seen: ModEvent[] = [];
  const close = new CanonModClient(SERVER, "tok").subscribe((e) => seen.push(e), () => {});
  await canon.settle();
  canon.push("quarantine.flagged", { type: "quarantine.flagged", at: "t1", quarantine_id: "q_1" });
  await canon.settle();
  canon.push("fact.filed", { type: "fact.filed", at: "t2", fact_id: "fct_1", group: "market/public", from: "deal/stonewall" });
  await canon.settle();
  canon.push("principal.changed", { type: "principal.changed", at: "t3", change: "tier_changed", principal: { id: "ben" } });
  await canon.settle();
  canon.push("handoff.served", { type: "handoff.served", at: "t4", principal: "desk-assistant" });
  await canon.settle();
  canon.push("audit.logged", { type: "audit.logged", at: "t5" });
  await canon.settle();
  close(); canon.close();
  assert.deepEqual(seen.map((e) => e.type), ["item.quarantined", "fact.filed", "principal.tier", "context.served", "scope.changed"]);
  assert.deepEqual(seen[1], { type: "fact.filed", at: "t2", fact_ids: ["fct_1"], group: "market/public", from: ["deal/stonewall"] });
  assert.equal((seen[2] as unknown as { principal: { id: string } }).principal.id, "ben");
  assert.equal((seen[3] as Extract<ModEvent, { type: "context.served" }>).handoff.id, "hnd_1");
});

test("a quarantine event for an item that is no longer held shows nothing", async (t) => {
  const canon = fakeCanon(t, { "GET /api/quarantine": { items: [] } });
  const seen: ModEvent[] = [];
  const close = new CanonModClient(SERVER, "tok").subscribe((e) => seen.push(e), () => {});
  await canon.settle();
  canon.push("quarantine.flagged", { type: "quarantine.flagged", at: "t1", quarantine_id: "q_gone" });
  await canon.settle();
  close(); canon.close();
  assert.deepEqual(seen, []);
});
