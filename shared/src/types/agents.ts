// Agent dispatch contract (PRD v2 "Agents and dispatch"). Lane B's dispatcher process owns runs,
// sandboxes and inboxes; it publishes every change as an event (POST /api/events) so the
// dashboard draws one lane per agent and the audit log has the record. Agents get their slice
// from POST /api/handoff as their own principal, so the permission filter always runs first.

import type { Wall } from "./walls.ts";

export const AGENT_ROLES = ["deal_analyst", "research_analyst", "desk_assistant"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** droid: Factory `droid exec` (the real one). claude: fallback runner. fake: offline, simulated. */
export const AGENT_RUNTIMES = ["droid", "claude", "fake"] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

export const RUN_STATES = ["queued", "running", "waiting", "done", "cancelled", "failed"] as const;
export type RunState = (typeof RUN_STATES)[number];

export interface AgentRun {
  /** `run_` + hex */
  id: string;
  /** The agent's principal id (`agt_research_1`). Its entitlements decide its slice. */
  agent: string;
  role: AgentRole;
  /** The person who dispatched it. */
  acts_for: string;
  /** Which side of the wall it works on: `public` or a deal id. */
  side: Wall;
  task: string;
  state: RunState;
  runtime: AgentRuntime;
  /** Sandbox folder relative to the repo root, e.g. `data/agents/run_1a2b`. */
  sandbox: string;
  /** Steps finished so far. Each step is one short runtime invocation. */
  steps: number;
  started_at: string;
  ended_at?: string;
  /** cancelled / failed: why, in one line (compliance-safe on the dashboard). */
  reason?: string;
}

export const STEP_KINDS = ["brief", "plan", "tool", "file", "message", "result", "error", "inbox"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** One thing an agent did. Streams to its lane and becomes its audit record. */
export interface AgentStep {
  run_id: string;
  /** Which runtime invocation (1-based) this happened in. */
  n: number;
  kind: StepKind;
  text: string;
  /** kind "file": path relative to the sandbox. */
  file?: string;
  /** Real token counts from the runtime, when it reports them. Never estimated. */
  tokens?: { input: number; output: number };
  at: string;
}

/** What live routing delivers to a running agent between steps. */
export interface InboxItem {
  /** `inb_` + hex */
  id: string;
  run_id: string;
  kind: "new_fact" | "wall_change" | "cancel";
  /** Wall changes and cancels are urgent: applied before the next step starts. */
  urgent: boolean;
  text: string;
  fact_id?: string;
  /** Jev: P(agent needs this) and P(this cancels the agent's work). */
  p_needs?: number;
  p_cancels?: number;
  at: string;
  delivered_at?: string;
}

/** A person's task, before Canon splits it into agent runs. */
export interface DispatchRequest {
  /** Principal id of the person typing it. */
  by: string;
  task: string;
}
