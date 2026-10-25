// Issue #20 over real HTTP: POST /api/facts must authorize every existing record it would change
// (same-id overwrite, merge/supersede target) and keep fact and decision supersession consistent.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { DEMO_GRANTS, FakeJudge } from "@canon/shared";
import type { CanonEvent, Fact, SaveDecision } from "@canon/shared";

import { startServer } from "./app.ts";
import type { RunningServer } from "./app.ts";
import { KeywordRetriever } from "./retrieval/keyword.ts";
import { FileStore } from "./store.ts";

const tokens = new Map([
  ["tok-cc", "claude-code"],
  ["tok-dist", "distiller"],
  ["tok-wags", "wags"],
]);

// Synthetic records. claude-code's default write grant covers projects/ only.
const privateFact: Fact = {
  id: "fct_aaaabbbb",
  statement: "Synthetic private health fact",
  folder: "private/health",
  tier: "hot",
  jev_keep: 0.9,
  source: { client: "distiller", session: "ses_b2000001" },
  updated: "2026-10-24",
};
const projectFact: Fact = { ...privateFact, id: "fct_b2000001", statement: "Synthetic project fact", folder: "projects/canon" };
// A scope group fact: members reach it only through their scope, never by a direct write.
const dealFact: Fact = { ...privateFact, id: "fct_dea10001", statement: "Synthetic deal fact", folder: "deal/falcon" };

function entry(fact: Fact, action: SaveDecision["action"] = "add", supersedes?: string): { fact: Fact; decision: SaveDecision } {
  return {
    fact: action === "add" || !supersedes ? fact : { ...fact, supersedes },
    decision: {
      action, tier: fact.tier, folder: fact.folder, keep_p: 0.9, folder_p: 0.9, judge: "fake",
      ...(supersedes ? { supersedes } : {}),
    },
  };
}

interface Harness {
  server: RunningServer;
  events: CanonEvent[];
  post(token: string, facts: unknown[]): Promise<{ status: number; body: Record<string, unknown> }>;
  /** In-memory index and the files on disk, which must agree. */
  snapshot(): Promise<{ memory: Fact[]; disk: Fact[] }>;
}

async function setup(t: TestContext, seed: Fact[] = [privateFact, projectFact]): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "canon-api-facts-http-"));
  const server = await startServer({ port: 0, dataDir: dir, tokens, grants: [...DEMO_GRANTS], judge: new FakeJudge(), retriever: new KeywordRetriever(), log: () => {} });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (const fact of seed) await server.store.putFact(fact);
  const events: CanonEvent[] = [];
  server.bus.subscribe((e) => events.push(e));
  return {
    server,
    events,
    async post(token, facts) {
      const res = await fetch(`${server.url}/api/facts`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ facts }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    async snapshot() {
      const reloaded = new FileStore(dir);
      await reloaded.loadAll();
      return { memory: server.store.listFacts(), disk: reloaded.listFacts() };
    },
  };
}

const mutations = (events: CanonEvent[]) => events.filter((e) => e.type === "fact.saved" || e.type === "fact.retired");

test("HTTP POST /api/facts: reusing an unwritable fact's id is 403 and leaves it untouched", async (t) => {
  const h = await setup(t);
  const before = await h.snapshot();

  const res = await h.post("tok-cc", [entry({ ...projectFact, id: privateFact.id, statement: "Overwritten by claude-code" })]);

  assert.equal(res.status, 403);
  assert.ok(!String(res.body.error).includes(privateFact.folder), "the denial does not name the hidden folder");
  assert.deepEqual(await h.snapshot(), before);
  assert.deepEqual(h.server.store.getFact(privateFact.id), privateFact);
  assert.deepEqual(mutations(h.events), []);
  assert.ok(h.events.some((e) => e.type === "access.denied" && e.client === "claude-code"));
});

for (const action of ["supersede", "merge"] as const) {
  test(`HTTP POST /api/facts: ${action} of an unwritable fact is 403 and does not retire it`, async (t) => {
    const h = await setup(t);
    const before = await h.snapshot();

    const res = await h.post("tok-cc", [entry({ ...projectFact, id: "fct_b2000002" }, action, privateFact.id)]);

    assert.equal(res.status, 403);
    assert.deepEqual(await h.snapshot(), before);
    assert.equal(h.server.store.getFact(privateFact.id)?.tier, "hot");
    assert.equal(h.server.store.getFact("fct_b2000002"), undefined);
    assert.deepEqual(mutations(h.events), []);
  });
}

test("HTTP POST /api/facts: a mixed batch with one unauthorized entry changes nothing", async (t) => {
  const h = await setup(t);
  const before = await h.snapshot();

  const res = await h.post("tok-cc", [
    entry({ ...projectFact, id: "fct_b2000003" }),
    entry({ ...projectFact, id: "fct_b2000004" }, "supersede", projectFact.id),
    entry({ ...projectFact, statement: "Allowed in-place update" }),
    entry({ ...projectFact, id: "fct_b2000005" }, "merge", privateFact.id),
  ]);

  assert.equal(res.status, 403);
  assert.deepEqual(await h.snapshot(), before, "no entry before or after the denied one was written");
  assert.deepEqual(mutations(h.events), []);
});

test("HTTP POST /api/facts: authorized updates and retirement within the write grant still succeed", async (t) => {
  const h = await setup(t);

  const moved = { ...projectFact, statement: "Updated synthetic project fact", folder: "projects/other" as const };
  const update = await h.post("tok-cc", [entry(moved)]);
  assert.equal(update.status, 200);
  assert.deepEqual(update.body, { saved: [projectFact.id], retired: [] });
  assert.deepEqual(h.server.store.getFact(projectFact.id), moved);

  const replacement = { ...projectFact, id: "fct_b2000006" };
  const retire = await h.post("tok-cc", [entry(replacement, "supersede", projectFact.id)]);
  assert.equal(retire.status, 200);
  assert.deepEqual(retire.body, { saved: [replacement.id], retired: [projectFact.id] });
  assert.equal(h.server.store.getFact(projectFact.id)?.tier, "cold");
  assert.equal(h.server.store.getFact(replacement.id)?.supersedes, projectFact.id);

  // Re-saving the replacement in place keeps its lineage; that is not a new retirement.
  const resave = await h.post("tok-cc", [entry({ ...replacement, supersedes: projectFact.id, statement: "Reworded replacement" })]);
  assert.equal(resave.status, 200);
  assert.deepEqual(resave.body, { saved: [replacement.id], retired: [] });

  assert.deepEqual(h.server.store.getFact(privateFact.id), privateFact);
  const retired = h.events.filter((e) => e.type === "fact.retired");
  assert.deepEqual(retired.map((e) => e.type === "fact.retired" && [e.id, e.superseded_by]), [[projectFact.id, replacement.id]]);
});

test("HTTP POST /api/facts: the distiller may still retire a private fact it can write", async (t) => {
  const h = await setup(t);
  const res = await h.post("tok-dist", [entry({ ...privateFact, id: "fct_b2000007" }, "supersede", privateFact.id)]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { saved: ["fct_b2000007"], retired: [privateFact.id] });
  assert.equal(h.server.store.getFact(privateFact.id)?.tier, "cold");
});

test("HTTP POST /api/facts: a scope group fact is changed only by the distiller", async (t) => {
  const h = await setup(t, [privateFact, projectFact, dealFact]);
  const before = await h.snapshot();

  const denied: Array<[string, string, unknown]> = [
    ["claude-code reusing its id", "tok-cc", entry({ ...dealFact, folder: "projects/canon", statement: "Overwritten" })],
    ["claude-code superseding it", "tok-cc", entry({ ...projectFact, id: "fct_b2000009" }, "supersede", dealFact.id)],
    ["a member superseding it inside its group", "tok-wags", entry({ ...dealFact, id: "fct_dea10002" }, "supersede", dealFact.id)],
  ];
  for (const [name, token, body] of denied) {
    const res = await h.post(token, [body]);
    assert.equal(res.status, 403, name);
  }
  assert.deepEqual(await h.snapshot(), before);
  assert.deepEqual(mutations(h.events), []);

  const res = await h.post("tok-dist", [entry({ ...dealFact, id: "fct_dea10003" }, "supersede", dealFact.id)]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { saved: ["fct_dea10003"], retired: [dealFact.id] });
  assert.equal(h.server.store.getFact(dealFact.id)?.tier, "cold");
});

test("HTTP POST /api/facts: fact and decision supersession must agree", async (t) => {
  const h = await setup(t);
  const before = await h.snapshot();
  const fresh = { ...projectFact, id: "fct_b2000008" };
  const add = entry(fresh);
  const supersede = entry(fresh, "supersede", projectFact.id);

  const cases: Array<[string, unknown, RegExp]> = [
    ["add claiming a retirement on the fact", { ...add, fact: { ...fresh, supersedes: privateFact.id } }, /fact\.supersedes on "add" must be omitted or unchanged/],
    ["add with decision.supersedes", { ...add, decision: { ...add.decision, supersedes: projectFact.id } }, /decision\.supersedes must be omitted when action is "add"/],
    ["supersede without fact.supersedes", { ...supersede, fact: fresh }, /fact\.supersedes must equal decision\.supersedes/],
    ["supersede naming a different fact", { ...supersede, fact: { ...fresh, supersedes: privateFact.id } }, /fact\.supersedes must equal decision\.supersedes/],
    ["merge into itself", entry(projectFact, "merge", projectFact.id), /cannot merge itself/],
  ];
  for (const [name, body, re] of cases) {
    const res = await h.post("tok-cc", [body]);
    assert.equal(res.status, 400, name);
    assert.match(String(res.body.error), re, name);
  }

  assert.deepEqual(await h.snapshot(), before);
  assert.deepEqual(h.events, [], "rejected batches emit nothing");
});
