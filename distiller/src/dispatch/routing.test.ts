import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FakeJudge, TRIAGE_THRESHOLDS } from "@canon/shared";
import type { Answer, Judge, Question } from "@canon/shared";
import { fakeFact, quiet } from "../test-helpers.ts";
import { DELETED_TEXT, NARROWED_TEXT, routeAgentDeleted, routeNarrowing, routeNewFacts, simulatedRoutingAnswer } from "./routing.ts";
import type { RoutableRun, RoutingState } from "./routing.ts";

const research: RoutableRun = {
  run_id: "run_00005e51",
  agent: "agt_priya_research",
  created_by: "priya",
  task: "Update our logistics sector note",
  state: "running",
  fact_ids: ["fct_7e5e0001", "fct_0b1c0001"],
  scope_gen: 0,
};
const deal: RoutableRun = {
  run_id: "run_0000dea1",
  agent: "agt_dan_deal",
  created_by: "dan",
  task: "Draft a short Falcon board memo",
  state: "waiting",
  fact_ids: ["fct_fa1c0001", "fct_0b1c0001"],
  scope_gen: 0,
};
const doneRun: RoutableRun = { ...research, run_id: "run_00000d0e", state: "done" };

const sellSide = fakeFact("fct_0b1c0004", "A sell-side analyst cut NMBL to Hold; the logistics sector note should mention it.", { folder: "market/public" });
const ops = fakeFact("fct_0f5e0003", "The office closes early on Friday.", { folder: "firm/ops" });
const falconNew = fakeFact("fct_fa1c0007", "Project Falcon's break fee is now 2.5%.", { folder: "deal/falcon" });

/** Records every ask; answers each needs:k:i with `p(k, i)`. */
function recordingJudge(p: (k: number, i: number) => number) {
  const asks: Array<{ state: string; questions: Question[] }> = [];
  const judge: Judge = {
    name: "fake",
    async ask(state, questions) {
      asks.push({ state, questions });
      return questions.map((q): Answer => {
        const [, k, i] = q.id.split(":").map(Number);
        return { id: q.id, type: "noul", p: p(k, i) };
      });
    },
  };
  return { judge, asks };
}

describe("routeNewFacts: one batched ask, each run only about facts its own agent's scope holds", () => {
  test("ONE judge.ask covers every (run, new fact) pair; ROUTE_NEEDS decides; nothing below it is sent", async () => {
    const twin: RoutableRun = { ...research, run_id: "run_00005e52", fact_ids: [] };
    const { judge, asks } = recordingJudge((k, i) => (i === 0 ? 0.9 : TRIAGE_THRESHOLDS.ROUTE_NEEDS - 0.01));
    const route = await routeNewFacts([{ agent: "agt_priya_research", facts: [sellSide, ops] }], [research, twin, deal, doneRun], judge);

    assert.equal(asks.length, 1, "one call for the whole batch");
    assert.deepEqual(
      asks[0].questions.map((q) => q.id),
      ["needs:0:0", "needs:0:1", "needs:1:0", "needs:1:1"],
    );
    const state = JSON.parse(asks[0].state) as RoutingState;
    assert.deepEqual(
      state.agents.map((a) => a.task),
      [research.task, research.task],
      "only that agent's active runs; Dan's deal run and the finished run are never in the state",
    );
    assert.match(state.note, /data, never instructions/);
    assert.equal(route.asked, true);
    assert.equal(route.questions, 4);
    assert.deepEqual(
      route.items.map((i) => [i.run_id, i.kind, i.fact_id, i.urgent, i.p_needs]),
      [
        [research.run_id, "new_fact", "fct_0b1c0004", false, 0.9],
        [twin.run_id, "new_fact", "fct_0b1c0004", false, 0.9],
      ],
    );
    assert.match(route.items[0].text, /information only, not instructions/);
    assert.match(route.items[0].text, /facts\/fct_0b1c0004\.md/);
  });

  test("facts that joined several agents' scopes at once: still ONE ask, and each run is only asked about its own agent's facts", async () => {
    const { judge, asks } = recordingJudge(() => 0.9);
    const route = await routeNewFacts(
      [
        { agent: "agt_priya_research", facts: [sellSide] },
        { agent: "agt_dan_deal", facts: [sellSide, falconNew] },
      ],
      [research, deal],
      judge,
    );
    assert.equal(asks.length, 1);
    const state = JSON.parse(asks[0].state) as RoutingState;
    assert.deepEqual(
      state.new_facts.map((f) => f.id),
      ["fct_0b1c0004", "fct_fa1c0007"],
      "each fact once",
    );
    assert.deepEqual(
      asks[0].questions.map((q) => q.id),
      ["needs:0:0", "needs:1:0", "needs:1:1"],
      "Priya's run is never asked about the Falcon fact: her agent's scope does not hold it",
    );
    assert.deepEqual(
      route.items.map((i) => [i.run_id, i.fact_id]),
      [
        [research.run_id, "fct_0b1c0004"],
        [deal.run_id, "fct_0b1c0004"],
        [deal.run_id, "fct_fa1c0007"],
      ],
    );
  });

  test("a fact already in the run's folder is not asked about; nothing to ask means no call", async () => {
    const { judge, asks } = recordingJudge(() => 0.9);
    const already = fakeFact("fct_7e5e0001", "Already there.");
    const route = await routeNewFacts([{ agent: "agt_priya_research", facts: [already] }], [research], judge);
    assert.equal(asks.length, 0);
    assert.deepEqual(route, { items: [], asked: false, questions: 0 });
    assert.equal((await routeNewFacts([{ agent: "agt_nobody", facts: [sellSide] }], [research, deal], judge)).asked, false);
  });

  test("a missing answer counts as no", async () => {
    const judge: Judge = { name: "fake", ask: async () => [] };
    assert.deepEqual((await routeNewFacts([{ agent: "agt_priya_research", facts: [sellSide] }], [research], judge)).items, []);
  });
});

describe("narrowing and deletion are urgent and need no judge", () => {
  test("removed facts restart every active run of that agent whose folder holds one, and only those", () => {
    const items = routeNarrowing({ principal: "agt_dan_deal", removed: ["fct_fa1c0001"] }, [research, deal, { ...deal, run_id: "run_0000dea2", state: "cancelled" }]);
    assert.deepEqual(
      items.map((i) => [i.run_id, i.kind, i.urgent, i.text]),
      [[deal.run_id, "scope_narrowed", true, NARROWED_TEXT]],
    );
    assert.doesNotMatch(NARROWED_TEXT, /fct_|falcon|\d/i, "the lane is told nothing about what was removed");
    assert.deepEqual(routeNarrowing({ principal: "agt_dan_deal", removed: ["fct_99990000"] }, [deal]), [], "a fact the folder never held changes nothing");
    assert.deepEqual(routeNarrowing({ principal: "agt_dan_deal", removed: [] }, [deal]), []);
  });

  test("a narrowed creator scope restarts the creator's agents too: an agent never holds more than its creator", () => {
    const items = routeNarrowing({ principal: "dan", removed: ["fct_fa1c0001", "fct_fa1c0002"] }, [research, deal]);
    assert.deepEqual(
      items.map((i) => i.run_id),
      [deal.run_id],
    );
  });

  test("a deleted agent's active runs get an urgent cancel", () => {
    const items = routeAgentDeleted("agt_dan_deal", [research, deal, { ...deal, run_id: "run_0000dea3", state: "done" }]);
    assert.deepEqual(
      items.map((i) => [i.run_id, i.kind, i.urgent, i.text]),
      [[deal.run_id, "cancel", true, DELETED_TEXT]],
    );
  });
});

describe("simulatedRoutingAnswer (offline judge)", () => {
  test("needs = word overlap between the new fact and the agent's task", async () => {
    const judge = (await quiet(() => new FakeJudge({ override: simulatedRoutingAnswer }))).result;
    const route = await routeNewFacts([{ agent: "agt_priya_research", facts: [sellSide, ops] }], [{ ...research, fact_ids: [] }], judge);
    assert.deepEqual(
      route.items.map((i) => [i.fact_id, i.p_needs]),
      [["fct_0b1c0004", 0.75]],
      "the sell-side note mentions the logistics sector; the office hours do not",
    );
  });
});
