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
// A group's description and aliases are moderators-only. They stay in code here: the alias
// matcher and the writer's "names the item never mentions" check read them, and no model that
// writes a member's facts is ever shown them.

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

/**
 * True when `text` names `name` as a whole word or phrase, in any case ("NMBL", "Project Falcon",
 * "deal/falcon"). The start of a longer word does not count ("NMBL" is not in "NMBLX"). Any run of
 * whitespace inside the name matches any run in the text, so a name an email wraps onto the next
 * line ("Acme\nRail") or spaces with a no-break space is still that name. Both sides need it: the
 * item, so a wrapped name the writer copies onto one line is not taken for a new one, and a draft,
 * so an odd space cannot hide a name the item never says from foreignName.
 */
export function namesWord(text: string, name: string): boolean {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.map(escapeRe).join("\\s+")}(?![\\p{L}\\p{N}])`, "iu").test(text);
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
 * The first group id or alias that `said` names and the item's own text never does, else
 * undefined. A draft that brings such a name in learned it from somewhere other than the item
 * (the group list it was shown for filing, or a guess), and it would carry that name into the
 * memory of whoever the item belongs to. A longer form of a name the item already says is not
 * new ("Project Falcon" when the item says "falcon", both aliases of one group), so it passes.
 */
export function foreignName(said: string, itemText: string, groups: readonly Group[]): string | undefined {
  for (const g of groups) {
    const aliases = g.aliases ?? [];
    // A group id is a filing path nobody writes, so it never counts as a longer form.
    if (namesWord(said, g.id) && !namesWord(itemText, g.id)) return g.id;
    for (const name of aliases) {
      if (!namesWord(said, name) || namesWord(itemText, name)) continue;
      const longerForm = aliases.some((short) => short.trim().length < name.trim().length && namesWord(name, short) && namesWord(itemText, short));
      if (!longerForm) return name;
    }
  }
  return undefined;
}

/** Everything the captured item itself says: its title and every message. What labels and names are checked against. */
export function itemText(session: { title?: string; messages: ReadonlyArray<{ content: string }> }): string {
  return [session.title ?? "", ...session.messages.map((m) => (typeof m.content === "string" ? m.content : ""))].join("\n");
}
