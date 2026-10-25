// An in-browser stand-in for Canon as a moderator sees it: the whole synthetic world from
// fixtures/world at the start of the demo. Like the member mock, it plays Canon's part with
// labelled simulations (keyword overlap for Moss and Jev, sentence splitting for the fact writer,
// timed steps for Droid) and returns only contract shapes. This bundle holds every group, deal
// facts included, which is fine for the moderator page and is why it is a separate entry point
// from the member view.

import world from "../../../fixtures/world/world.json" with { type: "json" };
import expected from "../../../fixtures/world/expected.json" with { type: "json" };
import axeChatgpt from "../../../fixtures/world/items/itm_axe_chatgpt.json" with { type: "json" };
import chatDeal from "../../../fixtures/world/items/itm_chat_deal.json" with { type: "json" };
import chatDesk from "../../../fixtures/world/items/itm_chat_desk.json" with { type: "json" };
import chatGeneral from "../../../fixtures/world/items/itm_chat_general.json" with { type: "json" };
import chatResearch from "../../../fixtures/world/items/itm_chat_research.json" with { type: "json" };
import counselEmail from "../../../fixtures/world/items/itm_counsel_email.json" with { type: "json" };
import deskNotes from "../../../fixtures/world/items/itm_desk_notes.json" with { type: "json" };
import researchDraft from "../../../fixtures/world/items/itm_research_draft.json" with { type: "json" };
import swMeeting from "../../../fixtures/world/items/itm_sw_meeting.json" with { type: "json" };
import swTerms from "../../../fixtures/world/items/itm_sw_terms.json" with { type: "json" };
import swValuation from "../../../fixtures/world/items/itm_sw_valuation.json" with { type: "json" };
import tmcLetter from "../../../fixtures/world/items/itm_tmc_q3_letter.json" with { type: "json" };
import voicemail from "../../../fixtures/world/items/itm_voicemail.json" with { type: "json" };

import type { AgentRun, DocType, Fact, ItemKind } from "../member/contract.ts";
import { sentences, writeDoc } from "../member/mock.ts";
import { docLabel } from "../member/logic.ts";
import { INBOX } from "./contract.ts";
import type { AddItemAsModerator, AuditEntry, BuildStage, Group, Handoff, HeldItem, ModEvent, ModPrincipal, ModeratorApi, ScopeRule } from "./contract.ts";

interface RawItem { id: string; kind: string; source: string; author: string; captured_at: string; text: string }
interface KeyFact { group: string; labels: string[]; statement: string; fact_id: string; announced: boolean }

const ITEMS: Record<string, RawItem> = Object.fromEntries(
  [axeChatgpt, chatDeal, chatDesk, chatGeneral, chatResearch, counselEmail, deskNotes, researchDraft, swMeeting, swTerms, swValuation, tmcLetter, voicemail].map((i) => [i.id, i as RawItem]),
);
const KEY = expected.facts as Record<string, KeyFact>;
const KEY_ITEMS = expected.items as Record<string, { facts: string[] }>;
const SEED_ITEMS = world.timeline.find((t) => t.at === "seed")!.items!;
const LIVE_ITEMS = world.timeline.find((t) => t.at === "0:25")!.items!;

/** The three items that arrive live at 0:25, for the console's "Load a demo item" picker. */
export const DEMO_ITEMS = LIVE_ITEMS.map((id) => {
  const i = ITEMS[id]!;
  return { id, kind: i.kind as ItemKind, source: i.source, author: i.author, text: i.text };
});

/** Documents each seeded agent makes. */
const AGENT_DOCS: Record<string, DocType[]> = { "deal-analyst": ["memo", "compare", "dates"], "research-analyst": ["memo", "trends", "compare", "dates"], "desk-assistant": ["summary", "snapshot"] };

const STOP = new Set(["the", "and", "what", "are", "about", "for", "our", "any", "anything", "with", "from", "that", "this", "into", "your", "update", "write", "draft", "everything", "include", "all", "plus", "run", "answer", "questions", "my"]);
const PLANTED = /ignore (all|any|your|previous)|ai assistant|automated system|disregard (your|all)/i;
export const KEEP = 0.45;
/** Token budget per handoff in the mock (labelled on screen as a mockup setting). */
export const BUDGET = 160;

export function stems(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9$.]+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.slice(0, 5));
}

export function excludedGroup(id: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => p === id || (p.endsWith("/*") && id.startsWith(p.slice(0, -1))));
}

/** Simulated triage: a group for the sentence, or the inbox when nothing points anywhere. */
export function classify(text: string): string {
  const l = text.toLowerCase();
  if (/stonewall|tender offer|bid |takeover|walk-away|standstill/.test(l)) return "deal/stonewall";
  if (/office|offsite|expense|holiday|badge/.test(l)) return "firm/ops";
  if (/position|shares at|trimmed|basket/.test(l)) return "desk/dollar-bill";
  if (/letter|filing|announc|closed at|press release|shareholder/.test(l)) return "market/public";
  if (/asset manager|outflow|inflow|fee|multiple|forward earnings|sector/.test(l)) return "research/asset-managers";
  return INBOX;
}

const tokens = (f: Fact) => Math.ceil(f.statement.length / 4);
const err = (status: number, message: string) => Object.assign(new Error(message), { status });

export interface ModMockOptions { stepMs?: number; buildMs?: number; triageMs?: number }

export class ModeratorMock implements ModeratorApi {
  readonly mode = "mock" as const;
  private groupList: Group[] = world.groups.map((g) => ({ id: g.id, name: g.display, description: g.description }));
  private store: Fact[] = [];
  private people: ModPrincipal[] = [];
  private runs = new Map<string, AgentRun>();
  private held: (HeldItem & { text: string })[] = [];
  private handoffLog: Handoff[] = [];
  private auditLog: AuditEntry[] = [];
  private log: ModEvent[] = [];
  private listeners = new Set<(ev: ModEvent) => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>[]>();
  private seq = 0;
  private readonly stepMs: number;
  private readonly buildMs: number;
  private readonly triageMs: number;

  constructor(opts: ModMockOptions = {}) {
    this.stepMs = opts.stepMs ?? 650;
    this.buildMs = opts.buildMs ?? 450;
    this.triageMs = opts.triageMs ?? 1200;
    const seen = new Set<string>();
    for (const itemId of SEED_ITEMS) {
      const item = ITEMS[itemId]!;
      for (const key of KEY_ITEMS[itemId]!.facts) {
        if (seen.has(key)) continue;
        seen.add(key);
        this.store.push(this.fact(KEY[key]!.fact_id, KEY[key]!.statement, KEY[key]!.group, KEY[key]!.labels, item.id, item.kind as ItemKind, item.source, item.author, item.captured_at));
      }
      this.log.push({ type: "item.captured", at: item.captured_at, item_id: item.id, kind: item.kind as ItemKind, source: item.source, author: item.author });
    }

    const rules = new Map(world.scope_rules.map((r) => [r.principal, r]));
    for (const p of world.principals) {
      const r = rules.get(p.id);
      // The timeline seeds Ben without a scope; Wags builds it live at 0:40.
      const rule: ScopeRule | null = p.id === "ben" || !r ? null : { task: r.task, exclusions: { groups: [...r.exclusions.groups], labels: [], text: [] } };
      this.people.push({ id: p.id, kind: p.kind as "person" | "agent", name: p.name, tier: (p as { tier?: "moderator" | "member" }).tier, creator: (p as { creator?: string }).creator, rule, fact_ids: [] });
    }
    const memo = new Map<string, string[]>();
    for (const p of this.people) p.fact_ids = this.fresh(p, memo);
    const seedAt = "2026-10-23T23:00:00.000Z";
    for (const p of this.people.filter((x) => x.rule)) this.auditLog.push({ at: seedAt, principal: p.id, group: null, text: `${p.name}’s scope built from its rule: ${p.fact_ids.length} facts` });
    for (const p of this.people.filter((x) => x.kind === "agent")) {
      this.runs.set(p.id, {
        id: p.id, creator: p.creator!, name: p.name, status: "ready", steps: [], files: [], inbox: [],
        task: p.rule?.task ?? "", leave_out: "", docs: AGENT_DOCS[p.id] ?? ["summary"], schedule: "Only when I press Run",
        outputs: [], finished_at: null, fact_count: p.fact_ids.length, pending: 0,
      });
    }
    // 0:00: Dollar Bill's question to his desk assistant, answered from inside its scope.
    const h = this.handoff("desk-assistant", "Anything going on with Taylor Mason Capital? Should we add to our position?");
    this.log.push({ type: "context.served", at: h.at, handoff: h });
  }

  private fact(id: string, statement: string, group: string, labels: string[], source: string, kind: ItemKind, title: string, author: string, at: string): Fact {
    return { id, statement, group, labels: [...labels], source, author, happened_at: at, learned_at: at, status: "hot", source_kind: kind, source_title: title };
  }

  private now(): string { return new Date().toISOString(); }
  private nid(prefix: string): string { this.seq += 1; return `${prefix}_${(0x7000 + this.seq).toString(16)}`; }
  private group(id: string): Group | undefined { return this.groupList.find((g) => g.id === id); }
  private gname(id: string): string { return id === INBOX ? "the inbox" : this.group(id)?.name ?? id; }
  private person(id: string): ModPrincipal { const p = this.people.find((x) => x.id === id); if (!p) throw err(404, "not found"); return p; }
  private hot(): Fact[] { return this.store.filter((f) => f.status === "hot"); }

  private emit(ev: ModEvent): void {
    this.log.push(ev);
    if (this.log.length > 100) this.log.shift();
    for (const l of this.listeners) l(ev);
  }

  private record(text: string, principal: string | null = null, group: string | null = null): void {
    this.auditLog.push({ at: this.now(), principal, group, text });
  }

  private later(key: string, ms: number, fn: () => void): void {
    const list = this.timers.get(key) ?? [];
    list.push(setTimeout(fn, ms));
    this.timers.set(key, list);
  }

  private clear(key: string): void {
    (this.timers.get(key) ?? []).forEach(clearTimeout);
    this.timers.set(key, []);
  }

  private haystack(f: Fact): string {
    const g = this.group(f.group);
    return `${f.statement} ${g ? `${g.name} ${g.description}` : ""}`.toLowerCase().replace(/\btmc\b/g, "tmc taylor mason");
  }

  private overlap(f: Fact, words: readonly string[]): number {
    const h = this.haystack(f);
    return words.filter((w) => h.includes(w)).length;
  }

  /** Simulated relevance, rounded so 0.15 + 0.3 reaches the 0.45 threshold. */
  relevance(f: Fact, words: readonly string[]): number {
    return words.length ? Math.min(0.95, Math.round((0.15 + 0.3 * this.overlap(f, words)) * 100) / 100) : 0;
  }

  /** A scope built from scratch: moderators get everything; others get their groups, then relevance; agents only from their creator. */
  private fresh(p: ModPrincipal, memo: Map<string, string[]>): string[] {
    if (memo.has(p.id)) return memo.get(p.id)!;
    let out: string[] = [];
    if (p.kind === "person" && p.tier === "moderator") out = this.hot().map((f) => f.id);
    else if (p.rule) {
      const base = p.kind === "agent" ? this.hot().filter((f) => this.fresh(this.person(p.creator!), memo).includes(f.id)) : this.hot();
      const tw = stems(p.rule.task);
      out = base.filter((f) => f.group !== INBOX && !excludedGroup(f.group, p.rule!.exclusions.groups) && this.relevance(f, tw) >= KEEP).map((f) => f.id);
    }
    memo.set(p.id, out);
    return out;
  }

  /**
   * Living scopes: a new or refiled fact joins every scope its rule fits; a fact leaves only when
   * its group is excluded, it is retired, or the creator's scope loses it. Only `rebuild` (whose
   * rule just changed) and its agents are rebuilt from scratch.
   */
  private recompute(why: string, rebuild?: string): void {
    const memo = new Map<string, string[]>();
    const byId = new Map(this.hot().map((f) => [f.id, f]));
    const at = this.now();
    const next = new Map<string, string[]>();
    for (const p of this.people) {
      const fresh = this.fresh(p, memo);
      const full = !!rebuild && (p.id === rebuild || p.creator === rebuild);
      let scope: string[];
      if (p.tier === "moderator" || full || !p.rule) scope = fresh;
      else {
        const kept = p.fact_ids.filter((id) => {
          const f = byId.get(id);
          return f && f.group !== INBOX && !excludedGroup(f.group, p.rule!.exclusions.groups) && (p.kind !== "agent" || (next.get(p.creator!) ?? []).includes(id));
        });
        scope = [...kept, ...fresh.filter((id) => !kept.includes(id))];
      }
      memo.set(p.id, scope);
      next.set(p.id, scope);
    }
    for (const p of this.people) {
      const scope = next.get(p.id)!;
      const added = scope.filter((id) => !p.fact_ids.includes(id));
      const removed = p.fact_ids.filter((id) => !scope.includes(id));
      p.fact_ids = scope;
      if (p.tier === "moderator" || (!added.length && !removed.length)) continue;
      for (const id of added) this.auditLog.push({ at, principal: p.id, group: byId.get(id)?.group ?? null, text: `${p.name}’s scope gained “${byId.get(id)?.statement}” · ${why}` });
      for (const id of removed) this.auditLog.push({ at, principal: p.id, group: null, text: `${p.name}’s scope lost “${this.store.find((f) => f.id === id)?.statement ?? id}” · ${why}` });
      this.emit({ type: "scope.changed", at, principal: p.id, added, removed });
      const run = this.runs.get(p.id);
      if (!run) continue;
      if (removed.length) this.narrowed(p.id, removed.length);
      else if (added.length) {
        run.pending += added.length;
        run.inbox = [...added.map((id) => ({ text: byId.get(id)!.statement, at })), ...run.inbox];
        this.emit({ type: "agent.inbox", at, run: this.snapshot(p.id) });
      }
    }
  }

  /** The agent lost facts: a running agent restarts, and documents built from the old scope are withdrawn. */
  private narrowed(id: string, lost: number): void {
    const run = this.runs.get(id)!;
    const wasRunning = run.status === "running";
    this.clear(id);
    const note = `Scope narrowed by ${lost} ${lost === 1 ? "fact" : "facts"}: earlier documents withdrawn`;
    Object.assign(run, { status: wasRunning ? "restarting" : "ready", outputs: [], files: [], steps: [{ id: this.nid("stp"), text: note, status: "done", at: this.now() }] });
    this.emit({ type: wasRunning ? "agent.restarted" : "agent.step", at: this.now(), run: this.snapshot(id) });
    if (wasRunning) this.later(id, this.stepMs, () => { run.status = "ready"; this.emit({ type: "agent.step", at: this.now(), run: this.snapshot(id) }); });
  }

  private snapshot(id: string): AgentRun {
    const run = this.runs.get(id)!;
    run.fact_count = this.person(id).fact_ids.length;
    return structuredClone(run);
  }

  private handoff(agentId: string, request: string): Handoff {
    const a = this.person(agentId);
    const ws = stems(`${request} ${a.rule?.task ?? ""}`);
    let used = 0;
    const candidates = this.hot().filter((f) => a.fact_ids.includes(f.id))
      .map((f) => ({ f, p: this.relevance(f, ws) }))
      .sort((x, y) => y.p - x.p)
      .map(({ f, p }) => {
        let decision: Handoff["candidates"][number]["decision"];
        if (p < KEEP) decision = "cut_relevance";
        else if (used + tokens(f) > BUDGET) decision = "cut_budget";
        else { used += tokens(f); decision = "kept"; }
        return { fact_id: f.id, statement: f.statement, p, decision, tokens_est: tokens(f) };
      });
    const h: Handoff = { id: this.nid("hnd"), at: this.now(), principal: agentId, request, candidates, tokens_est: used, budget_est: BUDGET, timings_ms: { search: null, judge: null, total: null }, simulated: true };
    this.handoffLog.unshift(h);
    const kept = candidates.filter((c) => c.decision === "kept").length;
    this.record(`${a.name} was handed ${kept} facts for “${request}”`, agentId);
    return h;
  }

  // ---------- reads

  async me() { return { ...structuredClone(this.person(world.principals.find((p) => (p as { tier?: string }).tier === "moderator")!.id)), firm: world.firm.name }; }
  async principals() { return structuredClone(this.people); }
  async groups() { return structuredClone(this.groupList); }
  async facts() { return structuredClone(this.hot()); }
  async quarantine() { return this.held.map(({ text: _text, ...h }) => ({ ...h })); }
  async agents() { return [...this.runs.keys()].map((id) => this.snapshot(id)); }
  async handoffs() { return structuredClone(this.handoffLog); }
  async audit() { return structuredClone(this.auditLog); }

  // ---------- commands

  async createGroup(name: string, description: string): Promise<Group> {
    const clean = name.trim();
    if (!clean) throw err(400, "a group needs a name");
    if (this.groupList.some((g) => g.name.toLowerCase() === clean.toLowerCase())) throw err(409, `a group named “${clean}” already exists`);
    const g: Group = { id: `custom/${clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`, name: clean, description: description.trim() };
    this.groupList.push(g);
    // Rules list what is excluded, so a new group joins every rule's exclusions: it reaches no one until Compliance adds it.
    for (const p of this.people) if (p.rule) p.rule.exclusions.groups.push(g.id);
    this.record(`Created the group “${clean}”`, null, g.id);
    this.emit({ type: "group.created", at: this.now(), group: structuredClone(g) });
    return structuredClone(g);
  }

  async addPerson(name: string, tier: "moderator" | "member"): Promise<ModPrincipal> {
    const p: ModPrincipal = { id: this.nid("p"), kind: "person", name: name.trim(), tier, rule: null, fact_ids: tier === "moderator" ? this.hot().map((f) => f.id) : [] };
    this.people.push(p);
    this.record(`Added ${p.name} as ${tier === "moderator" ? "Compliance" : "Member"}`, p.id);
    this.emit({ type: "principal.added", at: this.now(), principal: structuredClone(p) });
    return structuredClone(p);
  }

  async setTier(id: string, tier: "moderator" | "member"): Promise<void> {
    const p = this.person(id);
    p.tier = tier;
    this.record(`${p.name} is now ${tier === "moderator" ? "Compliance" : "Member"}`, id);
    this.recompute("tier changed", id);
    this.emit({ type: "principal.tier", at: this.now(), principal: structuredClone(p) });
  }

  async setRule(id: string, rule: ScopeRule): Promise<{ build_id: string }> {
    const p = this.person(id);
    p.rule = structuredClone(rule);
    if (this.runs.has(id)) this.runs.get(id)!.task = rule.task;
    this.record(`Set ${p.name}’s rule: “${rule.task}”`, id);
    const buildId = this.nid("bld");
    const base = p.kind === "agent" ? this.hot().filter((f) => this.person(p.creator!).fact_ids.includes(f.id)) : this.hot().filter((f) => f.group !== INBOX);
    const tw = stems(rule.task);
    const afterEx = base.filter((f) => !excludedGroup(f.group, rule.exclusions.groups));
    const removedGroups = [...new Set(base.filter((f) => !afterEx.includes(f)).map((f) => this.gname(f.group)))];
    const cands = afterEx.filter((f) => this.overlap(f, tw) > 0);
    const kept = cands.filter((f) => this.relevance(f, tw) >= KEEP);
    const stages: [BuildStage, Record<string, number>, string[]?][] = [
      ["exclusions", { removed: base.length - afterEx.length }, removedGroups],
      ["candidates", { candidates: cands.length }],
      ["judged", { yes: kept.length, no: cands.length - kept.length }],
      ["done", { facts: kept.length }],
    ];
    this.clear(`build:${id}`);
    stages.forEach(([stage, counts, groups], i) => {
      this.later(`build:${id}`, this.buildMs * (i + 1), () => {
        if (stage === "done") this.recompute("rule saved", id);
        this.emit({ type: "scope.build", at: this.now(), build_id: buildId, principal: id, stage, counts, ...(groups ? { groups_removed: groups } : {}) });
      });
    });
    return { build_id: buildId };
  }

  async fileFacts(ids: string[], group: string): Promise<void> {
    if (!this.group(group)) throw err(404, "no such group");
    const moving = this.hot().filter((f) => ids.includes(f.id) && f.group !== group);
    if (!moving.length) return;
    const from = [...new Set(moving.map((f) => this.gname(f.group)))];
    for (const f of moving) f.group = group;
    this.record(`Filed ${moving.length} ${moving.length === 1 ? "fact" : "facts"} from ${from.join(", ")} to ${this.gname(group)}`, null, group);
    this.emit({ type: "fact.filed", at: this.now(), fact_ids: moving.map((f) => f.id), group, from });
    this.recompute(`filed to ${this.gname(group)}`);
  }

  async editFact(id: string, statement: string): Promise<Fact> {
    const f = this.hot().find((x) => x.id === id);
    if (!f) throw err(404, "not found");
    f.statement = statement;
    this.record(`Edited “${statement}”`, null, f.group);
    return structuredClone(f);
  }

  async retireFact(id: string): Promise<void> {
    const f = this.hot().find((x) => x.id === id);
    if (!f) throw err(404, "not found");
    f.status = "cold";
    this.record(`Retired “${f.statement}”`, null, f.group);
    this.recompute("retired");
  }

  async addItem(body: AddItemAsModerator): Promise<{ item_id: string }> {
    const id = this.nid("itm");
    const source = body.source.trim() || body.kind;
    const at = this.now();
    if (PLANTED.test(body.text)) {
      const reason = "Contains instructions aimed at an AI";
      this.held.push({ id, kind: body.kind, source, author: body.author, reason, at, text: body.text });
      this.record(`Quarantined “${source}” from ${this.person(body.author).name}`);
      this.emit({ type: "item.quarantined", at, item_id: id, source, reason });
      return { item_id: id };
    }
    this.emit({ type: "item.captured", at, item_id: id, kind: body.kind, source, author: body.author });
    this.later("triage", this.triageMs, () => this.triage(id, body.kind, source, body.author, body.text));
    return { item_id: id };
  }

  /** A demo item (pasted unchanged) files the answer key's facts; anything else is split and guessed. */
  private triage(itemId: string, kind: ItemKind, source: string, author: string, text: string): void {
    const demo = DEMO_ITEMS.find((d) => d.text.trim() === text.trim());
    const at = this.now();
    const drafts = demo
      ? KEY_ITEMS[demo.id]!.facts.map((k) => ({ id: KEY[k]!.fact_id, statement: KEY[k]!.statement, group: KEY[k]!.group, labels: KEY[k]!.labels }))
      : sentences(text).map((s) => ({ id: this.nid("fct"), statement: s, group: classify(s), labels: [] as string[] }));
    const fresh = drafts.filter((d) => !this.store.some((f) => f.id === d.id && f.status === "hot"))
      .map((d) => this.fact(d.id, d.statement, d.group, d.labels, itemId, kind, source, author, at));
    this.store = [...fresh, ...this.store.filter((f) => !fresh.some((n) => n.id === f.id))];
    for (const f of fresh) this.emit({ type: "fact.saved", at, fact: structuredClone(f) });
    this.recompute("new item");
  }

  async release(id: string): Promise<void> {
    const item = this.held.find((h) => h.id === id);
    if (!item) throw err(404, "not found");
    this.held = this.held.filter((h) => h.id !== id);
    const demo = DEMO_ITEMS.find((d) => d.text.trim() === item.text.trim());
    const facts = demo ? KEY_ITEMS[demo.id]!.facts.length : sentences(item.text).length;
    this.record(`Released “${item.source}” from quarantine`);
    this.emit({ type: "item.released", at: this.now(), item_id: id, source: item.source, facts });
    if (facts) this.later("triage", this.triageMs, () => this.triage(id, item.kind, item.source, item.author, item.text.replace(PLANTED, "")));
  }

  async runAgent(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run) throw err(404, "not found");
    if (run.status === "running" || run.status === "restarting") throw err(409, "busy");
    const docs = run.docs.length ? run.docs : (["summary"] as DocType[]);
    const texts = ["Asking Bullwark for context", `Reading ${this.person(id).fact_ids.length} facts in its folder`, ...docs.map((d) => `Writing ${docLabel(d).toLowerCase()}`)];
    this.clear(id);
    Object.assign(run, { status: "running", steps: [], pending: 0 });
    this.emit({ type: "agent.started", at: this.now(), run: this.snapshot(id) });
    texts.forEach((text, i) => {
      this.later(id, this.stepMs * (i + 1), () => {
        const at = this.now();
        if (i === 0) this.emit({ type: "context.served", at, handoff: structuredClone(this.handoff(id, run.task || run.name)) });
        run.steps = [...run.steps.map((s) => ({ ...s, status: "done" as const })), { id: this.nid("stp"), text, status: "running", at }];
        this.emit({ type: "agent.step", at, run: this.snapshot(id) });
      });
    });
    this.later(id, this.stepMs * (texts.length + 1), () => {
      const at = this.now();
      const mine = this.hot().filter((f) => this.person(id).fact_ids.includes(f.id));
      const outputs = docs.map((d) => writeDoc(d, mine, [], docs));
      Object.assign(run, {
        status: "done", outputs, finished_at: at, files: outputs.map((o) => `${o.type}.md`), inbox: [],
        steps: [...run.steps.map((s) => ({ ...s, status: "done" as const })), { id: this.nid("stp"), text: `Finished · made ${outputs.length} documents`, status: "done", at }],
      });
      this.emit({ type: "agent.finished", at, run: this.snapshot(id) });
    });
  }

  async stopAgent(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run || run.status !== "running") return;
    this.clear(id);
    run.status = "stopped";
    this.record(`Compliance stopped ${run.name}`, id);
    this.emit({ type: "agent.finished", at: this.now(), run: this.snapshot(id) });
  }

  subscribe(onEvent: (ev: ModEvent) => void, onStatus: (s: "connecting" | "live" | "reconnecting") => void): () => void {
    onStatus("live");
    for (const ev of this.log) onEvent(ev);
    this.listeners.add(onEvent);
    return () => this.listeners.delete(onEvent);
  }
}
