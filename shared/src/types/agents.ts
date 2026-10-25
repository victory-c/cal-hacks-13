// Agent runs contract (PRD "Agents and dispatch"). An agent is a Principal (kind "agent") with
// its own ScopeRule, created by a person; the server builds its scope from its creator's scope
// only. Lane B's dispatcher owns runs, sandboxes and inboxes and publishes every change as an
// event (POST /api/events), so the dashboard draws one lane per agent and the audit log has the
// record. The sandbox holds the agent's scope as markdown files and nothing else.

/** droid: Factory `droid exec` (the real one). claude: fallback runner. fake: offline, simulated. */
export const AGENT_RUNTIMES = ["droid", "claude", "fake"] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

export const RUN_STATES = ["queued", "running", "waiting", "done", "cancelled", "failed"] as const;
export type RunState = (typeof RUN_STATES)[number];

export interface AgentRun {
  /** `run_` + hex */
  id: string;
  /** The agent's principal id. Its scope decides everything it can see. */
  agent: string;
  /** The person who created the agent. The agent's new facts are their memories. */
  created_by: string;
  /** The agent's task, from its scope rule (never its exclusions). */
  task: string;
  state: RunState;
  runtime: AgentRuntime;
  /** Sandbox folder relative to the repo root, e.g. `data/agents/run_1a2b`. */
  sandbox: string;
  /** Steps finished so far. Each step is one short runtime invocation. */
  steps: number;
  /** Times the run was restarted from the plan step in a fresh folder because its scope narrowed. */
  restarts: number;
  started_at: string;
  ended_at?: string;
  /** cancelled / failed: why, in one line. Never names facts outside the agent's scope. */
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

/**
 * What live routing delivers to a running agent between steps. new_fact: a fact that joined its
 * scope and that Jev says it needs now. scope_narrowed: urgent; the run folder is discarded and
 * the run restarts from the plan step in a fresh folder built from the new scope. cancel: the
 * agent was deleted.
 */
export interface InboxItem {
  /** `inb_` + hex */
  id: string;
  run_id: string;
  kind: "new_fact" | "scope_narrowed" | "cancel";
  /** scope_narrowed and cancel are urgent: applied before the next step starts. */
  urgent: boolean;
  text: string;
  fact_id?: string;
  /** Jev: P(the agent needs this new fact now). */
  p_needs?: number;
  at: string;
  delivered_at?: string;
}

/** Someone asked for an agent profile to run (POST /api/dispatch). */
export interface DispatchRequest {
  /** The agent's principal id. */
  agent: string;
  /** Who asked: the agent's creator or a moderator. */
  by: string;
}
