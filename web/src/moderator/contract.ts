// The moderator-facing slice of docs/INTEGRATION.md, typed for the console. Shapes shared with the
// member view (facts, agent runs, document types) come from ../member/contract.ts. Fields and
// routes marked PROPOSED are not in the contract yet; web/README.md lists them for lane A.

import type { AddItemBody, AgentRun, Fact, ItemKind } from "../member/contract.ts";

export type { AgentRun, Fact, ItemKind };

export const INBOX = "inbox";

/** PROPOSED: GET /api/groups. `INBOX` is not a group; it is where unplaced facts wait. */
export interface Group {
  id: string;
  name: string;
  description: string;
}

export interface ScopeRule {
  task: string;
  exclusions: { groups: string[]; labels: string[]; text: string[] };
}

export interface ModPrincipal {
  id: string;
  kind: "person" | "agent";
  name: string;
  tier?: "moderator" | "member";
  creator?: string;
  /** null until Compliance builds one. Moderators see the exclusions. */
  rule: ScopeRule | null;
  /** The scope: fact ids. */
  fact_ids: string[];
}

export interface HeldItem {
  id: string;
  kind: ItemKind;
  source: string;
  author: string;
  reason: string;
  at: string;
}

export interface HandoffCandidate {
  fact_id: string;
  statement: string;
  p: number;
  decision: "kept" | "cut_relevance" | "cut_budget";
  tokens_est: number;
}

export interface Handoff {
  id: string;
  at: string;
  principal: string;
  request: string;
  candidates: HandoffCandidate[];
  tokens_est: number;
  budget_est: number;
  timings_ms: { search: number | null; judge: number | null; total: number | null };
  simulated: boolean;
}

/** PROPOSED response shape for GET /api/audit. */
export interface AuditEntry {
  at: string;
  principal: string | null;
  group: string | null;
  text: string;
}

export type BuildStage = "exclusions" | "candidates" | "judged" | "done";

/** The moderator-visible events from GET /events. */
export type ModEvent =
  | { type: "item.captured"; at: string; item_id: string; kind: ItemKind; source: string; author: string }
  | { type: "item.quarantined"; at: string; item_id: string; source: string; reason: string }
  | { type: "fact.saved"; at: string; fact: Fact }
  | { type: "fact.filed"; at: string; fact_ids: string[]; group: string; from: string[] }
  | { type: "scope.build"; at: string; build_id: string; principal: string; stage: BuildStage; counts: Record<string, number>; groups_removed?: string[] }
  | { type: "scope.changed"; at: string; principal: string; added: string[]; removed: string[] }
  | { type: "principal.added" | "principal.tier"; at: string; principal: ModPrincipal }
  | { type: "agent.started" | "agent.step" | "agent.inbox" | "agent.restarted" | "agent.finished"; at: string; run: AgentRun }
  | { type: "context.served"; at: string; handoff: Handoff }
  /** PROPOSED. */
  | { type: "group.created"; at: string; group: Group }
  | { type: "item.released"; at: string; item_id: string; source: string; facts: number };

export const MOD_EVENT_TYPES: readonly ModEvent["type"][] = [
  "item.captured", "item.quarantined", "fact.saved", "fact.filed", "scope.build", "scope.changed",
  "principal.added", "principal.tier", "agent.started", "agent.step", "agent.inbox", "agent.restarted",
  "agent.finished", "context.served", "group.created", "item.released",
];

export interface AddItemAsModerator extends AddItemBody {
  /** Only moderators may name someone else. */
  author: string;
}

/** Everything the console asks of Canon. The mock and the HTTP client both implement it. */
export interface ModeratorApi {
  readonly mode: "mock" | "canon";
  me(): Promise<ModPrincipal & { firm?: string }>;
  principals(): Promise<ModPrincipal[]>;
  groups(): Promise<Group[]>;
  createGroup(name: string, description: string): Promise<Group>;
  /** All facts, including the inbox. */
  facts(): Promise<Fact[]>;
  addPerson(name: string, tier: "moderator" | "member"): Promise<ModPrincipal>;
  setTier(id: string, tier: "moderator" | "member"): Promise<void>;
  setRule(id: string, rule: ScopeRule): Promise<{ build_id: string }>;
  /** POST /api/facts/:id/file for each id (one call per fact in the contract today). */
  fileFacts(ids: string[], group: string): Promise<void>;
  editFact(id: string, statement: string): Promise<Fact>;
  retireFact(id: string): Promise<void>;
  addItem(body: AddItemAsModerator): Promise<{ item_id: string }>;
  quarantine(): Promise<HeldItem[]>;
  release(id: string): Promise<void>;
  agents(): Promise<AgentRun[]>;
  runAgent(id: string): Promise<void>;
  stopAgent(id: string): Promise<void>;
  handoffs(): Promise<Handoff[]>;
  audit(): Promise<AuditEntry[]>;
  subscribe(onEvent: (ev: ModEvent) => void, onStatus: (s: "connecting" | "live" | "reconnecting") => void): () => void;
}
