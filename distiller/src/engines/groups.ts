// Group helpers for the engines (PRD "How Bullwark works", step 2: every fact is filed into one
// group, with labels where a group is too coarse). An engine only suggests: DraftFact.folder is
// its guess at the group and DraftFact.labels its labels, and triage (Jev) decides both.
//
// The group list comes in with each item (the worker reads GET /api/groups; offline,
// fixtures/world/groups.json), never from a prompt or a constant: groups change while the worker
// runs, and the writer's system prompt must hold none of the test world's names. Without a list,
// no draft carries a group, which is the safe default (triage sends what it cannot place to the
// moderators-only inbox).
//
// A group's description and alias list are moderators-only. They stay in code here: the alias
// matcher and the writer's "names the item never mentions" check read them, and no model that
// writes a member's facts is ever shown them. The ids do reach the writer (it files into them),
// and an id can carry a code name (`falcon` in `deal/falcon`), so that check also treats the
// names inside every id as names (idNames), whether or not a moderator listed them as aliases.

import { GROUP_RE, INBOX } from "@canon/shared";
import type { Group, GroupId } from "@canon/shared";

/**
 * The groups a fact can be filed into: well-formed ids (GROUP_RE), never the inbox or anything
 * under it (only triage files there), first one wins on a repeated id. Aliases that are not
 * non-empty strings are dropped, so data from the server cannot break a matcher.
 */
export function filingGroups(groups: readonly Group[] | undefined): Group[] {
  const out: Group[] = [];
  const seen = new Set<string>();
  for (const g of groups ?? []) {
    if (typeof g !== "object" || g === null || typeof g.id !== "string") continue;
    const id = g.id;
    if (!GROUP_RE.test(id) || id === INBOX || id.startsWith(`${INBOX}/`) || seen.has(id)) continue;
    seen.add(id);
    const aliases = Array.isArray(g.aliases) ? g.aliases.filter((a): a is string => typeof a === "string" && a.trim() !== "") : [];
    out.push({ id, description: typeof g.description === "string" ? g.description : "", aliases });
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `text` names `name` as a whole word or phrase, in any case ("NMBL", "Project Falcon", "deal/falcon"). */
export function namesWord(text: string, name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/** True when a word in `text` starts with `part`, in any case: "market" is in "markets", "q3" in "Q3 2026". */
export function startsWordIn(text: string, part: string): boolean {
  const p = part.trim();
  if (!p) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p)}`, "iu").test(text);
}

/**
 * The group whose aliases the sentence names, when exactly one group's do (whole words, any
 * case). No match, or names from two groups: undefined, so triage decides with nothing to anchor
 * on. Only aliases count: a group id is a filing path, not a name anyone writes.
 */
export function aliasGroup(sentence: string, groups: readonly Group[]): GroupId | undefined {
  const hits = new Set<GroupId>();
  for (const g of groups) {
    if ((g.aliases ?? []).some((a) => namesWord(sentence, a))) hits.add(g.id);
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}

/**
 * The names a group id itself carries: every path segment after the first, or the only segment
 * of a one-segment id. The first segment of a longer id is its category (`deal`, `market`,
 * `desk`), a word any item may use; the rest can be a code name. `deal/falcon` → ["falcon"],
 * `deal/blue-heron/terms` → ["blue-heron", "terms"], `osprey` → ["osprey"].
 */
export function idNames(id: GroupId): string[] {
  const parts = id.split("/").filter((p) => p.trim() !== "");
  return parts.length > 1 ? parts.slice(1) : parts;
}

/**
 * Like namesWord, but a space, hyphen or underscore in `name` matches any run of them or none,
 * so a slug and the way people write it are one name: "blue-heron" is in "Project Blue Heron"
 * and in "BlueHeron".
 */
export function namesLoosely(text: string, name: string): boolean {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (!words.length) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.map(escapeRe).join("[\\s_-]*")}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

/**
 * The first group id, name inside an id (idNames) or alias that `said` names and the item's own
 * text never does, else undefined. A draft that brings such a name in learned it from somewhere
 * other than the item (the group list it was shown for filing, or a guess), and it would carry
 * that name into the memory of whoever the item belongs to. The writer is shown every id, so the
 * names inside the ids count whether or not a moderator listed them as aliases: a group accepted
 * after triage, or one whose code name nobody added, is covered too. Over-dropping a fact that
 * uses a generic id word ("public", "trading") the item never says is the safe failure. A longer
 * form of a name the item already says is not new ("Project Falcon" when the item says "falcon",
 * both names of one group), so it passes.
 */
export function foreignName(said: string, itemText: string, groups: readonly Group[]): string | undefined {
  for (const g of groups) {
    // A group id is a filing path nobody writes, so it never counts as a longer form.
    if (namesWord(said, g.id) && !namesWord(itemText, g.id)) return g.id;
    const names = [...(g.aliases ?? []), ...idNames(g.id)];
    for (const name of names) {
      if (!namesLoosely(said, name) || namesLoosely(itemText, name)) continue;
      const longerForm = names.some((short) => short.trim().length < name.trim().length && namesLoosely(name, short) && namesLoosely(itemText, short));
      if (!longerForm) return name;
    }
  }
  return undefined;
}

/** Everything the captured item itself says: its title and every message. What labels and names are checked against. */
export function itemText(session: { title?: string; messages: ReadonlyArray<{ content: string }> }): string {
  return [session.title ?? "", ...session.messages.map((m) => (typeof m.content === "string" ? m.content : ""))].join("\n");
}
