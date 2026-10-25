// Agent run state as the consoles show it (INTEGRATION.md `AgentRun`: status, steps, files,
// inbox), derived from the dispatcher's relayed events (`agent.run`, `agent.step`, `agent.inbox`,
// shared/src/types/agents.ts). Lane B's dispatcher owns runs, sandboxes and inboxes; the server
// only keeps the latest picture per agent, so GET /api/agents and the member and moderator
// streams can say what an agent is doing without asking the dispatcher. In memory only: after a
// restart every agent reads "ready" until the dispatcher reports again, which it does on its
// next run.

import type { AgentRun, AgentStep, CanonEvent, InboxItem } from "@canon/shared";

import type { EventBus } from "./events.ts";

/** The contract's statuses. `building` is the console's own transient state; the server never reports it. */
export type ConsoleStatus = "ready" | "running" | "restarting" | "done" | "failed" | "stopped";

export interface ConsoleStep {
  id: string;
  text: string;
  status: "running" | "done";
  at: string;
}

export interface AgentRunView {
  /** The dispatcher's run id, once it has reported one. */
  run_id?: string;
  status: ConsoleStatus;
  steps: ConsoleStep[];
  /** Files the run wrote in its sandbox, in first-seen order. */
  files: string[];
  inbox: Array<{ text: string; at: string }>;
  finished_at: string | null;
  restarts: number;
}

/** The console event a run update stands for. */
export type RunTransition = "agent.started" | "agent.restarted" | "agent.finished" | "agent.step";

const MAX_STEPS = 200;
const MAX_INBOX = 100;

function fresh(): AgentRunView {
  return { status: "ready", steps: [], files: [], inbox: [], finished_at: null, restarts: 0 };
}

function statusOf(run: AgentRun): ConsoleStatus {
  switch (run.state) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    default:
      return "running"; // queued, running, waiting: the run is live
  }
}

function terminal(status: ConsoleStatus): boolean {
  return status === "done" || status === "failed" || status === "stopped";
}

export class AgentRuns {
  private readonly byAgent = new Map<string, AgentRunView>();
  private readonly agentOfRun = new Map<string, string>();

  /** Subscribe before any SSE client, so projections read the state the event just produced. */
  attach(bus: EventBus): () => void {
    return bus.subscribe((e) => void this.apply(e));
  }

  /** Folds one event in; returns the console transition for `agent.run` events, else undefined. */
  apply(e: CanonEvent): RunTransition | undefined {
    switch (e.type) {
      case "agent.run":
        return this.applyRun(e.run, e.at);
      case "agent.step":
        this.applyStep(e.step);
        return "agent.step";
      case "agent.inbox":
        this.applyInbox(e.item);
        return undefined;
      default:
        return undefined;
    }
  }

  /** The latest picture of an agent; a fresh "ready" view when the dispatcher never reported. */
  view(agentId: string): AgentRunView {
    const v = this.byAgent.get(agentId);
    return v ? { ...v, steps: [...v.steps], files: [...v.files], inbox: [...v.inbox] } : fresh();
  }

  /** Which agent a run or step belongs to, for stream filters. */
  agentOf(runId: string): string | undefined {
    return this.agentOfRun.get(runId);
  }

  private applyRun(run: AgentRun, at: string): RunTransition {
    this.agentOfRun.set(run.id, run.agent);
    const prev = this.byAgent.get(run.agent);
    const status = statusOf(run);
    const sameRun = prev?.run_id === run.id;
    // A new run (or a restart, which the dispatcher reports as the same run with restarts + 1)
    // starts from a fresh folder, so steps, files and inbox start over.
    const restarted = sameRun && prev !== undefined && run.restarts > prev.restarts;
    const base = sameRun && !restarted && prev ? prev : fresh();
    const view: AgentRunView = {
      ...base,
      run_id: run.id,
      status: restarted && !terminal(status) ? "restarting" : status,
      finished_at: terminal(status) ? run.ended_at ?? at : null,
      restarts: run.restarts,
    };
    if (restarted) {
      view.steps = [];
      view.files = [];
      view.inbox = [];
    }
    if (terminal(status)) view.steps = view.steps.map((s) => ({ ...s, status: "done" as const }));
    this.byAgent.set(run.agent, view);
    if (terminal(status)) return "agent.finished";
    if (restarted) return "agent.restarted";
    return sameRun ? "agent.step" : "agent.started";
  }

  private applyStep(step: AgentStep): void {
    const agent = this.agentOfRun.get(step.run_id);
    if (!agent) return; // a step for a run the server never saw start: nothing to attach it to
    const prev = this.byAgent.get(agent) ?? fresh();
    const done = step.kind === "result" || step.kind === "error";
    const steps: ConsoleStep[] = prev.steps.map((s) => ({ ...s, status: "done" }));
    steps.push({ id: `${step.run_id}:${step.n}:${steps.length + 1}`, text: step.text, status: done ? "done" : "running", at: step.at });
    const files = step.file && !prev.files.includes(step.file) ? [...prev.files, step.file] : prev.files;
    const status: ConsoleStatus = prev.status === "restarting" ? "running" : prev.status;
    this.byAgent.set(agent, { ...prev, status, steps: steps.slice(-MAX_STEPS), files });
  }

  private applyInbox(item: InboxItem): void {
    const agent = this.agentOfRun.get(item.run_id);
    if (!agent) return;
    const prev = this.byAgent.get(agent) ?? fresh();
    const inbox = [...prev.inbox, { text: item.text, at: item.delivered_at ?? item.at }].slice(-MAX_INBOX);
    this.byAgent.set(agent, { ...prev, inbox });
  }
}
