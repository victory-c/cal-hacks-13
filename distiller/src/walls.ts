// Wall labels by code rule (PRD v2 Security: "Labels only move one way on their own"). Two pure
// functions that triage applies around Jev's answers:
//   codeWall()  finds deal code names, aliases and companies, and restricted / watch-list
//               companies, in a piece of text. Exact names, matched in code, so no wording in a
//               memo can talk the label down.
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
 * Which deals (and listed companies) a text names. Case-insensitive, on word boundaries, any
 * whitespace between words ("Project  Falcon" across a line break still matches). Tickers on
 * the restricted and watch lists match case-sensitively, so "ON" or "IT" in prose does not.
 */
export function codeWall(text: string, deals: readonly DealNames[], lists?: Partial<ListsResponse>): CodeWall {
  const hits = new Map<string, string[]>(); // deal id → matched names
  const listed: CodeWall["listed"] = [];
  const hit = (dealId: string, name: string) => {
    const names = hits.get(dealId) ?? [];
    if (!names.includes(name)) names.push(name);
    hits.set(dealId, names);
  };

  for (const deal of deals) {
    for (const name of dealNames(deal)) if (nameMatches(text, name)) hit(deal.id, name);
  }

  const entries = [
    ...(lists?.restricted ?? []).map((e) => ({ ...e, list: "restricted" as const })),
    ...(lists?.watch ?? []).map((e) => ({ ...e, list: "watch" as const })),
  ];
  for (const entry of entries) {
    const byName = nameMatches(text, entry.company);
    const byTicker = entry.ticker ? nameMatches(text, entry.ticker, true) : false;
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

/** Every name that points at a deal: code name, its short form, aliases, companies. */
export function dealNames(deal: DealNames): string[] {
  const names = [deal.code_name, deal.code_name.replace(CODE_NAME_PREFIX, ""), ...deal.aliases, ...deal.companies];
  const seen = new Set<string>();
  return names.filter((n) => {
    const key = normalizeName(n);
    if (key.length < MIN_NAME || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function belongsTo(deal: DealNames, company: string, ticker?: string): boolean {
  const own = new Set([...deal.companies, ...deal.aliases].map(normalizeName));
  return own.has(normalizeName(company)) || (ticker !== undefined && own.has(normalizeName(ticker)));
}

function nameMatches(text: string, name: string, caseSensitive = false): boolean {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.join(" ").length < MIN_NAME) return false;
  const body = words.map(escapeRegExp).join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, caseSensitive ? "u" : "iu").test(text);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Lowercase, letters and digits only, single spaces. */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
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
