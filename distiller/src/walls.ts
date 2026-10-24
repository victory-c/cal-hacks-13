// Wall labels by code rule (PRD v2 Security: "Labels only move one way on their own"). Two pure
// functions that triage applies around Jev's answers:
//   codeWall()  finds deal ids, code names, aliases and companies, and restricted / watch-list
//               companies, in a piece of text. Names matched in code, on text folded first
//               (matchForms: look-alike letters, zero-width characters, "_" joiners,
//               camelCase), so the usual spelling tricks in a memo cannot talk the label down.
//   raiseWall() joins two labels on the order public < any deal < unlabeled. It never lowers,
//               and two different deals meet at unlabeled: a conflict, which goes to compliance.
// No I/O, no model, no env.

import { PUBLIC_WALL, isDealWall } from "@canon/shared";
import type { Deal, ListsResponse, Wall } from "@canon/shared";

/** A fact with no wall: nobody but compliance sees it. The top of the order. */
export const UNLABELED = "unlabeled" as const;
/** A fact's wall, or none. Same spelling as HandoffCandidate.wall. */
export type Label = Wall | typeof UNLABELED;

/** The parts of a Deal the name check reads. */
export type DealNames = Pick<Deal, "id" | "code_name" | "aliases" | "companies">;

export interface CodeWall {
  /** Deal ids the text names, in deal-list order, no repeats. */
  deals: string[];
  /** The names that matched, as the deal or list spells them. Compliance only. */
  names: string[];
  /** Restricted or watch-list companies the text names that belong to no known deal. */
  listed: Array<{ company: string; list: "restricted" | "watch" }>;
  /** One line for wall_reason; "" when nothing matched. Watch-list names stay out of it. */
  reason: string;
}

/** Names shorter than this never match on their own ("A", "X"): too many false hits. */
const MIN_NAME = 2;
/** "Project Falcon" is also "Falcon", whether or not the deal lists the short form. */
const CODE_NAME_PREFIX = /^(?:project|operation)\s+/i;

/**
 * Which deals (and listed companies) a text names. Case-insensitive, on letter/digit boundaries
 * ("_" is a separator, so "Falcon_LOI_v3" names Falcon), with any run of non-letters or none
 * between the words of a name ("Project  Falcon" across a line break, "#project_falcon" and
 * "ProjectFalcon" all match). Text and names are folded alike first (foldText, matchForms).
 * Tickers on the restricted and watch lists match case-sensitively, so "ON" or "IT" in prose does
 * not.
 */
export function codeWall(text: string, deals: readonly DealNames[], lists?: Partial<ListsResponse>): CodeWall {
  const forms = matchForms(text);
  const hits = new Map<string, string[]>(); // deal id → matched names
  const listed: CodeWall["listed"] = [];
  const hit = (dealId: string, name: string) => {
    const names = hits.get(dealId) ?? [];
    if (!names.includes(name)) names.push(name);
    hits.set(dealId, names);
  };

  for (const deal of deals) {
    for (const name of dealNames(deal)) if (nameMatches(forms, name)) hit(deal.id, name);
  }

  const entries = [
    ...(Array.isArray(lists?.restricted) ? lists.restricted : []).map((e) => ({ ...e, list: "restricted" as const })),
    ...(Array.isArray(lists?.watch) ? lists.watch : []).map((e) => ({ ...e, list: "watch" as const })),
  ];
  for (const entry of entries) {
    if (typeof entry?.company !== "string") continue; // client.ts drops these; belt and braces
    const byName = nameMatches(forms, entry.company);
    const byTicker = typeof entry.ticker === "string" && entry.ticker ? nameMatches(forms, entry.ticker, true) : false;
    if (!byName && !byTicker) continue;
    const owner = deals.find((d) => belongsTo(d, entry.company, entry.ticker));
    if (owner) hit(owner.id, byName ? entry.company : (entry.ticker as string));
    else if (!listed.some((l) => l.company === entry.company)) listed.push({ company: entry.company, list: entry.list });
  }

  const dealIds = deals.map((d) => d.id).filter((id) => hits.has(id));
  const parts = dealIds.map((id) => `${(hits.get(id) ?? []).map((n) => `"${n}"`).join(", ")} → ${id}`);
  for (const l of listed) parts.push(l.list === "restricted" ? `restricted-list company "${l.company}"` : "a watch-list name");
  return {
    deals: dealIds,
    names: dealIds.flatMap((id) => hits.get(id) ?? []),
    listed,
    reason: parts.length ? `code rule: ${parts.join("; ")}` : "",
  };
}

/**
 * Every name that points at a deal: code name, its short form, aliases, companies, and the deal
 * id itself ("deal_falcon" as a folder or file name). Tolerates a deal from an unchecked source
 * with no aliases or companies (client.ts normalizes, so this is belt and braces).
 */
export function dealNames(deal: DealNames): string[] {
  const code = typeof deal.code_name === "string" ? deal.code_name : "";
  const names = [code, code.replace(CODE_NAME_PREFIX, ""), ...strings(deal.aliases), ...strings(deal.companies), ...(typeof deal.id === "string" ? [deal.id] : [])];
  const seen = new Set<string>();
  return names.filter((n) => {
    const key = normalizeName(n);
    if (key.length < MIN_NAME || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function belongsTo(deal: DealNames, company: string, ticker?: string): boolean {
  const own = new Set([...strings(deal.companies), ...strings(deal.aliases)].map(normalizeName));
  return own.has(normalizeName(company)) || (typeof ticker === "string" && own.has(normalizeName(ticker)));
}

/**
 * `forms` come from matchForms(). The name is folded and camel-split here, so a camelCase name
 * ("DataRobot") matches however the text spaces it.
 */
function nameMatches(forms: readonly string[], name: string, caseSensitive = false): boolean {
  const words = splitCamel(foldText(name)).trim().split(/\s+/).filter(Boolean);
  if (words.join(" ").length < MIN_NAME) return false;
  // Any run of non-letters, or none, between words: "Project Falcon", "project-falcon", "ProjectFalcon".
  const body = words.map(escapeRegExp).join("[^\\p{L}\\p{N}]*");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, caseSensitive ? "u" : "iu");
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
  return s
    .normalize("NFKD")
    .replace(/[\p{Cf}\p{Mn}]/gu, "")
    .normalize("NFKC")
    .replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c)
    .replace(/\p{Pc}/gu, " ");
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

export interface Raised {
  wall: Label;
  /** Set when two different deals met: both ids. The fact goes to compliance, unlabeled. */
  conflict?: [string, string];
}

const rank = (l: Label): number => (l === PUBLIC_WALL ? 0 : l === UNLABELED ? 2 : 1);

/**
 * Joins the wall a fact has so far with one more opinion (a code hit, Jev's confident deal, the
 * wall of a fact it replaces). Monotonic: the result is never below `current`.
 */
export function raiseWall(current: Label, proposed: Label): Raised {
  if (current === proposed) return { wall: current };
  const rc = rank(current);
  const rp = rank(proposed);
  if (rc === 1 && rp === 1) return { wall: UNLABELED, conflict: [current, proposed] };
  return { wall: rp > rc ? proposed : current };
}

/** raiseWall() over a list, left to right. Keeps the first conflict it meets. */
export function raiseAll(start: Label, proposed: readonly Label[]): Raised {
  let out: Raised = { wall: start };
  for (const p of proposed) {
    const r = raiseWall(out.wall, p);
    const conflict = out.conflict ?? r.conflict;
    out = conflict ? { wall: r.wall, conflict } : { wall: r.wall };
  }
  return out;
}

/** A stored fact's label. Anything that is not a valid wall (missing, mistyped) is unlabeled. */
export function labelOf(wall: string | undefined): Label {
  if (wall === PUBLIC_WALL) return PUBLIC_WALL;
  if (wall !== undefined && isDealWall(wall)) return wall;
  return UNLABELED;
}
