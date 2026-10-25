// The moderator mock plays Canon for the console. These walk the demo script against it: the
// 0:00 handoff, the 0:25 quarantine, the 0:40 scope build, the 1:20 refile, the deal-dies backup,
// the inbox and new groups.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModEvent } from "./contract.ts";
import { DEMO_ITEMS, ModeratorMock } from "./mock.ts";

const fast = () => new ModeratorMock({ stepMs: 1, buildMs: 1, triageMs: 1 });
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const BEN_TASK = "Write the asset management sector note from public market data.";

function collect(api: ModeratorMock): ModEvent[] {
  const seen: ModEvent[] = [];
  api.subscribe((e) => seen.push(e), () => {});
  return seen;
}

async function scopeOf(api: ModeratorMock, id: string) {
  const p = (await api.principals()).find((x) => x.id === id)!;
  const facts = await api.facts();
  return facts.filter((f) => p.fact_ids.includes(f.id));
}

async function buildBen(api: ModeratorMock) {
  await api.setRule("ben", { task: BEN_TASK, exclusions: { groups: ["deal/stonewall", "desk/dollar-bill"], labels: [], text: [] } });
  await wait();
}

test("seed state follows the timeline: Ben has no scope, moderators see everything", async () => {
  const api = fast();
  const ps = await api.principals();
  assert.equal(ps.find((p) => p.id === "ben")!.rule, null);
  assert.equal(ps.find((p) => p.id === "ben")!.fact_ids.length, 0);
  assert.equal(ps.find((p) => p.id === "wags")!.fact_ids.length, (await api.facts()).length);
});

test("0:00: Dollar Bill's desk assistant is handed no Stonewall fact", async () => {
  const api = fast();
  const [h] = await api.handoffs();
  const stonewall = new Set((await api.facts()).filter((f) => f.group === "deal/stonewall").map((f) => f.id));
  assert.equal(h!.principal, "desk-assistant");
  assert.ok(h!.candidates.every((c) => !stonewall.has(c.fact_id)));
  assert.ok((await scopeOf(api, "dollar-bill")).every((f) => f.group !== "deal/stonewall"));
});

test("0:25: counsel's email is quarantined and files nothing", async () => {
  const api = fast();
  const events = collect(api);
  const email = DEMO_ITEMS.find((d) => d.id === "itm_counsel_email")!;
  const before = (await api.facts()).length;
  await api.addItem({ kind: email.kind as "email", source: email.source, text: email.text, author: email.author });
  await wait();
  assert.equal((await api.quarantine()).length, 1);
  assert.equal((await api.facts()).length, before);
  assert.ok(events.some((e) => e.type === "item.quarantined"));
});

test("0:25: the other live items file the answer key's facts", async () => {
  const api = fast();
  const memo = DEMO_ITEMS.find((d) => d.id === "itm_sw_valuation")!;
  await api.addItem({ kind: memo.kind as "memo", source: memo.source, text: memo.text, author: memo.author });
  await wait();
  const facts = await api.facts();
  assert.ok(facts.some((f) => f.source_title === memo.source && f.group === "deal/stonewall"));
  assert.ok((await scopeOf(api, "axe")).some((f) => f.source_title === memo.source), "joins Axe's scope");
  assert.ok((await scopeOf(api, "dollar-bill")).every((f) => f.source_title !== memo.source), "never Dollar Bill's");
});

test("0:40: building Ben's scope streams four stages and removes the walled groups in code", async () => {
  const api = fast();
  const events = collect(api);
  await buildBen(api);
  const stages = events.filter((e): e is Extract<ModEvent, { type: "scope.build" }> => e.type === "scope.build" && e.principal === "ben");
  assert.deepEqual(stages.map((s) => s.stage), ["exclusions", "candidates", "judged", "done"]);
  assert.deepEqual(stages[0]!.groups_removed, ["Project Stonewall", "Dollar Bill's desk"]);
  const ben = await scopeOf(api, "ben");
  assert.ok(ben.length > 0);
  assert.ok(ben.every((f) => f.group !== "deal/stonewall" && f.group !== "desk/dollar-bill"));
  assert.ok((await scopeOf(api, "research-analyst")).length > 0, "his agent picks up from his scope");
});

test("1:20: refiling the announced terms reaches Ben and Dollar Bill; the deal analyst keeps them", async () => {
  const api = fast();
  await buildBen(api);
  const announced = (await api.facts()).filter((f) => f.group === "deal/stonewall" && /52\.75|premium|tender offer|equity value|November 10/i.test(f.statement)).map((f) => f.id);
  assert.ok(announced.length > 0);
  const deal = (await scopeOf(api, "deal-analyst")).length;
  await api.fileFacts(announced, "market/public");
  const offer = (await api.facts()).find((f) => /52\.75/.test(f.statement))!;
  assert.equal(offer.group, "market/public");
  assert.ok((await scopeOf(api, "ben")).some((f) => f.id === offer.id));
  assert.ok((await scopeOf(api, "dollar-bill")).some((f) => f.id === offer.id));
  assert.equal((await scopeOf(api, "deal-analyst")).length, deal);
  assert.ok((await scopeOf(api, "ben")).every((f) => !/walk-away|1\.9 billion|standstill/i.test(f.statement)), "valuation and financing stay walled");
});

test("deal dies: excluding Stonewall empties the deal analyst and withdraws its documents", async () => {
  const api = fast();
  await api.runAgent("deal-analyst");
  await wait(60);
  assert.ok((await api.agents()).find((a) => a.id === "deal-analyst")!.outputs.length > 0);
  await api.setRule("deal-analyst", { task: "Draft the Stonewall bid memo and run a simple valuation in Python.", exclusions: { groups: ["deal/stonewall", "firm/ops"], labels: [], text: [] } });
  await wait();
  const run = (await api.agents()).find((a) => a.id === "deal-analyst")!;
  assert.equal(run.fact_count, 0);
  assert.equal(run.outputs.length, 0);
});

test("agents never hold more than their creator", async () => {
  const api = fast();
  await buildBen(api);
  for (const p of (await api.principals()).filter((x) => x.kind === "agent")) {
    const creator = (await api.principals()).find((x) => x.id === p.creator)!;
    for (const id of p.fact_ids) assert.ok(creator.fact_ids.includes(id), `${p.id} holds ${id} outside ${creator.id}`);
  }
});

test("inbox facts join no scope until filed", async () => {
  const api = fast();
  const inbox = (await api.facts()).filter((f) => f.group === "inbox");
  assert.equal(inbox.length, 2);
  for (const p of (await api.principals()).filter((x) => x.tier !== "moderator")) assert.ok(inbox.every((f) => !p.fact_ids.includes(f.id)));
  await api.fileFacts([inbox[1]!.id], "firm/ops");
  assert.equal((await api.facts()).filter((f) => f.group === "inbox").length, 1);
});

test("a new group reaches no one until it is added to a rule", async () => {
  const api = fast();
  const g = await api.createGroup("Counterparty counsel", "");
  await assert.rejects(api.createGroup("counterparty COUNSEL", ""), /already exists/);
  for (const p of (await api.principals()).filter((x) => x.rule)) assert.ok(p.rule!.exclusions.groups.includes(g.id), p.id);
  const inbox = (await api.facts()).find((f) => f.group === "inbox")!;
  await api.fileFacts([inbox.id], g.id);
  for (const p of (await api.principals()).filter((x) => x.tier !== "moderator")) assert.ok(!p.fact_ids.includes(inbox.id), p.id);
});

test("stop ends a run; retiring a fact takes it out of every scope", async () => {
  const api = new ModeratorMock({ stepMs: 40, buildMs: 1, triageMs: 1 });
  await api.runAgent("desk-assistant");
  await api.stopAgent("desk-assistant");
  assert.equal((await api.agents()).find((a) => a.id === "desk-assistant")!.status, "stopped");
  const f = (await scopeOf(api, "dollar-bill"))[0]!;
  await api.retireFact(f.id);
  for (const p of await api.principals()) assert.ok(!p.fact_ids.includes(f.id), p.id);
});
