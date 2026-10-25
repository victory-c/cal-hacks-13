// An in-browser stand-in for Canon, so the member view runs before the contract routes exist
// (PRD requirement 17). It plays Canon's part with labelled simulations: keyword overlap stands in
// for Moss and Jev, sentence splitting for the fact writer, and timed steps for Droid. Everything
// it returns follows docs/INTEGRATION.md, so switching to Canon is `?data=canon`.

import type { AddItemBody, AgentBody, AgentOutput, AgentRun, DocType, Fact, Me, MemberApi, MemberEvent, ScopeExclusions } from "./contract.ts";
import { GROUP_NAMES, ITEMS, ME, seedAgents, seedFacts } from "./fixture.ts";
import { docLabel } from "./logic.ts";

const STOP = new Set(["the", "and", "what", "are", "about", "for", "our", "any", "anything", "with", "from", "that", "this", "into", "your", "update", "write", "draft", "everything", "include", "all"]);
const MONTHS = /(january|february|march|april|may|june|july|august|september|october|november|december)/i;
const PLANTED = /ignore (all|any|previous)|ai assistant|automated system|disregard (your|all)/i;

/** Lower-cased five-letter stems of the meaningful words in `text`. */
export function stems(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9$.]+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.slice(0, 5));
}

function haystack(f: Fact): string {
  return `${f.statement} ${GROUP_NAMES[f.group] ?? f.group}`.toLowerCase().replace(/\btmc\b/g, "tmc taylor mason");
}

function overlap(f: Fact, words: readonly string[]): number {
  const h = haystack(f);
  return words.filter((w) => h.includes(w)).length;
}

/** Simulated relevance: the share of task words a fact mentions, mapped onto 0.15–0.95. */
export function relevance(f: Fact, words: readonly string[]): number {
  // Rounded: 0.15 + 0.3 is 0.4499… in floating point, which would miss the 0.45 threshold.
  return words.length ? Math.min(0.95, Math.round((0.15 + 0.3 * overlap(f, words)) * 100) / 100) : 0;
}

export const KEEP = 0.45;

/** Builds an agent's scope from the member's facts: leave-out first (in code), then relevance. */
export function planScope(facts: readonly Fact[], task: string, leaveOut: string, exclusions?: ScopeExclusions) {
  const lw = stems(leaveOut), tw = stems(task);
  const left = facts.filter((f) => (lw.length && overlap(f, lw) > 0) ||
    exclusions?.groups.some((p) => f.group === p || f.group.startsWith(`${p.replace(/\/\*$/, "")}/`)) ||
    f.labels.some((label) => exclusions?.labels.includes(label)));
  const rest = facts.filter((f) => !left.includes(f));
  const candidates = rest.filter((f) => overlap(f, tw) > 0);
  const kept = candidates.filter((f) => relevance(f, tw) >= KEEP);
  return { left: left.length, candidates: candidates.length, kept: kept.map((f) => f.id) };
}

/** Which of the member's groups a pasted sentence belongs in (simulated triage). */
export function classify(sentence: string): string {
  const l = sentence.toLowerCase();
  if (/office|offsite|expense|holiday|badge/.test(l)) return "firm/ops";
  if (/letter|filing|announc|closed at|press release|10-q|earnings call|shareholder/.test(l)) return "market/public";
  return "research/asset-managers";
}

export function isPlanted(text: string): boolean {
  return PLANTED.test(text);
}

/** Splits pasted text into fact-sized sentences. */
export function sentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+/).map((s) => s.replace(/[.!?]+$/, "").trim()).filter((s) => s.length > 12);
  return parts.length ? parts : [text.trim()];
}

type Line = { text: string; source: string };

/** The lines of one document type from `facts`, or [] when the memory has nothing for it. */
function docLines(type: DocType, facts: readonly Fact[], fresh: readonly Fact[], chosen: readonly DocType[]): Line[] {
  const pick = (re: RegExp) => facts.filter((f) => re.test(f.statement));
  const line = (f: Fact, prefix = ""): Line => ({ text: prefix + f.statement, source: f.source_title ?? f.source });
  switch (type) {
    case "summary": return facts.slice(0, 4).map((f) => line(f));
    case "changes": return fresh.map((f) => line(f));
    case "trends": return pick(/outflow|down|fee|paused|%/i).map((f) => line(f));
    case "snapshot": return pick(/\btmc\b|taylor mason/i).map((f) => line(f));
    case "compare": return pick(/\d+(\.\d+)?x\b/).map((f) => line(f));
    case "dates": return pick(MONTHS).map((f) => line(f));
    case "plan":
      return [...pick(MONTHS).map((f) => line(f, "Prepare for: ")), ...facts.filter((f) => !MONTHS.test(f.statement)).slice(0, 2).map((f) => line(f, "Follow up on: "))];
    case "talking": return facts.slice(0, 3).map((f) => line(f));
    case "gaps":
      return chosen.filter((c) => c !== "gaps" && c !== "changes" && docLines(c, facts, fresh, []).length === 0)
        .map((c) => ({ text: `Nothing in memory yet for ${docLabel(c).toLowerCase()}`, source: "" }));
    case "memo": return facts.length ? [{ text: `${facts.slice(0, 5).map((f) => f.statement).join(". ")}.`, source: "" }] : [];
  }
}

/** One simulated document, built only from `facts` (the agent's own scope). */
export function writeDoc(type: DocType, facts: readonly Fact[], fresh: readonly Fact[], chosen: readonly DocType[]): AgentOutput {
  let lines = docLines(type, facts, fresh, chosen);
  if (!lines.length) {
    const empty = type === "changes" ? "No new memories since the last run" : type === "gaps" ? "Every document had something to work from" : "Nothing in this agent’s memory for this yet";
    lines = [{ text: empty, source: "" }];
  }
  return { type, title: docLabel(type), lines };
}

interface AgentState {
  run: AgentRun;
  factIds: string[];
  seen: string[];
  pendingIds: string[];
  timers: ReturnType<typeof setTimeout>[];
  exclusions: ScopeExclusions;
}

export interface MockOptions {
  /** Delay between agent steps. */
  stepMs?: number;
  /** Delay per scope-build stage. */
  buildMs?: number;
  /** Delay before a pasted item's facts arrive. */
  triageMs?: number;
  now?: () => number;
}

const err = (status: number, message: string) => Object.assign(new Error(message), { status });

export class MockCanon implements MemberApi {
  readonly mode = "mock" as const;
  private store: Fact[] = seedFacts();
  private agentsById = new Map<string, AgentState>();
  private log: MemberEvent[] = [];
  private listeners = new Set<(ev: MemberEvent) => void>();
  private seq = 0;
  private readonly stepMs: number;
  private readonly buildMs: number;
  private readonly triageMs: number;
  private readonly now: () => number;

  constructor(opts: MockOptions = {}) {
    this.stepMs = opts.stepMs ?? 700;
    this.buildMs = opts.buildMs ?? 350;
    this.triageMs = opts.triageMs ?? 1500;
    this.now = opts.now ?? Date.now;
    // The replay a new subscriber gets: Ben's own items, as Canon captured them.
    for (const i of ITEMS.filter((x) => x.author === ME.id)) {
      this.log.push({ type: "item.captured", at: i.captured_at, item_id: i.id, kind: i.kind, source: i.title, author: i.author });
    }
    for (const run of seedAgents()) {
      const plan = planScope(this.store, run.task, run.leave_out);
      this.agentsById.set(run.id, { run: { ...run, fact_count: plan.kept.length }, factIds: plan.kept, seen: [...plan.kept], pendingIds: [], timers: [], exclusions: { groups: [], labels: [], text: [] } });
    }
  }

  private at(): string {
    return new Date(this.now()).toISOString();
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${(0x9000 + this.seq).toString(16)}`;
  }

  private emit(ev: MemberEvent): void {
    this.log.push(ev);
    if (this.log.length > 100) this.log.shift();
    for (const l of this.listeners) l(ev);
  }

  private agent(id: string): AgentState {
    const a = this.agentsById.get(id);
    if (!a) throw err(404, "not found");
    return a;
  }

  private snapshot(a: AgentState): AgentRun {
    a.run = { ...a.run, fact_count: a.factIds.length, pending: a.pendingIds.length, memory_groups: this.memoryGroups(a) };
    return structuredClone(a.run);
  }

  /** Ben's own groups, and which ones this agent remembers, as Canon's member view reports them. */
  private memoryGroups(a: AgentState): NonNullable<AgentRun["memory_groups"]> {
    const groups = [...new Set(this.store.filter((f) => f.status === "hot").map((f) => f.group))];
    return groups.map((id) => ({
      id,
      name: GROUP_NAMES[id] ?? id,
      included: !a.exclusions.groups.some((p) => id === p || id.startsWith(`${p}/`)),
      count: this.store.filter((f) => f.group === id && a.factIds.includes(f.id)).length,
    }));
  }

  private later(a: AgentState, ms: number, fn: () => void): void {
    a.timers.push(setTimeout(fn, ms));
  }

  private clear(a: AgentState): void {
    a.timers.forEach(clearTimeout);
    a.timers = [];
  }

  async me(): Promise<Me> {
    return { ...ME };
  }

  async facts(): Promise<Fact[]> {
    return structuredClone(this.store.filter((f) => f.status === "hot"));
  }

  async groupNames(): Promise<Record<string, string>> {
    return { ...GROUP_NAMES };
  }

  async editFact(id: string, statement: string): Promise<Fact> {
    const f = this.store.find((x) => x.id === id && x.status === "hot");
    if (!f) throw err(404, "not found");
    f.statement = statement;
    return structuredClone(f);
  }

  async retireFact(id: string): Promise<void> {
    const f = this.store.find((x) => x.id === id && x.status === "hot");
    if (!f) throw err(404, "not found");
    f.status = "cold";
    for (const a of this.agentsById.values()) {
      if (!a.factIds.includes(id)) continue;
      a.factIds = a.factIds.filter((x) => x !== id);
      a.pendingIds = a.pendingIds.filter((x) => x !== id);
      const wasRunning = a.run.status === "running" || a.run.status === "restarting";
      this.clear(a);
      a.run = { ...a.run, status: wasRunning ? "restarting" : "ready", outputs: [], files: [], finished_at: null, inbox: a.run.inbox.filter((item) => item.text !== f.statement) };
      this.emit({ type: "scope.changed", at: this.at(), principal: a.run.id, added: [], removed: [id] });
      this.emit({ type: wasRunning ? "agent.restarted" : "agent.step", at: this.at(), run: this.snapshot(a) });
      if (wasRunning) this.later(a, this.stepMs, () => { a.run.status = "ready"; void this.runAgent(a.run.id); });
    }
  }

  async addItem(body: AddItemBody): Promise<{ item_id: string }> {
    const itemId = this.id("itm");
    const source = body.source.trim() || docKind(body.kind);
    this.emit({ type: "item.captured", at: this.at(), item_id: itemId, kind: body.kind, source, author: ME.id });
    // A planted instruction is quarantined. Members get no event for that, so it simply produces no facts.
    if (isPlanted(body.text)) return { item_id: itemId };
    setTimeout(() => this.triage(itemId, body, source), this.triageMs);
    return { item_id: itemId };
  }

  private triage(itemId: string, body: AddItemBody, source: string): void {
    const at = this.at();
    const fresh: Fact[] = sentences(body.text).map((s) => ({
      id: this.id("fct"), statement: s, group: classify(s), labels: [], source: itemId, author: ME.id,
      happened_at: at, learned_at: at, status: "hot", source_kind: body.kind, source_title: source,
    }));
    this.store.unshift(...fresh);
    for (const f of fresh) this.emit({ type: "fact.saved", at, fact: structuredClone(f) });
    // Living scopes: each new fact joins the member's agents whose rule it fits.
    for (const a of this.agentsById.values()) {
      const fits = fresh.filter((f) => planScope([f], a.run.task, a.run.leave_out, a.exclusions).kept.includes(f.id));
      if (!fits.length) continue;
      a.factIds.push(...fits.map((f) => f.id));
      a.pendingIds.push(...fits.map((f) => f.id));
      a.run.inbox = [...fits.map((f) => ({ text: f.statement, at })), ...a.run.inbox];
      this.emit({ type: "scope.changed", at, principal: a.run.id, added: fits.map((f) => f.id), removed: [] });
      this.emit({ type: "agent.inbox", at, run: this.snapshot(a) });
      if (a.run.schedule === "Whenever new memories arrive" && (a.run.status === "ready" || a.run.status === "done" || a.run.status === "stopped")) void this.runAgent(a.run.id);
    }
  }

  async agents(): Promise<AgentRun[]> {
    return [...this.agentsById.values()].map((a) => this.snapshot(a));
  }

  async createAgent(body: AgentBody): Promise<{ id: string; build_id: string }> {
    const id = this.id("agt");
    const run: AgentRun = {
      id, creator: ME.id, name: body.name, status: "building", steps: [], files: [], inbox: [],
      task: body.task, leave_out: body.exclusions.text.join("; "), docs: body.docs, schedule: body.schedule,
      outputs: [], finished_at: null, fact_count: 0, pending: 0,
    };
    const exclusions = structuredClone(body.exclusions);
    exclusions.groups = [...new Set([...exclusions.groups, ...(body.exclude_groups ?? [])])];
    const a: AgentState = { run, factIds: [], seen: [], pendingIds: [], timers: [], exclusions };
    this.agentsById.set(id, a);
    return { id, build_id: this.build(a) };
  }

  async updateAgent(id: string, body: AgentBody): Promise<{ build_id: string }> {
    const a = this.agent(id);
    const wasRunning = a.run.status === "running" || a.run.status === "restarting";
    this.clear(a);
    a.exclusions = { ...structuredClone(body.exclusions), groups: body.exclude_groups ? [...body.exclude_groups] : a.exclusions.groups };
    // Until the rebuilt scope exists, nothing from the old scope remains a usable document.
    a.run = { ...a.run, name: body.name, task: body.task, leave_out: body.exclusions.text.join("; "), docs: body.docs, schedule: body.schedule, outputs: [], files: [], finished_at: null, inbox: [] };
    if (wasRunning) {
      a.run.status = "restarting";
      this.emit({ type: "agent.restarted", at: this.at(), run: this.snapshot(a) });
    }
    return { build_id: this.build(a, wasRunning) };
  }

  /** Runs the four scope-build stages the contract streams as `scope.build`. */
  private build(a: AgentState, restart = false): string {
    const buildId = this.id("bld");
    const plan = planScope(this.store.filter((f) => f.status === "hot"), a.run.task, a.run.leave_out, a.exclusions);
    if (a.run.status !== "restarting") a.run.status = "building";
    const stages: [Extract<MemberEvent, { type: "scope.build" }>["stage"], Record<string, number>][] = [
      ["exclusions", { removed: plan.left }],
      ["candidates", { candidates: plan.candidates }],
      ["judged", { kept: plan.kept.length, cut: plan.candidates - plan.kept.length }],
      ["done", { facts: plan.kept.length }],
    ];
    stages.forEach(([stage, counts], i) => {
      this.later(a, this.buildMs * (i + 1), () => {
        if (stage === "done") {
          // A new memory may arrive between the first and last stage.
          a.factIds = planScope(this.store.filter((f) => f.status === "hot"), a.run.task, a.run.leave_out, a.exclusions).kept;
          a.seen = [];
          a.pendingIds = [];
          a.run.status = "ready";
          counts.facts = a.factIds.length;
        }
        this.emit({ type: "scope.build", at: this.at(), build_id: buildId, principal: a.run.id, stage, counts });
        if (stage === "done" && restart) void this.runAgent(a.run.id);
      });
    });
    return buildId;
  }

  async deleteAgent(id: string): Promise<void> {
    const a = this.agent(id);
    this.clear(a);
    this.agentsById.delete(id);
  }

  async runAgent(id: string, task?: string): Promise<void> {
    const a = this.agent(id);
    if (a.run.status === "building" || a.run.status === "restarting" || a.run.status === "running") throw err(409, "busy");
    this.clear(a);
    const assignment = task?.trim() || a.run.task;
    const tw = stems(assignment);
    const mine = this.store.filter((f) => f.status === "hot" && a.factIds.includes(f.id)).sort((x, y) => relevance(y, tw) - relevance(x, tw));
    const fresh = mine.filter((f) => !a.seen.includes(f.id));
    const consumed = new Set(mine.map((f) => f.id));
    const docs: DocType[] = a.run.docs.length ? a.run.docs : ["summary"];
    const texts = [`Reading ${mine.length} ${mine.length === 1 ? "memory" : "memories"}`];
    if (a.pendingIds.length) texts.push(`Picked up ${a.pendingIds.length} new ${a.pendingIds.length === 1 ? "memory" : "memories"}`);
    for (const d of docs) texts.push(`Writing ${docLabel(d).toLowerCase()}`);
    a.pendingIds = a.pendingIds.filter((id) => !consumed.has(id));
    a.run = { ...a.run, status: "running", steps: [], inbox: [], run_task: assignment, started_at: this.at(), documents: [], memories: [] };
    this.emit({ type: "agent.started", at: this.at(), run: this.snapshot(a) });
    texts.forEach((text, i) => {
      this.later(a, this.stepMs * (i + 1), () => {
        const at = this.at();
        a.run.steps = [...a.run.steps.map((s) => ({ ...s, status: "done" as const })), { id: this.id("stp"), text, status: "running", at }];
        this.emit({ type: "agent.step", at, run: this.snapshot(a) });
      });
    });
    this.later(a, this.stepMs * (texts.length + 1), () => {
      const at = this.at();
      const outputs = docs.map((d) => writeDoc(d, mine, fresh, docs));
      const documents = outputs.map((o) => ({ file: `out/${o.type}.md`, title: o.title, text: [`# ${o.title}`, "", ...o.lines.map((l) => `- ${l.text}`)].join("\n"), at }));
      const memories = [{ file: "out/memories/progress.md", text: `Made ${outputs.length === 1 ? "a document" : `${outputs.length} documents`} from ${mine.length} ${mine.length === 1 ? "memory" : "memories"} (simulated).`, at }];
      a.run = {
        ...a.run, status: "done", outputs, documents, memories, finished_at: at,
        steps: [...a.run.steps.map((s) => ({ ...s, status: "done" as const })), { id: this.id("stp"), text: `Finished · made ${outputs.length} ${outputs.length === 1 ? "document" : "documents"}`, status: "done", at }],
        files: outputs.map((o) => `${o.type}.md`),
      };
      a.seen = [...consumed];
      this.emit({ type: "agent.finished", at, run: this.snapshot(a) });
      if (a.pendingIds.length && a.run.schedule === "Whenever new memories arrive") void this.runAgent(a.run.id);
    });
  }

  async stopAgent(id: string): Promise<void> {
    const a = this.agent(id);
    if (a.run.status !== "running") return;
    this.clear(a);
    a.run = { ...a.run, status: "stopped" };
    this.emit({ type: "agent.finished", at: this.at(), run: this.snapshot(a) });
  }

  subscribe(onEvent: (ev: MemberEvent) => void, onStatus: (s: "connecting" | "live" | "reconnecting") => void): () => void {
    onStatus("live");
    for (const ev of this.log) onEvent(ev);
    this.listeners.add(onEvent);
    return () => this.listeners.delete(onEvent);
  }
}

function docKind(kind: AddItemBody["kind"]): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}
