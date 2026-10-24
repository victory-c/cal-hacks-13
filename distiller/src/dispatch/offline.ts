// OfflineClient: an in-process stand-in for Henry's scope routes over the synthetic world in
// distiller/fixtures/world/, so `npm run dispatch -w distiller -- --demo` runs end to end with no
// server and no keys. Everything here is SIMULATED and says so:
//   - the facts are hand-written from the fixture sessions (a simulated fact writer and triage).
//     Each one carries the line it came from (`quote`), and loading checks that the line is still
//     in its fixture word for word, so this world cannot drift from the fixtures;
//   - scopes are built BY GROUP, not by the real builder (exclusions in code, Moss, Jev): a person's
//     scope is every fact in their groups, and an agent's scope is the facts in the groups its
//     profile asks for AND its creator's groups, so an agent never holds more than its creator;
//   - the handoff ranks inside the scope by word overlap, not Moss and Jev.
// The real builder, handoff and audit live in server/ (lane A).
//
// All data is synthetic: Harbor Lane Partners, Project Falcon (its client Corvane acquiring Nimbus
// Logistics), Maya in compliance (moderator), Dan the banker, Priya in research, Leo on the desk.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { GROUP_RE, cutToBudget, estimateTokens, factTokens, nowIso } from "@canon/shared";
import type {
  CanonEvent,
  CapturedSession,
  ContextFact,
  Fact,
  Group,
  GroupsResponse,
  HandoffBody,
  HandoffCandidate,
  HandoffResult,
  PostSessionResponse,
  Principal,
  ScopeRule,
} from "@canon/shared";
import type { DispatchClient, RelayedEvent } from "./client.ts";
import { AGENT_ID_RE } from "./dispatcher.ts";

export const WORLD_DIR = fileURLToPath(new URL("../../fixtures/world/", import.meta.url));

/** One offline fact: the statement a fact writer would produce, and the fixture line it came from. */
interface FactSpec {
  id: string;
  /** Fixture file in WORLD_DIR. */
  file: string;
  group: string;
  statement: string;
  /** Must appear word for word in the fixture's messages. */
  quote: string;
  /** Whose memory it is; defaults to the session's principal. */
  author?: string;
  happened?: string;
  labels?: string[];
}

const MEMO = "falcon-process-memo.json";
const NEWS = "nimbus-public-news.json";
const FLOOR = "hl-floor-chat-week.json";

/**
 * The facts of the offline world. The outside counsel email (outside-counsel-email.json) is held
 * in quarantine for its planted instruction, so nothing from it is here.
 */
const FACT_SPECS: FactSpec[] = [
  // deal/falcon: Dan's draft v3 process memo
  { id: "fct_fa1c0001", file: MEMO, group: "deal/falcon", labels: ["nimbus"], happened: "2026-10-06", statement: "Project Falcon: Corvane Freight Holdings, Harbor Lane's client, signed the NDA with Nimbus Logistics on 2026-10-06.", quote: 'Corvane Freight Holdings ("Corvane", our client) signed the NDA with Nimbus Logistics on 2026-10-06.' },
  { id: "fct_fa1c0002", file: MEMO, group: "deal/falcon", happened: "2026-10-20", statement: "Project Falcon: Corvane's investment committee approved a non-binding range of 9.0x to 9.75x LTM EBITDA on 2026-10-20.", quote: "Corvane's investment committee approved a non-binding range of 9.0x to 9.75x LTM EBITDA on 2026-10-20." },
  { id: "fct_fa1c0003", file: MEMO, group: "deal/falcon", labels: ["nimbus"], statement: "Project Falcon's proposed price is $38.50 per NMBL share in cash, about a 24% premium to the 2026-10-21 close of $31.05.", quote: "Price: $38.50 per NMBL share in cash, a ~24% premium to the 2026-10-21 close of $31.05." },
  { id: "fct_fa1c0004", file: MEMO, group: "deal/falcon", statement: "Project Falcon implies an enterprise value of about $1.35bn, about 9.5x LTM EBITDA of $142m.", quote: "Implied EV ~$1.35bn, ~9.5x LTM EBITDA of $142m." },
  { id: "fct_fa1c0005", file: MEMO, group: "deal/falcon", statement: "Project Falcon proposes 45 days of exclusivity from LOI signing.", quote: "Exclusivity: 45 days from LOI signing." },
  { id: "fct_fa1c0006", file: MEMO, group: "deal/falcon", labels: ["nimbus"], happened: "2026-10-28", statement: "Project Falcon's LOI goes to the Nimbus board by 2026-10-28; their board meets 2026-10-29.", quote: "LOI to the Nimbus board by 2026-10-28 (their board meets 2026-10-29)." },
  // market/public: Priya's roundup of Nimbus's public Q3 news
  { id: "fct_0b1c0001", file: NEWS, group: "market/public", labels: ["nimbus"], happened: "2026-10-22", statement: "Nimbus Logistics reported Q3 2026 revenue of $1.21bn, down 3% year over year, and adjusted EBITDA of $36m.", quote: "Nimbus Logistics reported Q3 2026 results on 2026-10-22: revenue $1.21bn, down 3% year over year; adjusted EBITDA $36m." },
  { id: "fct_0b1c0002", file: NEWS, group: "market/public", labels: ["nimbus"], happened: "2026-10-22", statement: "Nimbus Logistics cut full-year revenue guidance to $4.8-4.9bn from $5.0bn, citing soft freight volumes.", quote: "Management cut full-year revenue guidance to $4.8-4.9bn, from $5.0bn, citing soft freight volumes." },
  { id: "fct_0b1c0003", file: NEWS, group: "market/public", labels: ["nimbus"], happened: "2026-10-22", statement: "NMBL shares fell 7% on 2026-10-22 to close at $28.88.", quote: "Shares fell 7% on 2026-10-22 to close at $28.88." },
  { id: "fct_0b1c0005", file: NEWS, group: "market/public", labels: ["nimbus"], happened: "2026-10-22", statement: "Nimbus's CEO said the Memphis hub automation project is on budget and finishes in Q2 2027.", quote: "On the call the CEO said the Memphis hub automation project is on budget and finishes in Q2 2027." },
  // research/logistics
  { id: "fct_7e5e0001", file: FLOOR, group: "research/logistics", author: "priya", happened: "2026-10-20", statement: "Harbor Lane's logistics sector note covers freight brokers and the asset-light 3PLs this time.", quote: "Covering freight brokers and the asset-light 3PLs this time, restricted names excluded." },
  { id: "fct_7e5e0002", file: NEWS, group: "research/logistics", labels: ["nimbus"], statement: "Priya's view: the Nimbus guidance cut was mostly priced in; the automation spend is the logistics story for 2027.", quote: "my take: guidance cut was mostly priced in, the automation spend is the real story for 2027" },
  { id: "fct_7e5e0003", file: FLOOR, group: "research/logistics", author: "priya", happened: "2026-10-23", statement: "The logistics sector note was published on 2026-10-23 after compliance review.", quote: "Sector note is published." },
  // desk/trading
  { id: "fct_de5c0001", file: FLOOR, group: "desk/trading", author: "leo", happened: "2026-10-21", statement: "The desk agreed to cut the regional bank basket by half into the print, done at the close on 2026-10-21.", quote: "We agreed to cut the regional bank basket by half into the print, done at the close." },
  { id: "fct_de5c0002", file: FLOOR, group: "desk/trading", author: "leo", labels: ["lksp"], happened: "2026-10-19", statement: "LKSP rose 6% on no news on 2026-10-19.", quote: "LKSP ripping again, +6% on no news." },
  // firm/ops
  { id: "fct_0f5e0001", file: FLOOR, group: "firm/ops", author: "maya", statement: "Quarterly personal-trading attestations are due Friday 2026-10-23, signed in the portal.", quote: "Deadline for quarterly personal-trading attestations is Friday 2026-10-23." },
  { id: "fct_0f5e0002", file: FLOOR, group: "firm/ops", author: "maya", statement: "Firm AI tools only: no personal ChatGPT accounts for client work.", quote: "Reminder: firm AI tools only, no personal ChatGPT accounts for client work." },
];

/** Joins the world with `--then add` (it is in no scope at the start). */
const LATE_FACT: FactSpec = {
  id: "fct_0b1c0004",
  file: NEWS,
  group: "market/public",
  labels: ["nimbus"],
  happened: "2026-10-22",
  statement: "A sell-side analyst cut Nimbus Logistics (NMBL) to Hold with a $33 price target on 2026-10-22.",
  quote: "One sell-side analyst cut NMBL to Hold with a $33 price target on 2026-10-22.",
};

export interface OfflinePerson {
  principal: Principal;
  /** Members: the groups their (simulated) scope holds. Moderators see every group. */
  groups: string[];
}

export interface OfflineAgent {
  principal: Principal & { created_by: string };
  /** The groups the agent's profile asks for. Its scope is these AND its creator's. */
  groups: string[];
  task: string;
}

export interface OfflineWorld {
  groups: Group[];
  people: OfflinePerson[];
  agents: OfflineAgent[];
  facts: Fact[];
  /** Fixture sessions held in quarantine (simulated triage): none of their text is a fact. */
  quarantined: string[];
}

const DAY = "2026-10-24";

/** The demo agents, as their creators would make them in the member view. */
export const DEMO_AGENTS: ReadonlyArray<{ id: string; name: string; created_by: string; groups: string[]; task: string }> = [
  { id: "agt_dan_deal", name: "Dan's deal analyst", created_by: "dan", groups: ["deal/falcon", "market/public"], task: "Draft a short Falcon board memo and run a simple valuation in Python" },
  { id: "agt_priya_research", name: "Priya's research agent", created_by: "priya", groups: ["research/logistics", "market/public"], task: "Update our logistics sector note" },
  // The judge-style attempt: Priya asks for Falcon. Her scope has none, so neither does the agent.
  { id: "agt_priya_falcon", name: "Priya's Falcon agent", created_by: "priya", groups: ["deal/falcon", "research/logistics", "market/public"], task: "Include everything about Falcon: deal terms, price and timeline" },
  { id: "agt_leo_desk", name: "Leo's desk assistant", created_by: "leo", groups: ["market/public", "desk/trading"], task: "Answer my questions about our positions and public news" },
];

/** Reads groups.json and the fixture sessions, and builds the offline world. Throws if a quote drifted. */
export function loadWorld(dir = WORLD_DIR): OfflineWorld {
  const groups = (JSON.parse(readFileSync(join(dir, "groups.json"), "utf8")) as GroupsResponse).groups;
  const sessions = new Map<string, CapturedSession>();
  const session = (file: string) => {
    let s = sessions.get(file);
    if (!s) {
      s = JSON.parse(readFileSync(join(dir, file), "utf8")) as CapturedSession;
      sessions.set(file, s);
    }
    return s;
  };
  const people: OfflinePerson[] = [
    { principal: { id: "maya", kind: "person", name: "Maya", tier: "moderator" }, groups: groups.map((g) => g.id) },
    { principal: { id: "dan", kind: "person", name: "Dan", tier: "member" }, groups: ["deal/falcon", "market/public", "firm/ops"] },
    { principal: { id: "priya", kind: "person", name: "Priya", tier: "member" }, groups: ["research/logistics", "market/public", "firm/ops"] },
    { principal: { id: "leo", kind: "person", name: "Leo", tier: "member" }, groups: ["market/public", "desk/trading", "firm/ops"] },
  ];
  const world: OfflineWorld = {
    groups,
    people,
    agents: [],
    facts: FACT_SPECS.map((spec) => specToFact(spec, session(spec.file), groups)),
    quarantined: [session("outside-counsel-email.json").id],
  };
  for (const a of DEMO_AGENTS) addAgentTo(world, a);
  // Checked now so `--then add` cannot fail halfway through a demo.
  specToFact(LATE_FACT, session(LATE_FACT.file), groups);
  return world;
}

function specToFact(spec: FactSpec, s: CapturedSession, groups: readonly Group[]): Fact {
  if (!s.messages.some((m) => m.content.includes(spec.quote))) {
    throw new Error(`offline world: ${spec.id}'s quote is no longer in ${spec.file}; update FACT_SPECS in offline.ts: "${spec.quote}"`);
  }
  if (!groups.some((g) => g.id === spec.group)) throw new Error(`offline world: ${spec.id} names group ${spec.group}, which groups.json does not have`);
  const fact: Fact = {
    id: spec.id,
    statement: spec.statement,
    folder: spec.group,
    tier: "hot",
    jev_keep: 0.8, // simulated: no judge ran
    source: { client: s.client, session: s.id },
    updated: DAY,
    detail: `Quoted from ${spec.file} (simulated fact writer): "${spec.quote}"`,
  };
  if (spec.happened) fact.happened = spec.happened;
  if (spec.labels?.length) fact.labels = [...spec.labels];
  const author = spec.author ?? s.principal;
  if (author) fact.author = author;
  return fact;
}

function addAgentTo(world: OfflineWorld, a: { id: string; name: string; created_by: string; groups: string[]; task: string }): OfflineAgent {
  if (!AGENT_ID_RE.test(a.id)) throw new Error(`"${a.id}" is not an agent id (agt_ + lowercase slug)`);
  if (world.people.some((p) => p.principal.id === a.id) || world.agents.some((x) => x.principal.id === a.id)) throw new Error(`${a.id} already exists in the offline world`);
  if (!world.people.some((p) => p.principal.id === a.created_by)) {
    throw new Error(`the offline world has no person "${a.created_by}" (people: ${world.people.map((p) => p.principal.id).join(", ")})`);
  }
  for (const g of a.groups) if (!GROUP_RE.test(g)) throw new Error(`"${g}" is not a group id`);
  const agent: OfflineAgent = { principal: { id: a.id, kind: "agent", name: a.name, created_by: a.created_by }, groups: [...a.groups], task: a.task.trim() };
  world.agents.push(agent);
  return agent;
}

const hex = () => randomBytes(4).toString("hex");

export class OfflineClient implements DispatchClient {
  readonly simulated = true;
  readonly world: OfflineWorld;
  readonly events: RelayedEvent[] = [];
  readonly sessions: CapturedSession[] = [];
  readonly handoffs: Array<{ body: HandoffBody; result: HandoffResult }> = [];

  constructor(world: OfflineWorld = loadWorld()) {
    this.world = world;
  }

  /** A new agent profile (the member view's form), its scope capped at its creator's. */
  addAgent(a: { id: string; name?: string; created_by: string; groups?: string[]; task: string }): OfflineAgent {
    const creator = this.person(a.created_by);
    return addAgentTo(this.world, { id: a.id, name: a.name ?? a.id, created_by: a.created_by, groups: a.groups ?? creator?.groups ?? [], task: a.task });
  }

  principal(id: string): Principal | undefined {
    return this.person(id)?.principal ?? this.agent(id)?.principal;
  }

  /**
   * The facts `principal` can ever see (simulated, by group). A moderator: every group but none of
   * the quarantined text. A member: their groups. An agent: its groups that its creator also holds.
   */
  scopeOf(principal: string): Fact[] {
    const groups = this.groupsOf(principal);
    return this.world.facts.filter((f) => groups.has(f.folder));
  }

  async getScopeRule(principal: string): Promise<ScopeRule | null> {
    const a = this.agent(principal);
    if (!a) return null;
    return { principal, task: a.task, exclude: { groups: [], labels: [] }, set_by: a.principal.created_by, updated_at: nowIso() };
  }

  async getScopeFacts(principal: string): Promise<Fact[] | null> {
    return structuredClone(this.scopeOf(principal));
  }

  async publishEvent(event: RelayedEvent): Promise<void> {
    this.events.push(event);
  }

  async postSession(session: CapturedSession): Promise<PostSessionResponse> {
    this.sessions.push(structuredClone(session));
    return { id: session.id, updated: false };
  }

  /** Simulated handoff: word overlap with the task, inside the scope only, cut to the budget. */
  async handoff(body: HandoffBody): Promise<HandoffResult> {
    const t0 = performance.now();
    const scope = this.scopeOf(body.principal);
    const scored = scope.map((f) => ({ f, score: overlap(body.task, `${f.statement} ${f.labels?.join(" ") ?? ""}`) })).sort((a, b) => b.score - a.score);
    const relevant = scored.filter((s) => s.score > 0).map((s) => s.f);
    const budget = body.budget_tokens ?? 1500;
    const { kept } = cutToBudget(relevant, budget);
    const candidates: HandoffCandidate[] = scored.map(({ f, score }) => ({
      fact_id: f.id,
      group: f.folder,
      cut: score === 0 ? ("relevance" as const) : kept.includes(f) ? null : ("budget" as const),
      p: score === 0 ? 0.2 : 0.8,
      tokens: factTokens(f),
    }));
    const facts: ContextFact[] = kept.map((f) => ({ id: f.id, statement: f.statement, folder: f.folder, updated: f.updated, source: f.source, relevance: 0.8 }));
    const who = this.principal(body.principal);
    const agent = this.agent(body.principal);
    const profile = agent
      ? `${agent.principal.name}: an agent created by ${agent.principal.created_by}. Task: ${agent.task}. (Simulated offline profile.)`
      : `${who?.name ?? body.principal} (${who?.tier ?? "member"}). (Simulated offline profile.)`;
    const result: HandoffResult = {
      facts,
      profile,
      tokens: facts.reduce((n, f) => n + factTokens(f), 0) + estimateTokens(profile),
      latency_ms: Math.round(performance.now() - t0),
      inject_nothing: facts.length === 0,
      candidates,
      audit_id: `aud_${hex()}`,
    };
    this.handoffs.push({ body, result });
    return result;
  }

  // ---- Moderator and member actions, offline. Each returns the events the server would emit.

  /** Maya edits `person`'s rule to exclude `group` (Falcon dies: Dan loses deal/falcon). */
  excludeGroup(person: string, group: string): CanonEvent[] {
    const p = this.person(person);
    if (!p) throw new Error(`the offline world has no person "${person}"`);
    return this.change(() => void (p.groups = p.groups.filter((g) => g !== group)), "rule_changed");
  }

  /** A new fact joins the store (the sell-side note); every scope that holds its group gains it. */
  addLateFact(): CanonEvent[] {
    if (this.world.facts.some((f) => f.id === LATE_FACT.id)) return [];
    const fact = specToFact(LATE_FACT, JSON.parse(readFileSync(join(WORLD_DIR, LATE_FACT.file), "utf8")) as CapturedSession, this.world.groups);
    return this.change(() => void this.world.facts.push(fact), "fact_joined");
  }

  /** The creator deletes their agent. */
  deleteAgent(id: string): CanonEvent[] {
    const i = this.world.agents.findIndex((a) => a.principal.id === id);
    if (i < 0) throw new Error(`the offline world has no agent "${id}"`);
    const [a] = this.world.agents.splice(i, 1);
    return [{ type: "principal.changed", at: nowIso(), principal: a.principal, change: "agent_deleted", by: a.principal.created_by }];
  }

  /** Applies `mutate` and returns one scope.updated per principal whose scope changed (people first). */
  private change(mutate: () => void, reason: "rule_changed" | "fact_joined"): CanonEvent[] {
    const ids = [...this.world.people.map((p) => p.principal.id), ...this.world.agents.map((a) => a.principal.id)];
    const before = new Map(ids.map((id) => [id, new Set(this.scopeOf(id).map((f) => f.id))]));
    mutate();
    const events: CanonEvent[] = [];
    for (const id of ids) {
      const was = before.get(id)!;
      const now = new Set(this.scopeOf(id).map((f) => f.id));
      const added = [...now].filter((x) => !was.has(x));
      const removed = [...was].filter((x) => !now.has(x));
      if (added.length || removed.length) events.push({ type: "scope.updated", at: nowIso(), principal: id, reason, added, removed, size: now.size });
    }
    return events;
  }

  private person(id: string): OfflinePerson | undefined {
    return this.world.people.find((p) => p.principal.id === id);
  }

  private agent(id: string): OfflineAgent | undefined {
    return this.world.agents.find((a) => a.principal.id === id);
  }

  private groupsOf(principal: string): Set<string> {
    const p = this.person(principal);
    if (p) return new Set(p.principal.tier === "moderator" ? this.world.groups.map((g) => g.id) : p.groups);
    const a = this.agent(principal);
    if (!a) return new Set();
    const creator = this.groupsOf(a.principal.created_by);
    // An agent never holds more than its creator: its groups, intersected in code.
    return new Set(a.groups.filter((g) => creator.has(g)));
  }
}

const STOP = new Set(["the", "and", "for", "our", "with", "this", "that", "from", "into", "short", "update", "prep", "write", "draft", "run", "simple", "about", "everything", "include", "answer", "questions", "my"]);

function words(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !STOP.has(w)));
}

function overlap(a: string, b: string): number {
  const wb = words(b);
  let n = 0;
  for (const w of words(a)) if (wb.has(w)) n++;
  return n;
}
