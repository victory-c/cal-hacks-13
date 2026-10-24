import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Deal, Entitlement } from "@canon/shared";
import { readBody, serve, withEnv } from "../test-helpers.ts";
import { ClaudePlanner, HeuristicPlanner, planDispatch } from "./plan.ts";
import type { Planner, ProposedRun } from "./plan.ts";

const DEMO = "Prep Falcon board materials and update our logistics sector note";
const falcon: Deal = {
  id: "deal_falcon",
  code_name: "Project Falcon",
  aliases: ["Falcon", "Nimbus"],
  companies: ["Nimbus Logistics"],
  status: "confidential",
  status_changed_at: "2026-10-20T09:00:00Z",
};
const dan: Entitlement = { principal: "dan", deal: "deal_falcon", granted_by: "maya", granted_at: "2026-10-20T09:00:00Z", reason: "Banker on Falcon" };

const client = (deals: Deal[], entitlements: Entitlement[]) => ({ getDeals: async () => deals, getEntitlements: async () => entitlements });

/** Records which deals the planner was shown, and proposes `runs`. */
function spyPlanner(runs: ProposedRun[]) {
  const shown: string[][] = [];
  const planner: Planner = {
    name: "heuristic",
    simulated: true,
    async propose(_task, deals) {
      shown.push(deals.map((d) => d.id));
      return { runs };
    },
  };
  return { planner, shown };
}

describe("planDispatch: code decides every side", () => {
  test("the demo task, by Dan (cleared for Falcon): deal_analyst on deal_falcon + research_analyst on public", async () => {
    const plan = await planDispatch({ by: "dan", task: DEMO }, { client: client([falcon], [dan]), planner: new HeuristicPlanner() });
    assert.deepEqual(
      plan.runs.map((r) => [r.role, r.side, r.task]),
      [
        ["deal_analyst", "deal_falcon", "Prep Falcon board materials"],
        ["research_analyst", "public", "Update our logistics sector note"],
      ],
    );
    assert.equal(plan.simulated, true);
  });

  test("the same task by Priya (no entitlement): both runs public, and the planner never sees the deal", async () => {
    const { planner, shown } = spyPlanner([
      { role: "deal_analyst", deal: "deal_falcon", task: "Prep Falcon board materials" },
      { role: "research_analyst", deal: null, task: "Update our logistics sector note" },
    ]);
    const plan = await planDispatch({ by: "priya", task: DEMO }, { client: client([falcon], [dan]), planner });
    assert.deepEqual(shown, [[]]);
    assert.deepEqual(
      plan.runs.map((r) => [r.role, r.side]),
      [
        ["deal_analyst", "public"],
        ["research_analyst", "public"],
      ],
    );
    assert.match(plan.runs[0].side_reason, /no live entitlement/);
  });

  test("an expired entitlement, a terminated deal or a public-side role all mean public", async () => {
    const deal = { role: "deal_analyst" as const, deal: "deal_falcon", task: "Prep Falcon board materials" };
    const expired = { ...dan, expires_at: "2026-10-01T00:00:00Z" };
    const a = await planDispatch({ by: "dan", task: DEMO }, { client: client([falcon], [expired]), planner: spyPlanner([deal]).planner });
    assert.equal(a.runs[0].side, "public");
    const b = await planDispatch({ by: "dan", task: DEMO }, { client: client([{ ...falcon, status: "terminated" }], [dan]), planner: spyPlanner([deal]).planner });
    assert.equal(b.runs[0].side, "public");
    assert.match(b.runs[0].side_reason, /terminated/);
    const c = await planDispatch(
      { by: "dan", task: DEMO },
      { client: client([falcon], [dan]), planner: spyPlanner([{ role: "research_analyst", deal: "deal_falcon", task: "Note on Falcon" }]).planner },
    );
    assert.deepEqual([c.runs[0].role, c.runs[0].side], ["research_analyst", "public"]);
    const d = await planDispatch({ by: "dan", task: DEMO }, { client: client([falcon], [dan]), planner: spyPlanner([{ ...deal, deal: "deal_osprey" }]).planner });
    assert.equal(d.runs[0].side, "public", "a deal nobody granted is never a side");
  });

  test("sides come from the walls AFTER planning: a termination or a revoked grant while the planner thinks means public", async () => {
    const deal = { role: "deal_analyst" as const, deal: "deal_falcon", task: "Prep Falcon board materials" };
    for (const change of ["terminated", "revoked"] as const) {
      let deals: Deal[] = [falcon];
      let entitlements: Entitlement[] = [dan];
      const planner: Planner = {
        name: "heuristic",
        simulated: true,
        async propose() {
          // Compliance acts while the planner is still thinking.
          if (change === "terminated") deals = [{ ...falcon, status: "terminated" }];
          else entitlements = [];
          return { runs: [deal] };
        },
      };
      const live = { getDeals: async () => deals, getEntitlements: async () => entitlements };
      const plan = await planDispatch({ by: "dan", task: DEMO }, { client: live, planner });
      assert.equal(plan.runs[0].side, "public", `${change} during planning`);
    }
  });

  test("a walls read that a wall change overtook is read again before sides are decided", async () => {
    let epoch = 0;
    let reads = 0;
    // The second read (after the planner) is served before the termination, which is heard while it is in flight.
    const racy = {
      getDeals: async (): Promise<Deal[]> => {
        reads++;
        if (reads === 2) {
          epoch++;
          return [falcon];
        }
        return reads === 1 ? [falcon] : [{ ...falcon, status: "terminated" }];
      },
      getEntitlements: async () => [dan],
    };
    const plan = await planDispatch(
      { by: "dan", task: DEMO },
      { client: racy, planner: spyPlanner([{ role: "deal_analyst", deal: "deal_falcon", task: "Prep Falcon board materials" }]).planner, wallEpoch: () => epoch },
    );
    assert.equal(reads, 3, "the overtaken read was read again");
    assert.equal(plan.runs[0].side, "public");
    assert.match(plan.runs[0].side_reason, /terminated/);

    // A view that never settles plans nothing.
    const moving = { getDeals: async () => (epoch++, [falcon]), getEntitlements: async () => [dan] };
    await assert.rejects(planDispatch({ by: "dan", task: DEMO }, { client: moving, planner: new HeuristicPlanner(), wallEpoch: () => epoch }), /walls changed/);
  });

  test("no deals or entitlements on the server (v1): every run is public", async () => {
    const plan = await planDispatch({ by: "dan", task: DEMO }, { client: client([], []), planner: new HeuristicPlanner() });
    assert.ok(plan.runs.every((r) => r.side === "public"));
  });
});

describe("HeuristicPlanner (simulated)", () => {
  test("splits on 'and <verb>', merges same-role clauses, spots the desk", async () => {
    const h = new HeuristicPlanner();
    const memo = await h.propose("Draft a short Falcon deal memo and run a simple valuation", [falcon]);
    assert.equal(memo.runs.length, 2, "two clauses: the second names no deal");
    const merged = await h.propose("Draft the Falcon deal memo and run the Falcon valuation", [falcon]);
    assert.deepEqual(merged.runs, [{ role: "deal_analyst", deal: "deal_falcon", task: "Draft the Falcon deal memo; run the Falcon valuation" }]);
    const desk = await h.propose("Anything going on with Nimbus Logistics? Should we add to our position?", []);
    assert.deepEqual(desk.runs.map((r) => r.role), ["desk_assistant"]);
  });
});

describe("ClaudePlanner", () => {
  test("one strict plan_runs call, auto tool_choice, deal ids limited to what the requester may see", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const srv = await serve(async (req, res) => {
      bodies.push(JSON.parse(await readBody(req)));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          content: [
            { type: "thinking", thinking: "", signature: "s" },
            {
              type: "tool_use",
              id: "tu_1",
              name: "plan_runs",
              input: {
                runs: [
                  { role: "deal_analyst", deal: "deal_falcon", task: "Prep Falcon board materials" },
                  { role: "research_analyst", deal: null, task: "Update the logistics sector note" },
                  { role: "made_up_role", deal: null, task: "dropped" },
                ],
              },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 321, output_tokens: 45 },
        }),
      );
    });
    try {
      const plan = await withEnv({ ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: srv.url }, () =>
        planDispatch({ by: "dan", task: DEMO }, { client: client([falcon, { ...falcon, id: "deal_osprey", code_name: "Project Osprey" }], [dan]), planner: new ClaudePlanner() }),
      );
      assert.deepEqual(
        plan.runs.map((r) => [r.role, r.side]),
        [
          ["deal_analyst", "deal_falcon"],
          ["research_analyst", "public"],
        ],
      );
      assert.deepEqual(plan.tokens, { input: 321, output: 45 });
      assert.equal(plan.simulated, false);
      const body = bodies[0];
      assert.equal(body.model, "claude-sonnet-5-5");
      assert.deepEqual(body.tool_choice, { type: "auto" });
      const tool = (body.tools as Array<{ strict: boolean; input_schema: { properties: { runs: { items: { properties: { deal: { anyOf: Array<{ enum?: string[] }> } } } } } } }>)[0];
      assert.equal(tool.strict, true);
      assert.deepEqual(tool.input_schema.properties.runs.items.properties.deal.anyOf[0].enum, ["deal_falcon"], "Osprey is not Dan's to see");
      assert.doesNotMatch(JSON.stringify(body.messages), /Osprey/);
    } finally {
      await srv.close();
    }
  });
});
