// Pure helpers for the member view: filtering and grouping memory, labels, feed lines and agent
// status lines. No DOM, so they run under node:test.

import { relativeTime } from "../format.ts";
import { DOC_TYPES } from "./contract.ts";
import type { AgentRun, DocType, Fact, ItemKind, MemberEvent } from "./contract.ts";

export const ALL_GROUPS = "All groups";
export const ALL_SOURCES = "All sources";
export const SORTS = ["By group", "Newest first", "Oldest first"] as const;
export type Sort = (typeof SORTS)[number];

export interface Filters {
  keyword: string;
  group: string;
  source: string;
  sort: Sort;
}

export const NO_FILTERS: Filters = { keyword: "", group: ALL_GROUPS, source: ALL_SOURCES, sort: "By group" };

/** True when anything narrows or reorders the list (the Filter button then says "(on)"). */
export function filtersActive(f: Filters): boolean {
  return f.keyword.trim() !== "" || f.group !== ALL_GROUPS || f.source !== ALL_SOURCES || f.sort !== NO_FILTERS.sort;
}

/** "research/asset-managers" → the display name, else a readable version of the last segment. */
export function groupLabel(id: string, names: Record<string, string>): string {
  if (names[id]) return names[id];
  const last = id.split("/").pop() ?? id;
  return last.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function sourceTitle(f: Fact): string {
  return f.source_title ?? f.source;
}

const KIND_LABELS: Record<ItemKind, string> = { memo: "Memo", chat: "Chat", email: "Email", transcript: "Transcript", note: "Note", session: "AI chat" };

/** The provenance tag in front of a memory. */
export function kindLabel(kind: ItemKind | undefined): string {
  return kind ? KIND_LABELS[kind] : "Note";
}

/** "Oct 21". `timeZone` is for tests; the page uses the viewer's own. */
export function fmtDay(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
}

/** Keyword match on whole-word prefixes of the statement, group and source ("outflow" finds "outflows"). */
export function matchesKeyword(f: Fact, keyword: string, names: Record<string, string>): boolean {
  const words = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${f.statement} ${groupLabel(f.group, names)} ${sourceTitle(f)}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export interface GroupView {
  /** "" when the list is sorted by date and shown flat. */
  label: string;
  /** Position of the group in the stable order, for its colour stripe. */
  index: number;
  facts: Fact[];
}

/** Stable group order: the order groups first appear in `facts` (Canon's order), so colours don't shuffle. */
export function groupOrder(facts: readonly Fact[]): string[] {
  const order: string[] = [];
  for (const f of facts) if (!order.includes(f.group)) order.push(f.group);
  return order;
}

export function viewMemory(facts: readonly Fact[], filters: Filters, names: Record<string, string>, order: readonly string[]): GroupView[] {
  const shown = facts.filter((f) =>
    f.status === "hot" &&
    matchesKeyword(f, filters.keyword, names) &&
    (filters.group === ALL_GROUPS || groupLabel(f.group, names) === filters.group) &&
    (filters.source === ALL_SOURCES || sourceTitle(f) === filters.source));
  if (filters.sort !== "By group") {
    const dir = filters.sort === "Newest first" ? -1 : 1;
    const sorted = [...shown].sort((a, b) => dir * (Date.parse(a.learned_at) - Date.parse(b.learned_at)) || a.id.localeCompare(b.id));
    return sorted.length ? [{ label: "", index: -1, facts: sorted }] : [];
  }
  return order
    .map((g, index) => ({ label: groupLabel(g, names), index, facts: shown.filter((f) => f.group === g) }))
    .filter((g) => g.facts.length > 0);
}

export function countShown(groups: readonly GroupView[]): number {
  return groups.reduce((n, g) => n + g.facts.length, 0);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function docLabel(id: DocType): string {
  return DOC_TYPES.find((d) => d.id === id)?.label ?? id;
}

export const STATUS_LABELS: Record<AgentRun["status"], string> = {
  building: "Building memory", ready: "Ready", running: "Working", restarting: "Restarting",
  done: "Done", failed: "Failed", stopped: "Stopped",
};

export function isBusy(run: AgentRun): boolean {
  return run.status === "building" || run.status === "running" || run.status === "restarting";
}

/** The live line under an agent: its current step while busy, else its last result. */
export function agentStatusLine(run: AgentRun, now: number): string {
  if (run.status === "building") return "Picking what it needs from your memory…";
  if (run.status === "restarting") return "Your edit narrowed its memory; restarting";
  const last = run.steps[run.steps.length - 1];
  if (run.status === "running") return last?.text ?? "Starting";
  if (run.status === "stopped") return "Stopped by you before finishing";
  if (run.status === "failed") return last?.text ?? "Failed";
  let line = run.finished_at ? `Finished ${relativeTime(run.finished_at, now)}` : "Not run yet";
  if (run.pending) line += ` · ${plural(run.pending, "new memory", "new memories")} for the next run`;
  return line;
}

export function agentPlanLine(run: AgentRun): string {
  const docs = run.docs.length ? run.docs.map((d) => docLabel(d).toLowerCase()).join(", ") : "a brief summary";
  return `${run.schedule} · Makes ${docs}`;
}

/** The feed's sentence for an event, or null for events the feed doesn't show. */
export function feedText(ev: MemberEvent, agentName: (id: string) => string | undefined): string | null {
  switch (ev.type) {
    case "item.captured": return `Your ${kindLabel(ev.kind).toLowerCase()} was added: ${ev.source}`;
    case "fact.saved": return `New in your memory: ${ev.fact.statement}`;
    case "scope.build": {
      const name = agentName(ev.principal);
      return ev.stage === "done" && name ? `${name}’s memory is ready` : null;
    }
    case "agent.started": return `${ev.run.name} started`;
    case "agent.inbox": return `${ev.run.name} picked up ${plural(ev.run.pending, "new memory", "new memories")}`;
    case "agent.restarted": return `${ev.run.name} restarted with its new memory`;
    case "agent.finished":
      if (ev.run.status === "stopped") return `You stopped ${ev.run.name}`;
      if (ev.run.status === "failed") return `${ev.run.name} failed`;
      return `${ev.run.name} finished: ${ev.run.outputs.map((o) => o.title.toLowerCase()).join(", ")}`;
    default: return null;
  }
}
