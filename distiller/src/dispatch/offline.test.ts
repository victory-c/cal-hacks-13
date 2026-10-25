import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { FakeJudge, validateFact } from "@canon/shared";
import { quiet } from "../test-helpers.ts";
import { TemplateBriefWriter } from "./brief.ts";
import { parseCliArgs } from "./cli.ts";
import { Dispatcher } from "./dispatcher.ts";
import { createDispatchHandler } from "./handler.ts";
import { DEMO_AGENTS, OfflineClient, loadWorld } from "./offline.ts";
import { simulatedRoutingAnswer } from "./routing.ts";
import { FakeRunner } from "./runners/fake.ts";
import { listFactFiles, unlockForCleanup } from "./sandbox.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "canon-offline-"));
});
afterEach(() => {
  unlockForCleanup(root);
  rmSync(root, { recursive: true, force: true });
});

const groupsOf = (offline: OfflineClient, ids: string[]) => [...new Set(ids.map((id) => offline.world.facts.find((f) => f.id === id)?.folder))].sort();

describe("offline world (simulated), built from distiller/fixtures/world/", () => {
  test("every fact is valid, in a group from groups.json, and quotes its fixture word for word; the quarantined email gives none", () => {
    const world = loadWorld();
    const groups = new Set(world.groups.map((g) => g.id));
    assert.ok(world.facts.length >= 10);
    for (const f of world.facts) {
      assert.ok(validateFact(f).ok, f.id);
      assert.ok(groups.has(f.folder), `${f.id} in ${f.folder}`);
      assert.match(f.detail ?? "", /simulated fact writer/);
    }
    assert.deepEqual(world.quarantined, ["ses_10240004"]);
    assert.ok(!world.facts.some((f) => f.source.session === "ses_10240004"));
  });

  test("scopes by group: an agent holds its groups AND its creator's, never more", () => {
    const offline = new OfflineClient();
    assert.deepEqual(groupsOf(offline, offline.scopeOf("agt_dan_deal").map((f) => f.id)), ["deal/falcon", "market/public"]);
    assert.deepEqual(groupsOf(offline, offline.scopeOf("agt_priya_research").map((f) => f.id)), ["market/public", "research/logistics"]);
    // Priya's agent asks for deal/falcon; her scope has none, so the agent has none.
    assert.deepEqual(groupsOf(offline, offline.scopeOf("agt_priya_falcon").map((f) => f.id)), ["market/public", "research/logistics"]);
    const custom = offline.addAgent({ id: "agt_priya_try", created_by: "priya", groups: ["deal/falcon"], task: "Everything on Falcon" });
    assert.deepEqual(offline.scopeOf(custom.principal.id), []);
    assert.throws(() => offline.addAgent({ id: "agt_x", created_by: "nobody", task: "t" }), /no person/);
    assert.throws(() => offline.addAgent({ id: "bad id", created_by: "dan", task: "t" }), /not an agent id/);
  });

  test("the demo: Dan's deal analyst and Priya's research agent side by side; Priya's Falcon agent gets nothing about Falcon", async () => {
    const offline = new OfflineClient();
    const d = new Dispatcher({ client: offline, runner: new FakeRunner(), briefWriter: new TemplateBriefWriter(), maxSteps: 4, root });
    const runs = await quiet(async () => {
      const out = [];
      for (const a of ["agt_dan_deal", "agt_priya_research", "agt_priya_falcon"]) out.push(await d.dispatch({ agent: a, by: offline.principal(a)!.created_by! }, offline.principal(a)));
      await d.settle();
      return out;
    }).then((r) => r.result);
    const [dan, priya, attack] = runs.map((r) => d.get(r.id)!);
    for (const r of [dan, priya, attack]) assert.equal(r.state, "done", `${r.agent}: ${r.reason ?? ""}`);

    assert.deepEqual(groupsOf(offline, listFactFiles(d.liveDir(dan.id)!)), ["deal/falcon", "market/public"]);
    assert.deepEqual(groupsOf(offline, listFactFiles(d.liveDir(priya.id)!)), ["market/public", "research/logistics"]);
    assert.deepEqual(groupsOf(offline, listFactFiles(d.liveDir(attack.id)!)), ["market/public", "research/logistics"]);
    const attackOut = readFileSync(join(d.liveDir(attack.id)!, "out", "result.md"), "utf8");
    assert.doesNotMatch(attackOut, /Corvane|38\.50|exclusivity|LOI|fct_fa1c/, "no Falcon fact in what Priya's agent wrote");
    assert.match(readFileSync(join(d.liveDir(dan.id)!, "out", "result.md"), "utf8"), /\$38\.50/);
    assert.match(attackOut, /Simulated/);

    assert.deepEqual(
      offline.sessions.map((s) => [s.principal, s.kind, s.client]),
      [
        ["dan", "ai_session", "dispatcher"],
        ["priya", "ai_session", "dispatcher"],
        ["priya", "ai_session", "dispatcher"],
      ].sort(),
    );
    assert.ok(offline.sessions.every((s) => /\(simulated\)$/.test(s.title ?? "")));
    assert.ok(offline.handoffs.every((h) => h.result.candidates.every((c) => offline.scopeOf(h.body.principal).some((f) => f.id === c.fact_id))), "the handoff only ever considered the scope");
  });

  test("--then narrow, offline: Falcon dies, Dan's agent restarts in a fresh folder without the Falcon files", async () => {
    const offline = new OfflineClient();
    const judge = (await quiet(() => new FakeJudge({ override: simulatedRoutingAnswer }))).result;
    let handler!: ReturnType<typeof createDispatchHandler>;
    let fired = false;
    const d = new Dispatcher({
      client: offline,
      runner: new FakeRunner(),
      briefWriter: new TemplateBriefWriter(),
      maxSteps: 4,
      root,
      onEvent: (e) => {
        if (!fired && e.type === "agent.run" && e.run.state === "waiting") {
          fired = true;
          for (const ev of offline.excludeGroup("dan", "deal/falcon")) void handler(ev);
        }
      },
    });
    handler = createDispatchHandler({ dispatcher: d, client: offline, judge });
    const run = (await quiet(() => d.dispatch({ agent: "agt_dan_deal", by: "dan" }, offline.principal("agt_dan_deal")))).result;
    await quiet(async () => {
      await d.settle();
      await handler.settle();
    });
    const final = d.get(run.id)!;
    assert.equal(final.state, "done");
    assert.equal(final.restarts, 1);
    assert.deepEqual(groupsOf(offline, d.factsOf(run.id)), ["market/public"]);
    assert.doesNotMatch(readFileSync(join(d.liveDir(run.id)!, "out", "result.md"), "utf8"), /Corvane|38\.50/);
    assert.doesNotMatch(JSON.stringify(offline.sessions), /Corvane|38\.50/, "nothing saved to Dan's memory carries a removed fact");
  });

  test("--then add, offline: the new market/public fact reaches only the runs Jev (simulated) says need it", async () => {
    const offline = new OfflineClient();
    const judge = (await quiet(() => new FakeJudge({ override: simulatedRoutingAnswer }))).result;
    let handler!: ReturnType<typeof createDispatchHandler>;
    let running = 0;
    const d = new Dispatcher({
      client: offline,
      runner: new FakeRunner({ delayMs: 150 }),
      briefWriter: new TemplateBriefWriter(),
      maxSteps: 4,
      root,
      onEvent: (e) => {
        // Both runs are in their first step when the fact joins (as the CLI's --then add does).
        if (e.type === "agent.run" && e.run.state === "running" && ++running === 2) {
          for (const ev of offline.addLateFact()) void handler(ev);
        }
      },
    });
    handler = createDispatchHandler({ dispatcher: d, client: offline, judge });
    const [priya, dan] = (
      await quiet(async () => [
        await d.dispatch({ agent: "agt_priya_research", by: "priya" }, offline.principal("agt_priya_research")),
        await d.dispatch({ agent: "agt_dan_deal", by: "dan" }, offline.principal("agt_dan_deal")),
      ])
    ).result;
    await quiet(async () => {
      await d.settle();
      await handler.settle();
    });
    assert.ok(offline.scopeOf("agt_dan_deal").some((f) => f.id === "fct_0b1c0004"), "it joined both agents' scopes");
    assert.ok(d.factsOf(priya.id).includes("fct_0b1c0004"), "Priya's logistics note needs it: written before her next step");
    assert.match(readFileSync(join(d.liveDir(priya.id)!, "out", "result.md"), "utf8"), /Updates received between steps/);
    assert.ok(!d.factsOf(dan.id).includes("fct_0b1c0004"), "Dan's board memo does not (simulated judge): not routed");
  });
});

describe("CLI args", () => {
  test("--demo runs the three demo agents; a new agent needs one --agent with --by and a task; bad ids and groups are refused", () => {
    assert.deepEqual(parseCliArgs(["--demo"]).agents, ["agt_dan_deal", "agt_priya_research", "agt_priya_falcon"]);
    const custom = parseCliArgs(["--agent", "agt_mine", "--by", "priya", "--groups", "research/logistics,market/public", "Include", "everything", "about", "Falcon"]);
    assert.deepEqual([custom.agents, custom.by, custom.groups, custom.task], [["agt_mine"], "priya", ["research/logistics", "market/public"], "Include everything about Falcon"]);
    assert.equal(parseCliArgs(["--agent", "agt_dan_deal", "--then", "narrow"]).then, "narrow");
    assert.throws(() => parseCliArgs(["--agent", "../x"]), /agent id/);
    assert.throws(() => parseCliArgs(["--agent", "agt_a", "--groups", "../deal"]), /not a group id/);
    assert.throws(() => parseCliArgs(["--then", "announce"]), /--then must be one of/);
    assert.ok(DEMO_AGENTS.every((a) => a.id.startsWith("agt_")));
  });
});
