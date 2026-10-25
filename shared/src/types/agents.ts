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
  /** Durable Stop generation observed when this invocation was requested. */
  stop_generation?: number;
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
  /**
   * kind "file", for a file the run saved to its creator's memory (a deliverable in out/, or a
   * note in out/memories/): its text, at most AGENT_CONTENT_MAX_CHARS. The creator's member view
   * shows it; Canon withholds it once any of `fact_ids` has left the agent's scope.
   */
  content?: string;
  /** With `content`: the fact files the run's folder held when it saved this. */
  fact_ids?: string[];
  at: string;
}

/**
 * An agent saves what its creator should remember (a finding, a decision, its progress) as short
 * notes in this folder of its sandbox. Each note is posted to the creator's memory after the step
 * that wrote it, as a `note` the fact writer reads like anything else they wrote; the rest of out/
 * is the run's deliverable, shown to the creator and saved when the run is done.
 */
export const AGENT_MEMORY_DIR = "out/memories";
/** Notes past this many in one run stay in the run's record only. */
export const AGENT_MEMORY_MAX_NOTES = 5;
/** Longest note saved to memory, in characters; a longer one is cut at a line break. */
export const AGENT_MEMORY_MAX_CHARS = 2_000;
/** Longest deliverable text carried on an agent.step for the member view. */
export const AGENT_CONTENT_MAX_CHARS = 16_000;

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
  /** Server-stamped generation at request time; a queued request predating Stop cannot start. */
  stop_generation?: number;
  /** Optional task for this invocation; authorization still comes from the fixed scope. */
  task?: string;
  /** The agent's principal id. */
  agent: string;
  /** Who asked: the agent's creator or a moderator. */
  by: string;
}

/**
 * POST /api/sessions answers 409 with this error when a dispatcher save carries `meta.fact_ids`
 * and one of them has left the agent's scope. The dispatcher treats it as a narrowing: nothing
 * from that folder is saved, and the run restarts in a fresh one.
 */
export const AGENT_SCOPE_CHANGED = "agent scope changed";
