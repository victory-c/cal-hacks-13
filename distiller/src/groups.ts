// Group aliases matched in code (PRD "Compress and group"; Group.aliases in shared/src/types/scopes.ts).
// A filing HINT next to Jev's pick, never a filing on its own: triage files a fact in the inbox
// (moderators only) when an alias of one group appears and Jev picks another.
//   aliasHits()  finds the groups a piece of text names: each group's aliases, an alias's short form
//                ("Project Falcon" → "Falcon") and the group id itself ("deal_falcon" as a file
//                name). Names are matched on text folded first (matchForms: look-alike letters,
//                zero-width characters, "_" joiners, camelCase), so the usual spelling tricks in a
//                memo cannot hide a name. A group id's words match only across a path or file-name
//                joiner ("deal/falcon", "deal-falcon", "deal_falcon", "dealFalcon"), never across
//                sentence punctuation, so "go to market. Public comment" names no group.
// No I/O, no model, no env.

import type { Group } from "@canon/shared";

/** The parts of a Group the name check reads. */
export type GroupNames = Pick<Group, "id" | "aliases">;

export interface AliasHits {
  /** Group ids the text names, in group-list order, no repeats. */
  groups: string[];
  /** The names that matched, as the group spells them. Moderators only (aliases are). */
  names: string[];
  /** One line for TriageDecision.reason ("code: alias "Falcon" → deal/falcon"); "" when nothing matched. */
  reason: string;
}

/** Names shorter than this never match on their own ("A", "X"): too many false hits. */
const MIN_NAME = 2;
/** "Project Falcon" is also "Falcon", whether or not the group lists the short form. */
const CODE_NAME_PREFIX = /^(?:project|operation)\s+/i;

/**
 * Which groups a text names. Case-insensitive, on letter/digit boundaries ("_" and "/" are
 * separators, so "Falcon_LOI_v3" names Falcon). Between the words of an alias any run of
 * non-letters or none matches ("Project  Falcon" across a line break, "#project_falcon" and
 * "ProjectFalcon" all match). Between the words of a group id only path or file-name joiners
 * ("/", "_", "-", "\") or none do (ID_JOINER): an id is a path, and prose keeps its words apart
 * ("go to market. Public comment").
 * Text and names are folded alike first (foldText, matchForms).
 */
export function aliasHits(text: string, groups: readonly GroupNames[]): AliasHits {
  const forms = matchForms(text);
  // An id is looked for with its joiners kept: "_" stays "_" (foldText makes it a space).
  const idForms = [foldLetters(text).replace(/\p{Pc}/gu, "_")];
  const hits = new Map<string, string[]>(); // group id → matched names
  for (const group of groups) {
    for (const name of groupNames(group)) {
      const isId = name === group.id;
      if (!nameMatches(isId ? idForms : forms, name, isId ? ID_JOINER : ALIAS_JOINER)) continue;
      const names = hits.get(group.id) ?? [];
      if (!names.includes(name)) names.push(name);
      hits.set(group.id, names);
    }
  }
  const ids = groups.map((g) => g.id).filter((id, i, all) => hits.has(id) && all.indexOf(id) === i);
  const parts = ids.map((id) => `${(hits.get(id) ?? []).map((n) => `"${n}"`).join(", ")} → ${id}`);
  return {
    groups: ids,
    names: ids.flatMap((id) => hits.get(id) ?? []),
    reason: parts.length ? `code: alias ${parts.join("; ")}` : "",
  };
}

/**
 * Every name that points at a group: its aliases, each alias's short form, and the group id itself
 * ("deal/falcon" also reads "deal_falcon" and "deal-falcon" in a file name). Tolerates a group from
 * an unchecked source with no aliases (client.ts normalizes, so this is belt and braces).
 */
export function groupNames(group: GroupNames): string[] {
  const aliases = strings(group.aliases);
  const names = [...aliases.flatMap((a) => [a, a.replace(CODE_NAME_PREFIX, "")]), ...(typeof group.id === "string" ? [group.id] : [])];
  const seen = new Set<string>();
  return names.filter((n) => {
    const key = normalizeName(n);
    if (key.length < MIN_NAME || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Between an alias's words: any run of non-letters, or none ("Project Falcon", "project-falcon", "ProjectFalcon"). */
const ALIAS_JOINER = "[^\\p{L}\\p{N}]*";
/**
 * Between a group id's words: path or file-name joiners only, or none: "deal/falcon",
 * "deal_falcon", "deal-falcon", "deal\falcon", "dealFalcon". A space, ". ", ", " or a line break
 * does not join them, so prose ("go to market. Public comment", "capital market public issuance")
 * names no group by its id. Matched against the text folded with "_" kept (aliasHits).
 */
const ID_JOINER = "[-/\\\\_]*";

/**
 * `forms` come from matchForms(). The name is folded and camel-split here, so a camelCase name
 * ("DataRobot") matches however the text spaces it. `joiner` is the regex source between its words.
 */
function nameMatches(forms: readonly string[], name: string, joiner: string): boolean {
  const words = splitCamel(foldText(name))
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.join(" ").length < MIN_NAME) return false;
  const body = words.map(escapeRegExp).join(joiner);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu");
  return forms.some((f) => re.test(f));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Lowercase, letters and digits only, single spaces. */
function normalizeName(s: string): string {
  return foldText(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
}

/** Cyrillic and Greek letters that look like Latin ones, as used to dodge a name check. */
const CONFUSABLES: Record<string, string> = Object.fromEntries(
  [
    // Cyrillic
    ["аеорсухіјѕԁһӏԛԝк", "aeopcyxijsdhlqwk"],
    ["АВЕКМНОРСТУХІЈЅ", "ABEKMHOPCTYXIJS"],
    // Greek
    ["αικνορυχ", "aikvopux"],
    ["ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ", "ABEZHIKMNOPTYX"],
  ].flatMap(([from, to]) => [...from].map((c, i) => [c, to[i]])),
);
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "gu");

/**
 * Text as the name check reads it, so spelling tricks cannot hide a name:
 *   compatibility forms become plain letters (NFKC: fullwidth "Ｆａｌｃｏｎ", math bold)
 *   accents and zero-width / format characters go (a zero-width space inside "Falcon", soft
 *   hyphens, "Fálcon")
 *   Cyrillic and Greek look-alikes become Latin ("Fаlcon" with a Cyrillic а)
 *   "_" and other connector punctuation become spaces ("Falcon_LOI", "deal_falcon")
 * Idempotent.
 */
export function foldText(s: string): string {
  return foldLetters(s).replace(/\p{Pc}/gu, " ");
}

/** foldText without the last step: "_" and other connector punctuation are kept. */
function foldLetters(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\p{Cf}\p{Mn}]/gu, "")
    .normalize("NFKC")
    .replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c);
}

/** camelCase into words: "FalconModel" → "Falcon Model", "NMBLDeal" → "NMBL Deal". */
function splitCamel(s: string): string {
  return s.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2");
}

/**
 * The forms of a text a name is looked for in: folded, and folded with camelCase split
 * ("FalconModel.xlsx" names Falcon). Both, because splitting alone would turn "FaLcOn" into
 * three words. The offline judge reads its regexes against these too.
 */
export function matchForms(text: string): string[] {
  const folded = foldText(text);
  const split = splitCamel(folded);
  return split === folded ? [folded] : [folded, split];
}
