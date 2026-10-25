// Pure helpers for the moderator console: group colours, feed lines, build stages, people order
// and audit filtering. No DOM, so they run under node:test.

import { plural } from "../member/logic.ts";
import { INBOX } from "./contract.ts";
import type { AuditEntry, BuildStage, Group, ModEvent, ModPrincipal } from "./contract.ts";

/** The seeded groups keep fixed colours; groups Compliance creates take the next from a palette. */
const FIXED: Record<string, string> = {
  "deal/stonewall": "deal", "research/asset-managers": "research", "market/public": "public", "desk/dollar-bill": "desk", "firm/ops": "ops",
};
const PALETTE = ["olive", "rose", "slate", "umber"];

export function groupClass(id: string, groups: readonly Group[]): string {
  if (id === INBOX) return "inboxg";
  if (FIXED[id]) return FIXED[id];
  const custom = groups.filter((g) => !FIXED[g.id]);
  const i = custom.findIndex((g) => g.id === id);
  return i === -1 ? "" : PALETTE[i % PALETTE.length]!;
}

export function groupName(id: string, groups: readonly Group[]): string {
  if (id === INBOX) return "the inbox";
  return groups.find((g) => g.id === id)?.name ?? id;
}

/** Included group ids from a rule's exclusion patterns (`deal/*` style), and back. */
export function includedGroups(excluded: readonly string[], groups: readonly Group[]): string[] {
  return groups.filter((g) => !excluded.some((p) => p === g.id || (p.endsWith("/*") && g.id.startsWith(p.slice(0, -1))))).map((g) => g.id);
}

export function excludedFrom(included: readonly string[], groups: readonly Group[]): string[] {
  return groups.filter((g) => !included.includes(g.id)).map((g) => g.id);
}

/** People in order, each followed by the agents they created. */
export function peopleTree(principals: readonly ModPrincipal[]): { p: ModPrincipal; depth: 0 | 1 }[] {
  const out: { p: ModPrincipal; depth: 0 | 1 }[] = [];
  for (const person of principals.filter((x) => x.kind === "person")) {
    out.push({ p: person, depth: 0 });
    for (const a of principals.filter((x) => x.kind === "agent" && x.creator === person.id)) out.push({ p: a, depth: 1 });
  }
  return out;
}

export const STAGES: { stage: BuildStage; label: string }[] = [
  { stage: "exclusions", label: "Groups (code)" },
  { stage: "candidates", label: "Moss candidates" },
  { stage: "judged", label: "Jev yes / no" },
  { stage: "done", label: "Scope" },
];

export function stageDetail(ev: Extract<ModEvent, { type: "scope.build" }>): string {
  const c = ev.counts;
  switch (ev.stage) {
    case "exclusions": return `${plural(c.removed ?? 0, "fact")} outside the selected groups removed${ev.groups_removed?.length ? `: ${ev.groups_removed.join(", ")}` : ""}`;
    case "candidates": return `${plural(c.candidates ?? 0, "fact")} look related to the task`;
    case "judged": return `${c.yes ?? 0} yes, ${c.no ?? 0} no`;
    case "done": return plural(c.facts ?? 0, "fact");
  }
}

export interface FeedLine { text: string; alert: boolean }

/** The console feed's sentence for an event, or null for events it doesn't show. */
export function modFeedText(ev: ModEvent, name: (id: string) => string, groups: readonly Group[]): FeedLine | null {
  const g = (id: string) => groupName(id, groups);
  const line = (text: string, alert = false): FeedLine => ({ text, alert });
  switch (ev.type) {
    case "item.captured": return line(`Captured: ${ev.source} from ${name(ev.author)}`);
    case "item.quarantined": return line(`Quarantined: ${ev.source}. ${ev.reason}`, true);
    case "item.released": return line(`Released ${ev.source}: ${ev.facts ? `${plural(ev.facts, "fact")} to file` : "nothing to file"}`);
    case "fact.saved": return line(ev.fact.group === INBOX ? `To the inbox: ${ev.fact.statement}` : `Filed to ${g(ev.fact.group)}: ${ev.fact.statement}`);
    case "fact.filed": return line(`Filed ${plural(ev.fact_ids.length, "fact")} from ${ev.from.join(", ")} to ${g(ev.group)}`);
    case "scope.build": return ev.stage === "done" ? line(`${name(ev.principal)}’s scope built: ${plural(ev.counts.facts ?? 0, "fact")}`) : null;
    case "scope.changed": {
      const parts: string[] = [];
      if (ev.added.length) parts.push(`${plural(ev.added.length, "fact")} joined`);
      if (ev.removed.length) parts.push(`${plural(ev.removed.length, "fact")} left`);
      return parts.length ? line(`${parts.join(", ")} ${name(ev.principal)}’s scope`) : null;
    }
    case "principal.added": return line(`Added ${ev.principal.name}`);
    case "principal.tier": return line(`${ev.principal.name} is now ${ev.principal.tier === "moderator" ? "Compliance" : "Member"}`);
    case "agent.started": return line(`${ev.run.name} started (for ${name(ev.run.creator)})`);
    case "agent.inbox": return line(`${ev.run.name} picked up ${plural(ev.run.pending, "new fact")}`);
    case "agent.restarted": return line(`${ev.run.name}: scope narrowed, restarted`);
    case "agent.finished":
      if (ev.run.status === "stopped") return line(`Compliance stopped ${ev.run.name}`);
      if (ev.run.status === "failed") return line(`${ev.run.name} failed`, true);
      return line(`${ev.run.name} finished: ${ev.run.outputs.map((o) => o.title.toLowerCase()).join(", ")}`);
    case "context.served": {
      const kept = ev.handoff.candidates.filter((c) => c.decision === "kept").length;
      return line(`Handoff to ${name(ev.handoff.principal)}: ${plural(kept, "fact")}, ~${ev.handoff.tokens_est} tokens (est.)`);
    }
    case "group.created": return line(`New group: ${ev.group.name}`);
    default: return null;
  }
}

export function filterAudit(entries: readonly AuditEntry[], who: string, group: string): AuditEntry[] {
  return entries.filter((e) => (!who || e.principal === who) && (!group || e.group === group)).slice().reverse();
}
