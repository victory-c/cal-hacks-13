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

// ---------- agents at work

/** A file name as a reader would say it: "out/tmc_brief-v2.md" → "tmc brief v2". */
export function fileLabel(file: string): string {
  return file.replace(/^.*\//, "").replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || file;
}

function clipWords(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

/**
 * One agent step in the creator's words. Canon's steps are runtime log lines ("read_file
 * facts/fct_570013.md"); this says what the agent is doing ("Reading “TMC's assets under
 * management…”"). `statementOf` looks a fact up in the member's own memory: an agent's scope is
 * inside its creator's, so every fact it reads is one they can see. Anything not recognised is
 * the agent's own words (its plan or result summary) and is shown as written.
 */
export function friendlyStep(step: { text: string; kind?: string; file?: string }, statementOf: (id: string) => string | undefined): string {
  const t = step.text.trim();
  let m: RegExpExecArray | null;
  if ((m = /^facts\/ holds (\d+) fact file/.exec(t))) return `Gathered ${plural(Number(m[1]), "memory", "memories")} it may use`;
  if (/^No facts/.test(t)) return "Found nothing in its memory for this yet";
  if (/^brief\.md written/.test(t)) return "Wrote itself a brief";
  if (/^read_file brief\.md/.test(t)) return "Reading its brief";
  if (/^list_files facts/.test(t)) return "Looking through its memories";
  if (/^list_files out/.test(t)) return "Checking its work so far";
  if (/^list_files/.test(t)) return "Looking around its folder";
  if ((m = /^read_file facts\/(fct_[0-9a-f]+)\.md/.exec(t))) {
    const statement = statementOf(m[1]!);
    return statement ? `Reading “${clipWords(statement, 90)}”` : "Reading a memory";
  }
  if (/^read_file out\/plan\.md/.test(t)) return "Re-reading its plan";
  if ((m = /^read_file (\S+)/.exec(t))) return `Reading ${fileLabel(m[1]!)}`;
  if (/^wrote out\/plan\.md/.test(t)) return "Made a plan";
  if (/^wrote out\/memories\//.test(t)) return "Writing a note for your memory";
  if ((m = /^wrote (out\/\S+)/.exec(t))) return `Writing ${fileLabel(m[1]!)}`;
  if (/^saved out\/memories\/\S+ to /.test(t)) return "Saved a note to your memory";
  if ((m = /^saved (out\/\S+) to /.exec(t))) return `Saved ${fileLabel(m[1]!)} to your memory`;
  if (/kept in the run's record only/.test(t)) return "Kept a file with the run only";
  if (/^Restart \d+:|^URGENT scope_narrowed/.test(t)) return "Its memory changed, so it started again";
  if (/^new_fact:/.test(t)) return "Picked up a new memory";
  if (/^Done/.test(t)) return "Finished";
  if (/^Cancelled/.test(t)) return "Stopped";
  if (/^Stopped while saving/.test(t)) return "Stopped while saving";
  if (step.kind === "error") return "Tried something it isn’t allowed to, and carried on";
  return clipWords(t, 160);
}

/** The headline while an agent works. */
export function agentPhase(run: Pick<AgentRun, "status" | "steps">): string {
  if (run.status === "building") return "Getting its memory ready";
  if (run.status === "restarting") return "Starting again with its new memory";
  const last = run.steps[run.steps.length - 1];
  if (!last) return "Starting";
  if (last.kind === "brief" || /^facts\/ holds|^brief\.md/.test(last.text)) return "Getting ready";
  if (/^saved |^Done/.test(last.text)) return "Saving to your memory";
  if (/^wrote out\/plan\.md/.test(last.text) || !run.steps.some((s) => /^wrote out\/plan\.md/.test(s.text))) return "Planning";
  if (/^wrote /.test(last.text)) return "Writing";
  return "Working";
}

/** "8s", "1m 05s". */
export function elapsed(fromIso: string | null | undefined, now: number): string {
  const ms = fromIso ? now - Date.parse(fromIso) : NaN;
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** A block of an agent's markdown document, for building DOM without ever parsing HTML. */
export type DocBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "item"; text: string }
  | { type: "para"; text: string }
  | { type: "table"; head: string[]; rows: string[][] };

/** "| a | b |" → ["a", "b"]. */
function tableCells(line: string): string[] {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/**
 * The small markdown agents write (headings, bullet and numbered lists, pipe tables, paragraphs)
 * as blocks. Everything else stays plain text: the page renders text nodes only, so whatever a
 * model put in a document can never become markup.
 */
export function docBlocks(markdown: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) blocks.push({ type: "para", text: para.join(" ") }); para = []; };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if (!line) { flush(); continue; }
    if (/^\|.*\|$/.test(line)) {
      flush();
      // The |---|:--:| rule under a header row carries no content.
      if (/^\|[\s|:-]+\|$/.test(line)) continue;
      const last = blocks[blocks.length - 1];
      if (last?.type === "table") last.rows.push(tableCells(line));
      else blocks.push({ type: "table", head: tableCells(line), rows: [] });
      continue;
    }
    if ((m = /^(#{1,3})\s+(.*?)\s*#*$/.exec(line))) { flush(); blocks.push({ type: "heading", level: m[1]!.length as 1 | 2 | 3, text: m[2]! }); continue; }
    if ((m = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line))) { flush(); blocks.push({ type: "item", text: m[1]! }); continue; }
    para.push(line);
  }
  flush();
  return blocks;
}

/** Splits `**bold**` runs out of a line: [text, bold, text, …] with odd indexes bold. */
export function boldRuns(text: string): string[] {
  return text.split(/\*\*(.+?)\*\*/g);
}

/**
 * Drops an agent's citations of internal fact ids ("AUM fell 3% (fct_570013)" → "AUM fell 3%"):
 * they let the run's record be audited, but mean nothing to the person reading the document.
 */
export function stripFactRefs(text: string): string {
  return text.replace(/\s*\((?:fct_[0-9a-f]+(?:\s*(?:,|and|;)\s*)?)+\)/g, "");
}

// ---------- memory layers

/** Why a memory is in the background (or pinned), in plain words; nothing for an ordinary current one. */
export function layerReasonLabel(reason: Fact["layer_reason"]): string {
  switch (reason) {
    case "past_date": return "Out of date";
    case "idle": return "Not used lately";
    case "moved": return "You moved it here";
    case "pinned": return "Kept top of mind";
    default: return "";
  }
}

/** "Used 3× · last 2 h ago", or "" for a memory nothing has used yet. */
export function usageLine(f: Pick<Fact, "uses" | "last_used">, now: number): string {
  if (!f.uses) return "";
  return `Used ${f.uses}×${f.last_used ? ` · last ${relativeTime(f.last_used, now)}` : ""}`;
}

/** The layer a memory is in, top of mind when Canon has not said. */
export function layerOfFact(f: Pick<Fact, "layer">): "top" | "background" {
  return f.layer === "background" ? "background" : "top";
}

/**
 * A short plain-text preview of an agent's markdown document for its result card: the heading
 * that repeats the title is dropped, markdown and fact-id citations are removed, and the text is
 * cut at a word near `max` characters.
 */
export function docExcerpt(markdown: string, title: string, max = 240): string {
  const lines = docBlocks(markdown)
    .filter((b, i) => !(i === 0 && b.type === "heading" && b.text.trim() === title.trim()))
    .flatMap((b) => (b.type === "table" ? [] : [stripFactRefs(b.text).replaceAll("**", "").trim()]))
    .filter(Boolean);
  const text = lines.join(" · ");
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max * 0.6)).replace(/[\s·,;:]+$/, "")}…`;
}
