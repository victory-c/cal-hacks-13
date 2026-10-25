import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AgentRun, AgentStep, InboxItem } from "@canon/shared";

import { AgentRuns } from "./agent-runs.ts";
import { EventBus } from "./events.ts";

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: "run_0001",
  agent: "agt_desk",
  created_by: "dollar-bill",
  task: "Answer my questions about our positions",
  state: "queued",
  runtime: "fake",
  sandbox: "data/agents/run_0001",
  steps: 0,
  restarts: 0,
  started_at: "2026-10-24T20:00:00.000Z",
  ...over,
});
const step = (n: number, kind: AgentStep["kind"], text: string, file?: string): AgentStep => ({ run_id: "run_0001", n, kind, text, at: `2026-10-24T20:0${n}:00.000Z`, ...(file ? { file } : {}) });
const inbox = (text: string): InboxItem => ({ id: "inb_1", run_id: "run_0001", kind: "new_fact", urgent: false, text, at: "2026-10-24T20:05:00.000Z" });

describe("AgentRuns: the dispatcher's events as the consoles' run state", () => {
  test("an agent the dispatcher never reported is ready with nothing in it", () => {
    const runs = new AgentRuns();
    assert.deepEqual(runs.view("agt_desk"), { status: "ready", steps: [], files: [], inbox: [], finished_at: null, restarts: 0 });
  });

  test("queued → running steps → done, with files and the inbox collected along the way", () => {
    const runs = new AgentRuns();
    assert.equal(runs.apply({ type: "agent.run", at: "t1", run: run() }), "agent.started");
    assert.equal(runs.view("agt_desk").status, "running");
    assert.equal(runs.apply({ type: "agent.run", at: "t2", run: run({ state: "running" }) }), "agent.step", "a state change inside the same run is a step, not a start");
    runs.apply({ type: "agent.step", at: "t3", step: step(1, "brief", "facts/ holds 4 fact files", "facts") });
    runs.apply({ type: "agent.step", at: "t4", step: step(2, "plan", "Plan: summarize the position") });
    let v = runs.view("agt_desk");
    assert.deepEqual(v.steps.map((s) => [s.text, s.status]), [["facts/ holds 4 fact files", "done"], ["Plan: summarize the position", "running"]]);
    assert.deepEqual(v.files, ["facts"]);
    runs.apply({ type: "agent.inbox", at: "t5", item: inbox("new_fact: facts/fct_1.md added") });
    runs.apply({ type: "agent.step", at: "t6", step: step(3, "file", "wrote memo.md", "memo.md") });
    assert.equal(runs.apply({ type: "agent.run", at: "t7", run: run({ state: "done", steps: 3, ended_at: "2026-10-24T20:07:00.000Z" }) }), "agent.finished");
    v = runs.view("agt_desk");
    assert.equal(v.status, "done");
    assert.equal(v.finished_at, "2026-10-24T20:07:00.000Z");
    assert.ok(v.steps.every((s) => s.status === "done"), "a finished run has no running step");
    assert.deepEqual(v.files, ["facts", "memo.md"]);
    assert.deepEqual(v.inbox, [{ text: "new_fact: facts/fct_1.md added", at: "2026-10-24T20:05:00.000Z" }]);
    assert.equal(runs.agentOf("run_0001"), "agt_desk");
  });

  test("a restart (same run, restarts + 1) is 'restarting' with a fresh folder; the next step makes it running again", () => {
    const runs = new AgentRuns();
    runs.apply({ type: "agent.run", at: "t1", run: run({ state: "running" }) });
    runs.apply({ type: "agent.step", at: "t2", step: step(1, "brief", "old folder", "facts") });
    assert.equal(runs.apply({ type: "agent.run", at: "t3", run: run({ state: "running", restarts: 1 }) }), "agent.restarted");
    let v = runs.view("agt_desk");
    assert.equal(v.status, "restarting");
    assert.deepEqual([v.steps, v.files, v.restarts], [[], [], 1]);
    runs.apply({ type: "agent.step", at: "t4", step: step(1, "plan", "Restart 1: fresh folder") });
    v = runs.view("agt_desk");
    assert.equal(v.status, "running");
    assert.equal(v.steps.length, 1);
  });

  test("cancelled is stopped, failed is failed; a step for an unknown run is ignored", () => {
    const runs = new AgentRuns();
    runs.apply({ type: "agent.run", at: "t1", run: run({ state: "running" }) });
    runs.apply({ type: "agent.run", at: "t2", run: run({ state: "cancelled", reason: "agent deleted" }) });
    assert.equal(runs.view("agt_desk").status, "stopped");
    runs.apply({ type: "agent.run", at: "t3", run: run({ id: "run_0002", state: "failed" }) });
    assert.equal(runs.view("agt_desk").status, "failed");
    runs.apply({ type: "agent.step", at: "t4", step: { ...step(1, "tool", "orphan"), run_id: "run_9999" } });
    assert.equal(runs.view("agt_desk").steps.length, 0);
  });

  test("attach() folds bus events in before later subscribers read the view", () => {
    const bus = new EventBus();
    const runs = new AgentRuns();
    runs.attach(bus);
    let seen: string | undefined;
    bus.subscribe((e) => {
      if (e.type === "agent.run") seen = runs.view(e.run.agent).status;
    });
    bus.emit({ type: "agent.run", run: run({ state: "running" }) });
    assert.equal(seen, "running");
    assert.equal(runs.view("agt_desk").run_id, "run_0001");
  });
});
