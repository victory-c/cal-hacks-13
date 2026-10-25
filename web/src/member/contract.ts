// The member-facing slice of docs/INTEGRATION.md, typed for the member view. These shapes are not
// in @canon/shared yet (the server still serves the folder-grant scaffold); move them there when
// lane A lands the contract routes. Fields marked PROPOSED are not in the contract today: they are
// what this view needs and are listed in web/README.md for Henry and Victor to accept or change.

export type Tier = "moderator" | "member";

export interface Principal {
  id: string;
  kind: "person" | "agent";
  name: string;
  tier?: Tier;
  creator?: string;
}

/** GET /api/me. The task is returned but this view does not show it (see web/README.md). */
export interface Me extends Principal {
  task?: string;
  /** PROPOSED: the firm name for the header. */
  firm?: string;
}

export const ITEM_KINDS = ["memo", "chat", "email", "transcript", "note", "session"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** POST /api/items. `author` defaults to the caller and only moderators may set it. */
export interface AddItemBody {
  kind: Exclude<ItemKind, "session">;
  source: string;
  text: string;
}

export interface Fact {
  id: string;
  statement: string;
  group: string;
  labels: string[];
  source: string;
  author: string;
  happened_at: string;
  learned_at: string;
  status: "hot" | "cold";
  /** PROPOSED: the kind and title of the item the fact came from, for the provenance line. */
  source_kind?: ItemKind;
  source_title?: string;
}

export interface ScopeExclusions {
  groups: string[];
  labels: string[];
  /** Plain-language exclusions; the member form's "Leave out" box. */
  text: string[];
}

/** Contract statuses are running · restarting · done · failed; the rest are PROPOSED. */
export type AgentStatus = "building" | "ready" | "running" | "restarting" | "done" | "failed" | "stopped";

export interface AgentStep {
  id: string;
  text: string;
  status: "running" | "done";
  at: string;
  /** Canon's step kind (brief, plan, tool, file, message, result, error, inbox); absent in mock. */
  kind?: string;
  /** For file steps: the path inside the agent's folder. */
  file?: string;
}

/** One of the creator's own memory groups, and whether their agent draws on it. */
export interface MemoryGroup {
  id: string;
  name: string;
  included: boolean;
  /** Memories from this group in the agent's scope now. */
  count: number;
}

/** A document the agent wrote (out/…), as the creator reads it. Markdown. */
export interface AgentDocument {
  file: string;
  title: string;
  text: string;
  at: string;
}

/** A note the agent saved to its creator's memory while it worked (out/memories/…). */
export interface AgentNote {
  file: string;
  text: string;
  at: string;
}

export interface OutputLine {
  text: string;
  /** Title of the item behind the line, or "" for prose that draws on several. */
  source: string;
}

/** PROPOSED: a document an agent wrote, with its content (the contract has file names only). */
export interface AgentOutput {
  type: DocType;
  title: string;
  lines: OutputLine[];
}

export interface AgentRun {
  id: string;
  creator: string;
  name: string;
  status: AgentStatus;
  steps: AgentStep[];
  files: string[];
  inbox: { text: string; at: string }[];
  /** PROPOSED from here down. */
  task: string;
  /** Only the exclusions the member added themselves (the contract's rule for a creator). */
  leave_out: string;
  docs: DocType[];
  schedule: Schedule;
  outputs: AgentOutput[];
  finished_at: string | null;
  fact_count: number;
  /** New facts that joined the agent's scope since its last run. */
  pending: number;
  /** The creator's groups and which ones this agent remembers. Absent before Canon sends it. */
  memory_groups?: MemoryGroup[];
  /** What the last run wrote. */
  documents?: AgentDocument[];
  /** Notes the last run saved to the creator's memory. */
  memories?: AgentNote[];
  /** The agent's memory changed since its last run: its documents need a new run. */
  refresh?: boolean;
  /** What the last run was asked to do (the standing task, or a one-off assignment). */
  run_task?: string | null;
  started_at?: string | null;
}

/** POST /api/agents, plus PROPOSED docs and schedule. */
export interface AgentBody {
  name: string;
  task: string;
  exclusions: ScopeExclusions;
  docs: DocType[];
  schedule: Schedule;
  /**
   * Which of the creator's own groups the agent leaves out (every unticked box). On create they
   * join `exclusions.groups`; on edit they replace the creator's own choice (Canon keeps any wall
   * Compliance put up). Absent: the groups stay as they are.
   */
  exclude_groups?: string[];
}

/** The documents an agent can make from a scope's short facts. */
export const DOC_TYPES = [
  { id: "summary", label: "Brief summary", hint: "The key points in a few lines" },
  { id: "changes", label: "What changed", hint: "New since the last run" },
  { id: "trends", label: "Market trends", hint: "Flows, fees and direction of travel" },
  { id: "snapshot", label: "Company snapshot", hint: "Everything on one company" },
  { id: "compare", label: "Peer comparison", hint: "Valuations side by side" },
  { id: "dates", label: "Key dates", hint: "Deadlines and upcoming events" },
  { id: "plan", label: "Action plan", hint: "Next steps, in order" },
  { id: "talking", label: "Talking points", hint: "For a meeting or call" },
  { id: "gaps", label: "Open questions", hint: "What the memory doesn’t cover yet" },
  { id: "memo", label: "Draft note", hint: "A first draft in prose" },
] as const;
export type DocType = (typeof DOC_TYPES)[number]["id"];

export const SCHEDULES = [
  "Only when I press Run",
  "Every weekday, 8:00 AM",
  "Every Monday, 8:00 AM",
  "First business day of the month",
  "Whenever new memories arrive",
] as const;
export type Schedule = (typeof SCHEDULES)[number];

/** The member-visible events from GET /events, each with `type` and `at`. */
export type MemberEvent =
  | { type: "item.captured"; at: string; item_id: string; kind: ItemKind; source: string; author: string }
  | { type: "fact.saved"; at: string; fact: Fact }
  | { type: "scope.changed"; at: string; principal: string; added: string[]; removed: string[] }
  | { type: "scope.build"; at: string; build_id: string; principal: string; stage: "exclusions" | "candidates" | "judged" | "done"; counts: Record<string, number> }
  | { type: "agent.started" | "agent.step" | "agent.inbox" | "agent.restarted" | "agent.finished"; at: string; run: AgentRun };

export const MEMBER_EVENT_TYPES: readonly MemberEvent["type"][] = [
  "item.captured", "fact.saved", "scope.changed", "scope.build",
  "agent.started", "agent.step", "agent.inbox", "agent.restarted", "agent.finished",
];

/** Everything the member view asks of Canon. The mock and the HTTP client both implement it. */
export interface MemberApi {
  readonly mode: "mock" | "canon";
  me(): Promise<Me>;
  facts(): Promise<Fact[]>;
  /** PROPOSED: display names for group ids ("research/asset-managers" → "Asset manager research"). */
  groupNames(): Promise<Record<string, string>>;
  editFact(id: string, statement: string): Promise<Fact>;
  retireFact(id: string): Promise<void>;
  addItem(body: AddItemBody): Promise<{ item_id: string }>;
  agents(): Promise<AgentRun[]>;
  createAgent(body: AgentBody): Promise<{ id: string; build_id: string }>;
  updateAgent(id: string, body: AgentBody): Promise<{ build_id: string }>;
  deleteAgent(id: string): Promise<void>;
  /** Starts a run: on `task` when given (a one-off assignment), else on the agent's standing task. */
  runAgent(id: string, task?: string): Promise<void>;
  stopAgent(id: string): Promise<void>;
  /** Replays recent events, then streams. Returns an unsubscribe function. */
  subscribe(onEvent: (ev: MemberEvent) => void, onStatus: (s: "connecting" | "live" | "reconnecting") => void): () => void;
}
