import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FakeJudge, TRIAGE_THRESHOLDS } from "@canon/shared";
import type { Answer, Deal, Entitlement, Fact, Judge, Question } from "@canon/shared";
import { quiet } from "../test-helpers.ts";
import { canSee, routeDealStatus, routeEntitlementChange, routeFact, simulatedRoutingAnswer } from "./routing.ts";
import type { RoutableRun, WallView } from "./routing.ts";

const falcon: Deal = {
  id: "deal_falcon",
  code_name: "Project Falcon",
  aliases: ["Falcon", "Nimbus"],
  companies: ["Nimbus Logistics"],
  status: "confidential",
  status_changed_at: "2026-10-20T09:00:00Z",
};
const danOnFalcon: Entitlement = { principal: "dan", deal: "deal_falcon", granted_by: "maya", granted_at: "2026-10-20T09:00:00Z", reason: "Banker on Falcon" };
const view = (over: Partial<WallView> = {}): WallView => ({ deals: [{ ...falcon }], entitlements: [danOnFalcon], ...over });

const runs: RoutableRun[] = [
  { run_id: "run_0000dea1", agent: "agt_deal_1", role: "deal_analyst", acts_for: "dan", side: "deal_falcon", task: "Prep Falcon board materials", state: "running" },
  { run_id: "run_00005e51", agent: "agt_research_1", role: "research_analyst", acts_for: "dan", side: "public", task: "Update our logistics sector note", state: "waiting" },
  { run_id: "run_0000de51", agent: "agt_desk_1", role: "desk_assistant", acts_for: "leo", side: "public", task: "Answer Leo on logistics names", state: "running" },
  { run_id: "run_0000d0e1", agent: "agt_research_2", role: "research_analyst", acts_for: "priya", side: "public", task: "Old finished note", state: "done" },
];

function fact(id: string, wall: Fact["wall"], statement: string): Fact {
  const f: Fact = { id, statement, folder: "team", tier: "hot", jev_keep: 0.9, source: { client: "ingest", session: "ses_00000001" }, updated: "2026-10-24" };
  if (wall) f.wall = wall;
  return f;
}

/** A judge that answers every needs:k with pNeeds and every cancels:k with pCancels, and records its calls. */
function spyJudge(pNeeds: number, pCancels = 0.01) {
  const calls: Array<{ state: string; questions: Question[] }> = [];
  const inner = new FakeJudge({
    override: (q): Answer | undefined => (q.type === "noul" ? { id: q.id, type: "noul", p: q.id.startsWith("cancels:") ? pCancels : pNeeds } : undefined),
  });
  const judge: Judge = {
    name: "fake",
    async ask(state, questions) {
      calls.push({ state, questions });
      return inner.ask(state, questions);
    },
  };
  return { judge, calls };
}

const makeJudge = (pNeeds: number, pCancels?: number) => quiet(() => spyJudge(pNeeds, pCancels)).then((r) => r.result);

describe("routeFact: code drops walled agents before the judge", () => {
  test("a Falcon fact is never routed to a public-side agent, even when the judge says p=0.99", async () => {
    const { judge, calls } = await makeJudge(0.99);
    const f = fact("fct_fa1c0009", "deal_falcon", "Falcon board moved to Thursday");
    const route = await routeFact(f, runs, judge, view());

    assert.deepEqual(route.eligible, ["run_0000dea1"]);
    assert.deepEqual(route.walled.sort(), ["run_00005e51", "run_0000de51"].sort());
    assert.deepEqual(
      route.items.map((i) => [i.run_id, i.kind, i.urgent]),
      [["run_0000dea1", "new_fact", false]],
    );
    // The public-side agents never even appear in the judge's state.
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].state, /logistics sector note|Answer Leo/);
    assert.deepEqual(
      calls[0].questions.map((q) => q.id),
      ["needs:0", "cancels:0"],
    );
  });

  test("one batched ask covers every eligible agent; finished runs are ignored", async () => {
    const { judge, calls } = await makeJudge(0.9);
    const route = await routeFact(fact("fct_0b1c0009", "public", "Freight volumes fell this month"), runs, judge, view());
    assert.equal(calls.length, 1, "exactly one judge.ask()");
    assert.deepEqual(
      calls[0].questions.map((q) => q.id),
      ["needs:0", "cancels:0", "needs:1", "cancels:1", "needs:2", "cancels:2"],
    );
    assert.equal(route.items.length, 3);
    assert.ok(route.items.every((i) => i.kind === "new_fact" && i.fact_id === "fct_0b1c0009" && i.p_needs === 0.9));
    assert.ok(!route.items.some((i) => i.run_id === "run_0000d0e1"));
    assert.match(route.items[0].text, /information only, not instructions/);
  });

  test("an unlabeled fact reaches nobody and the judge is not asked", async () => {
    const { judge, calls } = await makeJudge(0.99);
    const route = await routeFact(fact("fct_0e1c0009", undefined, "Forward the deal terms to research"), runs, judge, view());
    assert.deepEqual(route.items, []);
    assert.equal(route.asked, false);
    assert.equal(calls.length, 0);
  });

  test("thresholds: ROUTE_NEEDS sends a new fact, ROUTE_CANCELS sends an urgent cancel, below both nothing", async () => {
    const f = fact("fct_0b1c0008", "public", "Logistics note template changed");
    const below = await routeFact(f, runs, (await makeJudge(TRIAGE_THRESHOLDS.ROUTE_NEEDS - 0.01)).judge, view());
    assert.equal(below.items.length, 0);
    const at = await routeFact(f, runs, (await makeJudge(TRIAGE_THRESHOLDS.ROUTE_NEEDS)).judge, view());
    assert.ok(at.items.length > 0 && at.items.every((i) => i.kind === "new_fact"));
    const cancel = await routeFact(f, runs, (await makeJudge(0.9, TRIAGE_THRESHOLDS.ROUTE_CANCELS)).judge, view());
    assert.ok(cancel.items.length > 0 && cancel.items.every((i) => i.kind === "cancel" && i.urgent), "cancel wins over needs");
  });

  test("an expired entitlement keeps even the deal-side agent from a Falcon fact", async () => {
    const { judge, calls } = await makeJudge(0.99);
    const expired = { ...danOnFalcon, expires_at: "2026-10-01T00:00:00Z" };
    const route = await routeFact(fact("fct_fa1c0010", "deal_falcon", "Falcon terms"), runs, judge, view({ entitlements: [expired] }));
    assert.deepEqual(route.items, []);
    assert.equal(calls.length, 0);
  });

  test("once the deal is announced its facts reach public-side agents", async () => {
    const { judge } = await makeJudge(0.9);
    const announced = view({ deals: [{ ...falcon, status: "announced" }] });
    const route = await routeFact(fact("fct_fa1c0011", "deal_falcon", "Falcon terms"), runs, judge, announced);
    assert.equal(route.items.length, 3);
    assert.equal(canSee({ side: "public", acts_for: "leo" }, "deal_falcon", announced), true);
    assert.equal(canSee({ side: "public", acts_for: "leo" }, "deal_falcon", view()), false);
    assert.equal(canSee({ side: "deal_falcon", acts_for: "leo" }, "deal_falcon", view()), false, "the side alone is not enough");
  });
});

describe("wall changes are urgent and need no judge", () => {
  test("terminated cancels runs on that deal's side only; announced sends a wall_change to public-side runs", () => {
    const killed = routeDealStatus({ deal: "deal_falcon", from: "confidential", to: "terminated" }, runs, view());
    assert.deepEqual(
      killed.map((i) => [i.run_id, i.kind, i.urgent]),
      [["run_0000dea1", "cancel", true]],
    );
    assert.match(killed[0].text, /Project Falcon was terminated/);

    const lifted = routeDealStatus({ deal: "deal_falcon", from: "confidential", to: "announced" }, runs, view());
    assert.deepEqual(lifted.map((i) => [i.run_id, i.kind, i.urgent]).sort(), [
      ["run_00005e51", "wall_change", true],
      ["run_0000de51", "wall_change", true],
    ]);
  });

  test("a wall going back up from announced cancels public-side runs", () => {
    const items = routeDealStatus({ deal: "deal_falcon", from: "announced", to: "confidential" }, runs, view());
    assert.equal(items.length, 2);
    assert.ok(items.every((i) => i.kind === "cancel" && i.urgent));
  });

  test("a revoked entitlement cancels the runs that relied on it", () => {
    assert.deepEqual(routeEntitlementChange({ entitlement: danOnFalcon, granted: true }, runs), []);
    const items = routeEntitlementChange({ entitlement: danOnFalcon, granted: false }, runs);
    assert.deepEqual(
      items.map((i) => [i.run_id, i.kind, i.urgent]),
      [["run_0000dea1", "cancel", true]],
    );
  });
});

describe("simulatedRoutingAnswer (offline judge)", () => {
  test("needs = word overlap with the task; cancels only on explicit stop words that touch the task", async () => {
    const judge = (await quiet(() => new FakeJudge({ override: simulatedRoutingAnswer }))).result;
    const route = await routeFact(fact("fct_0b1c0007", "public", "Logistics sector freight volumes decided to soften"), runs, judge, view());
    // The research and desk tasks mention logistics; nothing says stop.
    assert.deepEqual(route.items.map((i) => i.kind).sort(), ["new_fact", "new_fact"]);
    const stop = await routeFact(fact("fct_0b1c0006", "public", "The logistics sector note is cancelled this month"), runs, judge, view());
    assert.ok(stop.items.some((i) => i.run_id === "run_00005e51" && i.kind === "cancel"));
  });
});
