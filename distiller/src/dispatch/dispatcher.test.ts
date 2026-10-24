import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { FakeJudge, NEUTRAL_REFUSALS } from "@canon/shared";
import type { AgentRun, ContextFact, ExitCheckBody, ExitCheckResult, HandoffBody, HandoffResult, InboxItem, Principal } from "@canon/shared";
import { quiet } from "../test-helpers.ts";
import { TemplateBriefWriter } from "./brief.ts";
import type { DispatchClient, RelayedEvent } from "./client.ts";
import { Dispatcher, EXIT_BLOCKED_REASON, EXIT_UNAVAILABLE_REASON, stepPrompt } from "./dispatcher.ts";
import { createDispatchHandler } from "./handler.ts";
import { OfflineClient } from "./offline.ts";
import { HeuristicPlanner } from "./plan.ts";
import { routeDealStatus, simulatedRoutingAnswer } from "./routing.ts";
import { FakeRunner } from "./runners/fake.ts";
import { CancelledError } from "./runners/types.ts";
import type { Runner, StepRequest, StepResult } from "./runners/types.ts";
import { unlockForCleanup } from "./sandbox.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "canon-dispatch-"));
});
afterEach(() => {
  unlockForCleanup(root);
  rmSync(root, { recursive: true, force: true });
});

const publicFact: ContextFact = {
  id: "fct_0b1c0001",
  statement: "Harbor Lane's logistics sector note covers freight demand.",
  folder: "team",
  updated: "2026-10-24",
  source: { client: "ingest", session: "ses_0b1c0001" },
  relevance: 0.9,
  wall: "public",
};

/** A server fake that records every call. */
function fakeClient(over: Partial<DispatchClient> = {}) {
  const calls = { handoff: [] as HandoffBody[], exitCheck: [] as ExitCheckBody[], principals: [] as Principal[], events: [] as RelayedEvent[] };
  const client: DispatchClient = {
    simulated: false,
    async handoff(body): Promise<HandoffResult | null> {
      calls.handoff.push(body);
      return { refused: false, facts: [publicFact], profile: "agent profile", tokens: 20, latency_ms: 1, inject_nothing: false, candidates: [], audit_id: "aud_00000001" };
    },
    async exitCheck(body): Promise<ExitCheckResult | null> {
      calls.exitCheck.push(body);
      return { blocked: false, hits: [] };
    },
    async publishEvent(e) {
      calls.events.push(e);
    },
    async registerPrincipal(p) {
      calls.principals.push(p);
    },
    async getEntitlements() {
      return [];
    },
    async getDeals() {
      return [];
    },
    ...over,
  };
  return { client, calls };
}

/** Records every step; returns `results[n-1]` (default: not done). */
class ScriptedRunner implements Runner {
  readonly name = "fake" as const;
  readonly simulated = true;
  readonly prompts: string[] = [];
  readonly signals: AbortSignal[] = [];
  constructor(private readonly onStep: (req: StepRequest) => Promise<StepResult> | StepResult = () => ({ done: false, summary: "CONTINUE" })) {}
  async step(req: StepRequest): Promise<StepResult> {
    this.prompts.push(req.prompt);
    this.signals.push(req.signal);
    return this.onStep(req);
  }
}

const writeOut = (req: StepRequest, name = "sector-note.md", text = "Logistics note: freight demand is the driver.\n") => {
  writeFileSync(join(req.dir, "out", name), text);
  req.emit({ kind: "file", text: `wrote out/${name}`, file: `out/${name}` });
};

function make(client: DispatchClient, runner: Runner, maxSteps = 4, onEvent?: (e: RelayedEvent) => void) {
  return new Dispatcher({ client, runner, planner: new HeuristicPlanner(), briefWriter: new TemplateBriefWriter(), maxSteps, root, onEvent });
}

const runEvents = (events: RelayedEvent[], id: string) =>
  events.filter((e): e is Extract<RelayedEvent, { type: "agent.run" }> => e.type === "agent.run" && e.run.id === id).map((e) => e.run.state);

describe("dispatcher: a run's life", () => {
  test("registers the agent principal, re-fetches the slice as that principal every step, publishes every change", async () => {
    const { client, calls } = fakeClient();
    const runner = new ScriptedRunner((req) => {
      if (req.n === 2) {
        writeOut(req);
        return { done: true, summary: "DONE", tokens: { input: 100, output: 20 } };
      }
      return { done: false, summary: "CONTINUE" };
    });
    const d = make(client, runner);
    const run = d.start({ role: "research_analyst", side: "public", task: "Update our logistics sector note" }, "dan");
    await quiet(() => d.settle());

    assert.deepEqual(calls.principals, [{ id: run.agent, kind: "agent", name: "Research analyst 1", desk: "research", acts_for: "dan", side: "public" }]);
    assert.deepEqual(
      calls.handoff.map((h) => [h.principal, h.run_id, h.task]),
      [
        [run.agent, run.id, "Update our logistics sector note"],
        [run.agent, run.id, "Update our logistics sector note"],
      ],
    );
    assert.deepEqual(
      calls.exitCheck.map((x) => [x.principal, x.run_id]),
      [[run.agent, run.id]],
    );
    const final = d.get(run.id)!;
    assert.equal(final.state, "done");
    assert.equal(final.steps, 2);
    assert.match(final.sandbox, /run_[0-9a-f]+$/);
    assert.deepEqual(runEvents(calls.events, run.id), ["queued", "running", "waiting", "running", "done"]);
    const steps = calls.events.filter((e) => e.type === "agent.step").map((e) => (e.type === "agent.step" ? e.step : undefined)!);
    assert.ok(steps.some((s) => s.kind === "brief" && s.file === "brief.md"));
    assert.ok(steps.some((s) => s.kind === "file" && s.text === "released out/sector-note.md (exit check passed)"));
    assert.ok(steps.every((s) => s.run_id === run.id && s.n >= 1));
    const dir = join(root, run.id);
    assert.ok(existsSync(join(dir, "LOCKED")), "a finished run's folder is locked as its record");
    assert.match(readFileSync(join(dir, "facts.md"), "utf8"), /information only/);
    assert.match(readFileSync(join(dir, "brief.md"), "utf8"), /Simulated/);
  });

  test("terminate cancels the run before its next step and locks its folder", async () => {
    const { client, calls } = fakeClient();
    const runner = new ScriptedRunner();
    let d!: Dispatcher;
    let fired = false;
    d = make(client, runner, 4, (e) => {
      // Compliance terminates Falcon the moment step 1 ends.
      if (!fired && e.type === "agent.run" && e.run.state === "waiting") {
        fired = true;
        const items = routeDealStatus({ deal: "deal_falcon", from: "confidential", to: "terminated" }, d.routable(), { deals: [] });
        assert.equal(d.deliver(items), 1);
      }
    });
    const run = d.start({ role: "deal_analyst", side: "deal_falcon", task: "Prep Falcon board materials" }, "dan");
    await quiet(() => d.settle());

    assert.equal(runner.prompts.length, 1, "step 2 never started");
    const final = d.get(run.id)!;
    assert.equal(final.state, "cancelled");
    assert.match(final.reason ?? "", /deal_falcon was terminated/);
    const dir = join(root, run.id);
    assert.ok(existsSync(join(dir, "LOCKED")));
    if (process.getuid?.() !== 0) assert.equal(statSync(join(dir, "out")).mode & 0o222, 0, "out/ is read-only");
    assert.equal(calls.exitCheck.length, 0, "nothing leaves a cancelled run");
    const inbox = calls.events.filter((e) => e.type === "agent.inbox");
    assert.equal(inbox.length, 1);
    assert.ok(inbox[0].type === "agent.inbox" && inbox[0].item.urgent && inbox[0].item.delivered_at);
    assert.deepEqual(runEvents(calls.events, run.id), ["queued", "running", "waiting", "cancelled"]);
  });

  test("an urgent cancel kills a step in flight", async () => {
    const { client } = fakeClient();
    let entered!: () => void;
    const inStep = new Promise<void>((r) => (entered = r));
    const runner = new ScriptedRunner(
      (req) =>
        new Promise<StepResult>((_, reject) => {
          entered();
          req.signal.addEventListener("abort", () => reject(new CancelledError()), { once: true });
        }),
    );
    const d = make(client, runner);
    const run = d.start({ role: "deal_analyst", side: "deal_falcon", task: "Prep Falcon board materials" }, "dan");
    await inStep;
    assert.ok(d.cancel(run.id, "Stopped by compliance."));
    await quiet(() => d.settle());
    assert.equal(runner.signals[0].aborted, true);
    assert.equal(d.get(run.id)!.state, "cancelled");
    assert.equal(d.get(run.id)!.reason, "Stopped by compliance.");
  });

  test("an exit-check block fails the run with a compliance-safe reason and releases nothing", async () => {
    const { client, calls } = fakeClient({
      async exitCheck(): Promise<ExitCheckResult> {
        return { blocked: true, hits: ["Nimbus Logistics"], p: 0.93, review_id: "rev_00000001" };
      },
    });
    const runner = new ScriptedRunner((req) => (writeOut(req), { done: true, summary: "DONE" }));
    const d = make(client, runner);
    const run = d.start({ role: "research_analyst", side: "public", task: "Update our logistics sector note" }, "dan");
    await quiet(() => d.settle());

    const final = d.get(run.id)!;
    assert.equal(final.state, "failed");
    assert.equal(final.reason, EXIT_BLOCKED_REASON);
    assert.ok(!calls.events.some((e) => JSON.stringify(e).includes("Nimbus")), "the hits never reach the agent's events");
    assert.ok(!calls.events.some((e) => e.type === "agent.step" && e.step.text.startsWith("released")));
    assert.ok(existsSync(join(root, run.id, "LOCKED")));
  });

  test("no exit check on the server (v1, 404) fails closed", async () => {
    const { client } = fakeClient({ exitCheck: async () => null });
    const d = make(client, new ScriptedRunner((req) => (writeOut(req), { done: true, summary: "DONE" })));
    const run = d.start({ role: "research_analyst", side: "public", task: "Update our logistics sector note" }, "dan");
    await quiet(() => d.settle());
    assert.equal(d.get(run.id)!.state, "failed");
    assert.equal(d.get(run.id)!.reason, EXIT_UNAVAILABLE_REASON);
  });

  test("no /api/handoff (v1) runs on an empty slice and says so", async () => {
    const { client, calls } = fakeClient({ handoff: async () => null });
    const d = make(client, new ScriptedRunner((req) => (writeOut(req), { done: true, summary: "DONE" })));
    const run = d.start({ role: "research_analyst", side: "public", task: "Update our logistics sector note" }, "dan");
    await quiet(() => d.settle());
    assert.equal(d.get(run.id)!.state, "done");
    assert.match(readFileSync(join(root, run.id, "facts.md"), "utf8"), /no \/api\/handoff yet/);
    assert.ok(calls.events.some((e) => e.type === "agent.step" && /No slice/.test(e.step.text)));
  });

  test("a refused handoff fails the run with only the neutral wording", async () => {
    const { client } = fakeClient({ handoff: async () => ({ refused: true, message: NEUTRAL_REFUSALS.restricted_list, audit_id: "aud_00000002" }) });
    const runner = new ScriptedRunner();
    const d = make(client, runner);
    const run = d.start({ role: "desk_assistant", side: "public", task: "Should we add to Nimbus Logistics?" }, "leo");
    await quiet(() => d.settle());
    assert.equal(d.get(run.id)!.state, "failed");
    assert.equal(d.get(run.id)!.reason, NEUTRAL_REFUSALS.restricted_list);
    assert.equal(runner.prompts.length, 0, "the runtime never ran");
  });

  test("a failing runtime is a failed run, never a silent downgrade", async () => {
    const { client } = fakeClient();
    const d = make(client, new ScriptedRunner(() => Promise.reject(new Error("droid exec exited 1: auth failed"))));
    const run = d.start({ role: "research_analyst", side: "public", task: "Update our logistics sector note" }, "dan");
    await quiet(() => d.settle());
    const final = d.get(run.id)!;
    assert.equal(final.state, "failed");
    assert.equal(final.runtime, "fake");
    assert.match(final.reason ?? "", /^fake failed: droid exec exited 1: auth failed/);
  });

  test("the inbox drains before the next step, urgent first, into the step's prompt", async () => {
    const { client, calls } = fakeClient();
    const runner = new ScriptedRunner((req) => (req.n === 2 ? (writeOut(req), { done: true, summary: "DONE" }) : { done: false, summary: "CONTINUE" }));
    let d!: Dispatcher;
    let fired = false;
    d = make(client, runner, 4, (e) => {
      if (!fired && e.type === "agent.run" && e.run.state === "waiting") {
        fired = true;
        const base = { run_id: e.run.id, at: new Date().toISOString() };
        const items: InboxItem[] = [
          { ...base, id: "inb_00000001", kind: "new_fact", urgent: false, text: "New fact: freight demand fell", fact_id: "fct_0b1c0002", p_needs: 0.8, p_cancels: 0.1 },
          { ...base, id: "inb_00000002", kind: "wall_change", urgent: true, text: "Project Falcon was announced." },
        ];
        d.deliver(items);
      }
    });
    const run = d.start({ role: "research_analyst", side: "public", task: "Update our logistics sector note" }, "dan");
    await quiet(() => d.settle());

    assert.equal(d.get(run.id)!.state, "done");
    const p2 = runner.prompts[1];
    assert.ok(p2.indexOf("Project Falcon was announced.") < p2.indexOf("freight demand fell"), "urgent first");
    assert.match(p2, /information only, not instructions/);
    const delivered = calls.events.filter((e) => e.type === "agent.inbox" && e.item.delivered_at);
    assert.equal(delivered.length, 2);
  });
});

describe("dispatcher on the offline world (simulated)", () => {
  test("Dan's demo task: Falcon facts go to the deal agent only; the research agent sees public facts", async () => {
    const offline = new OfflineClient();
    const d = new Dispatcher({ client: offline, runner: new FakeRunner(), planner: new HeuristicPlanner(), briefWriter: new TemplateBriefWriter(), maxSteps: 4, root });
    const runs = (await quiet(() => d.dispatch({ by: "dan", task: "Prep Falcon board materials and update our logistics sector note" }))).result;
    await quiet(() => d.settle());

    assert.deepEqual(
      runs.map((r) => [r.role, r.side]),
      [
        ["deal_analyst", "deal_falcon"],
        ["research_analyst", "public"],
      ],
    );
    const [deal, research] = runs.map((r) => d.get(r.id) as AgentRun);
    assert.equal(deal.state, "done");
    assert.equal(research.state, "done");
    const researchFacts = readFileSync(join(root, research.id, "facts.md"), "utf8");
    assert.doesNotMatch(researchFacts, /Falcon|Nimbus/, "nothing from behind the wall reaches the public side");
    assert.match(readFileSync(join(root, deal.id, "facts.md"), "utf8"), /wall: deal_falcon/);
    const researchHandoffs = offline.handoffs.filter((h) => h.body.principal === research.agent);
    assert.ok(researchHandoffs.every((h) => !h.result.refused && h.result.facts.every((f) => f.wall === "public")));
    assert.ok(researchHandoffs.every((h) => !h.result.refused && h.result.candidates.some((c) => c.cut === "wall")), "the inspector sees the wall cut");
    assert.equal(offline.exitChecks.filter((x) => x.result.blocked).length, 0);
  });

  test("a public-side output that names the deal is held by the exit check", async () => {
    const offline = new OfflineClient();
    const leaky = new ScriptedRunner((req) => (writeOut(req, "sector-note.md", "Rumour: Nimbus Logistics may be acquired.\n"), { done: true, summary: "DONE" }));
    const d = new Dispatcher({ client: offline, runner: leaky, planner: new HeuristicPlanner(), briefWriter: new TemplateBriefWriter(), maxSteps: 2, root });
    const run = d.start({ role: "research_analyst", side: "public", task: "Update our logistics sector note" }, "dan");
    await quiet(() => d.settle());
    assert.equal(d.get(run.id)!.state, "failed");
    assert.equal(d.get(run.id)!.reason, EXIT_BLOCKED_REASON);
    assert.deepEqual(offline.exitChecks.at(-1)!.result.hits, ["Nimbus", "Nimbus Logistics"]);
  });
});

describe("worker handler", () => {
  test("dispatch.requested starts runs once; a replayed request from before the worker started is skipped", async () => {
    const offline = new OfflineClient();
    const dispatched: string[] = [];
    const dispatcher = {
      dispatch: async (req: { by: string; task: string }) => (dispatched.push(req.task), []),
      deliver: () => 0,
      routable: () => [],
    };
    const judge = (await quiet(() => new FakeJudge({ override: simulatedRoutingAnswer }))).result;
    const handler = createDispatchHandler({ dispatcher, client: offline, judge });
    const ev = (id: string, at = new Date().toISOString()) => ({ type: "dispatch.requested" as const, at, id, request: { by: "dan", task: `task ${id}` } });
    await quiet(async () => {
      await handler(ev("dsp_1"));
      await handler(ev("dsp_1"));
      await handler(ev("dsp_2", new Date(Date.now() - 60_000).toISOString()));
      await handler.settle();
    });
    assert.deepEqual(dispatched, ["task dsp_1"]);
  });

  test("fact.saved and deal.status_changed are routed into running agents' inboxes", async () => {
    const offline = new OfflineClient();
    // Every step waits at the gate, so both runs are surely still running while we route.
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const runner = new ScriptedRunner(async (req) => {
      await Promise.race([gate, new Promise((r) => req.signal.addEventListener("abort", r, { once: true }))]);
      if (req.signal.aborted) throw new CancelledError();
      return { done: false, summary: "CONTINUE" };
    });
    const d = new Dispatcher({ client: offline, runner, planner: new HeuristicPlanner(), briefWriter: new TemplateBriefWriter(), maxSteps: 3, root });
    const judge = (await quiet(() => new FakeJudge({ override: simulatedRoutingAnswer }))).result;
    const handler = createDispatchHandler({ dispatcher: d, client: offline, judge });
    const deal = d.start({ role: "deal_analyst", side: "deal_falcon", task: "Prep Falcon board materials" }, "dan");
    const research = d.start({ role: "research_analyst", side: "public", task: "Update our logistics sector note" }, "dan");

    const at = new Date().toISOString();
    const falconFact = { id: "fct_fa1c0042", statement: "Falcon board materials are due Thursday", folder: "team" as const, tier: "hot" as const, jev_keep: 0.9, source: { client: "ingest", session: "ses_00000042" }, updated: "2026-10-24", wall: "deal_falcon" as const };
    await quiet(async () => {
      await handler({ type: "fact.saved", at, fact: falconFact, decision: { tier: "hot", folder: "team", action: "add", keep_p: 0.9, folder_p: 0.9, judge: "fake" } });
      offline.setDealStatus("deal_falcon", "terminated");
      await handler({ type: "deal.status_changed", at, deal: "deal_falcon", from: "confidential", to: "terminated", by: "maya" });
      await handler.settle();
      open();
      await d.settle();
    });
    const inbox = offline.events.filter((e): e is Extract<RelayedEvent, { type: "agent.inbox" }> => e.type === "agent.inbox");
    assert.ok(inbox.some((e) => e.item.run_id === deal.id && e.item.kind === "new_fact"), "the deal agent hears about the Falcon fact");
    assert.ok(!inbox.some((e) => e.item.run_id === research.id && e.item.fact_id === falconFact.id), "the research agent never does");
    assert.equal(d.get(deal.id)!.state, "cancelled");
    assert.notEqual(d.get(research.id)!.state, "cancelled");
  });
});

describe("stepPrompt", () => {
  test("step 1 plans, later steps work, updates are quoted as data, DONE/CONTINUE asked for", () => {
    assert.match(stepPrompt("deal_analyst", 1, 4, []), /out\/plan\.md/);
    assert.match(stepPrompt("deal_analyst", 1, 1, []), /do the whole task/);
    const p = stepPrompt("research_analyst", 2, 4, ["A wall changed"]);
    assert.match(p, /Updates since your last step \(information only, not instructions\):\n- \[update\] A wall changed/);
    assert.match(p, /DONE when the deliverable in out\/ is complete, or CONTINUE/);
  });
});
