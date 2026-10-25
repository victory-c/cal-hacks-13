// Memory layers: top of mind vs background, on the scoring alone and over real HTTP through the
// handoff, the member view and a restart. The judge is the offline simulated one (scope-judge.ts),
// so these tests check what code guarantees around Jev's answers, never a model's quality.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { FakeJudge } from "@canon/shared";
import type { Fact, Grant, HandoffResult, ScopeRule } from "@canon/shared";

import { startServer } from "./app.ts";
import type { RunningServer } from "./app.ts";
import { LAYERS, dayOf, emptyLayerState, layerOf, recordUse, restoreLayers, salience, serializeLayers, setPin } from "./memory-layers.ts";
import { KeywordRetriever } from "./retrieval/keyword.ts";
import { simulatedScopeAnswers } from "./scope-judge.ts";
import type { WorldFixtures } from "./scopes.ts";
import { FileStore } from "./store.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-25T00:00:00Z");
const day = (offset: number, from = Date.now()) => dayOf(from + offset * DAY);
const fact = (id: string, statement: string, extra: Partial<Fact> = {}): Fact => ({ id, folder: "market/public", author: "alice", statement, tier: "hot", jev_keep: 0.8, source: { client: "ingest", session: "ses_aa0011" }, updated: dayOf(NOW), ...extra });
const alice = { id: "alice", kind: "person" as const };

describe("memory layers: scoring", () => {
  test("salience is importance times a recency that halves every half-life and never reaches zero", () => {
    const fresh = salience(fact("fct_1", "x"), undefined, NOW);
    assert.equal(Math.round(fresh * 100) / 100, 0.8);
    const old = salience(fact("fct_1", "x", { updated: day(-LAYERS.HALF_LIFE_DAYS, NOW) }), undefined, NOW);
    assert.equal(Math.round(old * 1000) / 1000, Math.round(0.8 * (0.3 + 0.35) * 1000) / 1000, "one half-life: recency 0.5");
    const ancient = salience(fact("fct_1", "x", { updated: "2020-01-01" }), undefined, NOW);
    assert.ok(ancient > 0.8 * 0.3 - 1e-9 && ancient < 0.25, "floored at 0.3 of importance");
    const usedYesterday = salience(fact("fct_1", "x", { updated: "2020-01-01" }), { uses: 3, last_used: new Date(NOW - DAY).toISOString() }, NOW);
    assert.ok(usedYesterday > 0.75, "a use makes an old fact fresh again");
  });

  test("layerOf: a person's pin wins; then past its date; then idle; else top of mind", () => {
    const state = emptyLayerState();
    const f = fact("fct_1", "Expense reports were due October 23");
    assert.deepEqual([layerOf(state, alice, f, NOW).layer, layerOf(state, alice, f, NOW).reason], ["top", "current"]);
    state.currency.set(f.id, { on: dayOf(NOW), p: 0.1 });
    assert.deepEqual([layerOf(state, alice, f, NOW).layer, layerOf(state, alice, f, NOW).reason], ["background", "past_date"]);
    setPin(state, "alice", f.id, "top");
    assert.deepEqual([layerOf(state, alice, f, NOW).layer, layerOf(state, alice, f, NOW).reason], ["top", "pinned"]);
    setPin(state, "alice", f.id, "auto");
    state.currency.delete(f.id);
    const idle = fact("fct_2", "x", { updated: "2025-01-01" });
    assert.deepEqual([layerOf(state, alice, idle, NOW).layer, layerOf(state, alice, idle, NOW).reason], ["background", "idle"]);
    recordUse(state, "alice", [idle.id], NOW);
    assert.equal(layerOf(state, alice, idle, NOW).layer, "top", "using it brings it back");
    assert.equal(layerOf(state, alice, idle, NOW).uses, 1);
    setPin(state, "alice", f.id, "background");
    assert.deepEqual([layerOf(state, alice, f, NOW).layer, layerOf(state, alice, f, NOW).reason], ["background", "moved"]);
    const agent = { id: "agt_1", kind: "agent" as const, created_by: "alice" };
    assert.equal(layerOf(state, agent, f, NOW).reason, "moved", "an agent follows its creator's overrides");
    assert.equal(layerOf(state, { id: "bob", kind: "person" as const }, f, NOW).layer, "top", "and nobody else's");
  });

  test("the layer state round-trips through its saved form", () => {
    const state = emptyLayerState();
    recordUse(state, "alice", ["fct_1"], NOW);
    setPin(state, "alice", "fct_2", "background");
    state.currency.set("fct_3", { on: "2026-10-25", p: 0.2 });
    const back = restoreLayers(JSON.parse(JSON.stringify(serializeLayers(state))));
    assert.deepEqual(serializeLayers(back), serializeLayers(state));
    assert.deepEqual(serializeLayers(restoreLayers({ usage: [["k", { uses: "x" }]], pins: [["k", "sideways"]] })), serializeLayers(emptyLayerState()), "malformed rows are dropped");
  });
});

describe("memory layers over HTTP", () => {
  const rule = (principal: string): ScopeRule => ({ principal, task: "Public market notes, deadlines and holdings", exclude: { groups: [], labels: [] }, set_by: "mod", updated_at: "2026-10-24T00:00:00Z" });
  const world = (): WorldFixtures => ({
    groups: [{ id: "market/public", display: "Public market", description: "Public market data" }],
    principals: [{ id: "mod", kind: "person", name: "Moderator", tier: "moderator" }, { id: "alice", kind: "person", name: "Alice", tier: "member" }, { id: "bob", kind: "person", name: "Bob", tier: "member" }],
    rules: [rule("alice"), rule("bob")],
    scopes: [], quarantine: [], audit: [],
    initial_scopes: ["alice", "bob"],
  });
  const grants: Grant[] = ["mod", "alice", "bob"].map((id) => ({ client: id, principal: id, read: [], write: [] } as Grant)).concat([{ client: "distiller", read: [], write: [] }]);
  const tokens = new Map(grants.map((g) => [`tok-${g.client}`, g.client]));
  const call = (server: RunningServer, path: string, client: string, body?: unknown) =>
    fetch(`${server.url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer tok-${client}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  type MemberFact = { id: string; layer: string; layer_reason: string; uses: number; last_used: string | null };
  const factsOf = async (server: RunningServer, who: string) => ((await (await call(server, "/api/facts", who)).json()) as { facts: MemberFact[] }).facts.sort((a, b) => a.id.localeCompare(b.id));
  const start = (dir: string) => startServer({ dataDir: dir, world: world(), tokens, grants, judge: new FakeJudge({ override: simulatedScopeAnswers }), retriever: new KeywordRetriever(), log: () => {} });

  test("a past deadline drops to the background: left out of general requests, served when asked about, per person, kept across a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bullwark-layers-"));
    const store = new FileStore(dir);
    const past = day(-2);
    await store.putFact(fact("fct_aa0001", `Expense reports were due on ${past}`, { happened: past, updated: past }));
    await store.putFact(fact("fct_aa0002", "TMC assets under management were $38.4 billion", { updated: day(-1) }));
    let server = await start(dir);
    try {
      // The start-up sweep asked about today's currency: the deadline has passed.
      let mine = await factsOf(server, "alice");
      assert.deepEqual(mine.map((f) => [f.id, f.layer, f.layer_reason]), [["fct_aa0001", "background", "past_date"], ["fct_aa0002", "top", "current"]]);

      const handoff = async (task: string) => (await (await call(server, "/api/handoff", "alice", { task })).json()) as HandoffResult;
      const general = await handoff("Anything on expense or TMC assets I should know?");
      assert.deepEqual(general.facts.map((f) => f.id), ["fct_aa0002"], "the background fact is left out of a general request");
      // Compliance's handoff inspector says why: in the background, and not asked about.
      const inspected = (await (await call(server, "/api/handoffs", "mod")).json()) as { handoffs: Array<{ candidates: Array<{ fact_id: string; decision: string }> }> };
      assert.equal(inspected.handoffs[0]?.candidates.find((c) => c.fact_id === "fct_aa0001")?.decision, "cut_background");
      const asked = await handoff("When were the expense reports due?");
      assert.deepEqual(asked.facts.map((f) => f.id), ["fct_aa0001"], "asked about specifically, it comes back");

      mine = await factsOf(server, "alice");
      assert.equal(mine.find((f) => f.id === "fct_aa0002")?.uses, 1, "every fact served is a use");
      assert.ok(mine.find((f) => f.id === "fct_aa0002")?.last_used);

      // Alice keeps the deadline top of mind; Bob's view does not change.
      const pinned = await call(server, "/api/facts/fct_aa0001/layer", "alice", { layer: "top" });
      assert.equal(pinned.status, 200);
      assert.deepEqual(((await pinned.json()) as MemberFact).layer_reason, "pinned");
      assert.equal((await factsOf(server, "bob")).find((f) => f.id === "fct_aa0001")?.layer, "background");
      assert.deepEqual((await handoff("Anything on expense or TMC assets I should know?")).facts.map((f) => f.id).sort(), ["fct_aa0001", "fct_aa0002"]);
      assert.equal((await call(server, "/api/facts/fct_aa0002/layer", "alice", { layer: "background" })).status, 200);
      assert.equal((await call(server, "/api/facts/fct_zz9999/layer", "alice", { layer: "top" })).status, 404, "only facts in their own scope");
      assert.equal((await call(server, "/api/facts/fct_aa0002/layer", "alice", { layer: "sideways" })).status, 400);

      await server.close();
      server = await start(dir);
      mine = await factsOf(server, "alice");
      assert.deepEqual(mine.map((f) => [f.id, f.layer, f.layer_reason]), [["fct_aa0001", "top", "pinned"], ["fct_aa0002", "background", "moved"]], "overrides and uses survive a restart");
      assert.equal(mine.find((f) => f.id === "fct_aa0002")?.uses, 2, "served by the first and the third request");
      assert.equal((await call(server, "/api/facts/fct_aa0002/layer", "alice", { layer: "auto" })).status, 200);
      assert.equal((await factsOf(server, "alice")).find((f) => f.id === "fct_aa0002")?.layer, "top", "auto hands it back to Bullwark");
    } finally {
      await server.close().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("memory layers: a newer fact can outdate an older one", () => {
  test("the currency check shows the judge the group's facts newest first, and a save re-checks the whole group", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bullwark-layers-group-"));
    const store = new FileStore(dir);
    await store.putFact(fact("fct_bb0001", "The desk is long 180,000 TMC shares", { updated: day(-3), folder: "desk/alice" }));
    const seen: string[] = [];
    // The stand-in judge answers question by question; one batch is one distinct state.
    const judge = new FakeJudge({ override: (q, state) => { if (q.id.startsWith("cur:") && !seen.includes(state)) seen.push(state); return simulatedScopeAnswers(q, state); } });
    const world = (): WorldFixtures => ({
      groups: [{ id: "desk/alice", display: "Alice's desk", description: "Alice's positions" }],
      principals: [{ id: "alice", kind: "person", name: "Alice", tier: "member" }],
      rules: [{ principal: "alice", task: "My positions", exclude: { groups: [], labels: [] }, set_by: "alice", updated_at: "2026-10-24T00:00:00Z" }],
      scopes: [], quarantine: [], audit: [], initial_scopes: ["alice"],
    });
    const server = await startServer({ dataDir: dir, world: world(), tokens: new Map([["tok-alice", "alice"]]), grants: [{ client: "alice", principal: "alice", read: [], write: [] } as Grant], judge, retriever: new KeywordRetriever(), log: () => {} });
    try {
      assert.equal(seen.length, 1, "one batched check at start-up");
      const newer = fact("fct_bb0002", "The desk is now long 220,000 TMC shares", { updated: day(0), folder: "desk/alice" });
      await server.store.putFact(newer);
      server.bus.emit({ type: "fact.saved", fact: newer, decision: { action: "add", folder: newer.folder, tier: "hot", keep_p: 0.9, folder_p: 1, judge: "fake" } });
      for (let i = 0; i < 100 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(seen.length, 2, "the save triggered one more batched check");
      const state = seen[1]!;
      assert.ok(state.indexOf("fct_bb0002") < state.indexOf("fct_bb0001"), "newest first, so the judge sees the newer figure before the older one");
      assert.equal(server.world.layers.currency.get("fct_bb0001")?.on, dayOf(Date.now()), "the older fact in the group was asked about again");
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
