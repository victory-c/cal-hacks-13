// The fact file format from CLAUDE.md: YAML frontmatter between "---" lines, then an optional
// markdown detail body. One file per fact, so the store opens in Obsidian.
//
// The YAML is hand-rolled on purpose (no dependency): the schema is flat, every value is a
// scalar except `source`, a one-level mapping that we write in flow form
// (`{ client: x, session: y }`) and also read in block form (indented `client: x` lines), and
// `labels`, a flow list of slugs (`[nimbus, logistics]`).
// Unknown frontmatter keys are ignored, so a hand-edited file still loads.

import { FACT_ID_RE, GROUP_RE, INBOX, TIERS } from "./types/fact.ts";
import type { Fact, FactSource, Folder, Tier } from "./types/fact.ts";
import { LABEL_RE } from "./types/scopes.ts";

type Scalar = string | number | boolean | null;
type Frontmatter = Record<string, Scalar | Scalar[] | Record<string, Scalar>>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// What the reader turns into a number. Strings that look like this are quoted on write so
// `statement: "42"` stays a string.
const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const KEYWORD_RE = /^(?:true|false|null|~|yes|no|on|off)$/i;
const FRONTMATTER_KEYS = ["id", "statement", "folder", "tier", "jev_keep", "source", "supersedes", "updated", "happened", "labels", "author"] as const;

// ---------------------------------------------------------------------------------------------
// Writing

function needsQuotes(s: string, flow: boolean): boolean {
  if (s === "" || s !== s.trim()) return true;
  if (/[\n\r\t]/.test(s)) return true;
  // ": " and " #" start a mapping value / comment; a trailing ":" is not a valid plain scalar.
  if (s.includes(": ") || s.includes(" #") || s.endsWith(":")) return true;
  if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(s)) return true;
  if (NUMBER_RE.test(s) || KEYWORD_RE.test(s)) return true;
  // Inside `{ ... }` the collection indicators are reserved too.
  if (flow && /[,\[\]{}]/.test(s)) return true;
  return false;
}

/** JSON string syntax is valid YAML double-quoted syntax, so JSON.stringify is our quoter. */
function writeScalar(v: string | number, flow = false): string {
  if (typeof v === "number") return String(v);
  return needsQuotes(v, flow) ? JSON.stringify(v) : v;
}

function writeFlowMapping(obj: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) parts.push(`${k}: ${writeScalar(v, true)}`);
  }
  return parts.length ? `{ ${parts.join(", ")} }` : "{}";
}

/** Fact → markdown file. Throws when the fact is invalid, so a bad fact never reaches disk. */
export function serializeFactFile(fact: Fact): string {
  const v = validateFact(fact);
  if (!v.ok) throw new Error(`Cannot serialize fact: ${v.errors.join("; ")}`);
  const f = v.fact;
  const lines = [
    "---",
    `id: ${writeScalar(f.id)}`,
    `statement: ${writeScalar(f.statement)}`,
    `folder: ${writeScalar(f.folder)}`,
    `tier: ${f.tier}`,
    `jev_keep: ${f.jev_keep}`,
    `source: ${writeFlowMapping({ client: f.source.client, session: f.source.session, pr: f.source.pr, url: f.source.url })}`,
  ];
  if (f.supersedes) lines.push(`supersedes: ${writeScalar(f.supersedes)}`);
  lines.push(`updated: ${writeScalar(f.updated)}`);
  if (f.happened) lines.push(`happened: ${writeScalar(f.happened)}`);
  // Labels are slugs (LABEL_RE), so they never need quoting inside the flow list.
  if (f.labels?.length) lines.push(`labels: [${f.labels.join(", ")}]`);
  if (f.author) lines.push(`author: ${writeScalar(f.author)}`);
  lines.push("---");
  let out = lines.join("\n") + "\n";
  if (f.detail) out += f.detail + "\n";
  return out;
}

// ---------------------------------------------------------------------------------------------
// Reading

function readScalar(raw: string, where: string): Scalar {
  const s = raw.trim();
  if (s === "") return null;
  if (s.startsWith('"')) {
    if (s.length < 2 || !s.endsWith('"')) throw new Error(`${where}: unterminated double-quoted string`);
    try {
      return JSON.parse(s) as string;
    } catch {
      throw new Error(`${where}: bad escape in double-quoted string ${s}`);
    }
  }
  if (s.startsWith("'")) {
    if (s.length < 2 || !s.endsWith("'")) throw new Error(`${where}: unterminated single-quoted string`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (NUMBER_RE.test(s)) return Number(s);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  return s;
}

/** Index of the ":" separating key from value: the first colon followed by a space or line end. */
function keySep(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ":" && (i + 1 === line.length || line[i + 1] === " ")) return i;
  }
  return -1;
}

function splitEntry(entry: string, where: string): [string, string] {
  const i = keySep(entry);
  if (i <= 0) throw new Error(`${where}: expected "key: value", got "${entry.trim()}"`);
  return [entry.slice(0, i).trim(), entry.slice(i + 1)];
}

/** Splits `a: 1, b: "x, y"` on top-level commas. A quote only opens at the start of a value. */
function splitFlowEntries(inner: string, where: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  let lastSignificant = ",";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && (lastSignificant === ":" || lastSignificant === ",")) {
      quote = ch;
    } else if (ch === "{" || ch === "[") {
      throw new Error(`${where}: nested flow collections are not part of the fact file format`);
    } else if (ch === ",") {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
    if (ch !== " ") lastSignificant = ch;
  }
  if (quote) throw new Error(`${where}: unterminated quoted string in flow mapping`);
  parts.push(inner.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** `[a, b]`: a flow list of plain scalars (labels). No quoting or nesting is part of the format. */
function readFlowSequence(src: string, where: string): Scalar[] {
  if (!src.endsWith("]")) throw new Error(`${where}: flow list must end with "]"`);
  const inner = src.slice(1, -1).trim();
  if (inner === "") return [];
  if (/[\[\]{}"']/.test(inner)) throw new Error(`${where}: list items must be plain names`);
  return inner.split(",").map((item) => readScalar(item, where));
}

function readFlowMapping(src: string, where: string): Record<string, Scalar> {
  if (!src.endsWith("}")) throw new Error(`${where}: flow mapping must end with "}"`);
  const out: Record<string, Scalar> = {};
  for (const entry of splitFlowEntries(src.slice(1, -1), where)) {
    const [k, v] = splitEntry(entry, where);
    out[k] = readScalar(v, where);
  }
  return out;
}

function readFrontmatter(lines: string[], firstLineNo: number): Frontmatter {
  const out: Frontmatter = {};
  const where = (idx: number) => `fact file line ${firstLineNo + idx}`;
  const skippable = (l: string) => l.trim() === "" || l.trimStart().startsWith("#");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (skippable(line)) {
      i++;
      continue;
    }
    if (/^\s/.test(line)) throw new Error(`${where(i)}: unexpected indentation`);
    const [key, rawValue] = splitEntry(line, where(i));
    const value = rawValue.trim();
    if (value === "") {
      // `key:` with nothing after it: a block mapping of indented lines, or null.
      const nested: Record<string, Scalar> = {};
      let any = false;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (skippable(l)) continue;
        if (!/^\s/.test(l)) break;
        const [k, v] = splitEntry(l, where(j));
        nested[k] = readScalar(v, where(j));
        any = true;
      }
      out[key] = any ? nested : null;
      i = j;
      continue;
    }
    if (value.startsWith("{")) out[key] = readFlowMapping(value, where(i));
    else if (value.startsWith("[")) out[key] = readFlowSequence(value, where(i));
    else out[key] = readScalar(value, where(i));
    i++;
  }
  return out;
}

/** Drops leading blank lines and trailing whitespace; the body is markdown, not a byte string. */
function normalizeDetail(s: string): string {
  return s.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
}

/** Markdown file → Fact. Throws an Error naming the line and problem on bad input. */
export function parseFactFile(markdown: string): Fact {
  const text = markdown.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") throw new Error('Fact file must start with a "---" frontmatter line');
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) throw new Error('Fact file frontmatter has no closing "---" line');

  const fm = readFrontmatter(lines.slice(1, end), 2);
  const raw: Record<string, unknown> = {};
  for (const key of FRONTMATTER_KEYS) {
    const v = fm[key];
    if (v !== undefined && v !== null) raw[key] = v;
  }
  const detail = normalizeDetail(lines.slice(end + 1).join("\n"));
  if (detail) raw.detail = detail;

  const v = validateFact(raw);
  if (!v.ok) throw new Error(`Invalid fact file: ${v.errors.join("; ")}`);
  return v.fact;
}

// ---------------------------------------------------------------------------------------------
// Validation

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function show(x: unknown): string {
  return x === undefined ? "missing" : JSON.stringify(x);
}

/**
 * A group path: `deal/falcon`, `career/projects/canon`, … or `inbox`. Any top level (groups are
 * open-ended), but every segment must be a real name (no "", ".", "..", whitespace or "\"), so a
 * folder can never escape data/facts/. New groups from triage also match the stricter GROUP_RE.
 */
function isFolder(s: string): s is Folder {
  if (s === INBOX) return true;
  const [top, ...rest] = s.split("/");
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(top)) return false;
  return rest.every((seg) => seg !== "" && seg !== "." && seg !== ".." && !/[\\\s]/.test(seg));
}

/**
 * Checks an unknown value against the fact contract and returns a clean Fact (known keys only,
 * optionals present only when set, detail normalized). Never throws.
 */
export function validateFact(x: unknown): { ok: true; fact: Fact } | { ok: false; errors: string[] } {
  if (!isRecord(x)) return { ok: false, errors: [`fact must be an object (got ${show(x)})`] };
  const errors: string[] = [];

  const { id, statement, folder, tier, jev_keep, source, supersedes, updated, detail, happened, labels, author } = x;
  if (typeof id !== "string" || !FACT_ID_RE.test(id)) errors.push(`id must match ${FACT_ID_RE} (got ${show(id)})`);
  if (typeof statement !== "string" || statement.trim() === "") errors.push(`statement must be a non-empty string (got ${show(statement)})`);
  if (typeof folder !== "string" || !isFolder(folder)) {
    errors.push(`folder must be a group path like "deal/falcon" (like ${GROUP_RE}) or "${INBOX}" (got ${show(folder)})`);
  }
  if (typeof tier !== "string" || !(TIERS as readonly string[]).includes(tier)) errors.push(`tier must be ${TIERS.join("|")} (got ${show(tier)})`);
  if (typeof jev_keep !== "number" || !Number.isFinite(jev_keep) || jev_keep < 0 || jev_keep > 1) {
    errors.push(`jev_keep must be a number in [0, 1] (got ${show(jev_keep)})`);
  }
  if (!isRecord(source)) errors.push(`source must be an object like { client, session } (got ${show(source)})`);
  else {
    if (typeof source.client !== "string" || source.client.trim() === "") errors.push(`source.client must be a non-empty string (got ${show(source.client)})`);
    if (typeof source.session !== "string" || source.session.trim() === "") errors.push(`source.session must be a non-empty string (got ${show(source.session)})`);
    if (source.pr !== undefined && typeof source.pr !== "string") errors.push(`source.pr must be a string (got ${show(source.pr)})`);
    if (source.url !== undefined && typeof source.url !== "string") errors.push(`source.url must be a string (got ${show(source.url)})`);
  }
  if (supersedes !== undefined && (typeof supersedes !== "string" || !FACT_ID_RE.test(supersedes))) {
    errors.push(`supersedes must match ${FACT_ID_RE} (got ${show(supersedes)})`);
  }
  if (typeof updated !== "string" || !DATE_RE.test(updated)) errors.push(`updated must be YYYY-MM-DD (got ${show(updated)})`);
  if (detail !== undefined && typeof detail !== "string") errors.push(`detail must be a string (got ${show(detail)})`);
  if (happened !== undefined && (typeof happened !== "string" || !DATE_RE.test(happened))) errors.push(`happened must be YYYY-MM-DD (got ${show(happened)})`);
  if (labels !== undefined && (!Array.isArray(labels) || !labels.every((l) => typeof l === "string" && LABEL_RE.test(l)))) {
    errors.push(`labels must be a list of lowercase slugs like ${LABEL_RE} (got ${show(labels)})`);
  }
  if (author !== undefined && (typeof author !== "string" || author.trim() === "")) errors.push(`author must be a principal id (got ${show(author)})`);

  if (errors.length) return { ok: false, errors };

  // Narrowed by the checks above; the casts only restate what was verified.
  const src = source as Record<string, unknown>;
  const cleanSource: FactSource = { client: src.client as string, session: src.session as string };
  if (typeof src.pr === "string") cleanSource.pr = src.pr;
  if (typeof src.url === "string") cleanSource.url = src.url;
  const fact: Fact = {
    id: id as string,
    statement: statement as string,
    folder: folder as Folder,
    tier: tier as Tier,
    jev_keep: jev_keep as number,
    source: cleanSource,
    updated: updated as string,
  };
  if (typeof supersedes === "string") fact.supersedes = supersedes;
  if (typeof happened === "string") fact.happened = happened;
  if (Array.isArray(labels) && labels.length) fact.labels = [...new Set(labels as string[])];
  if (typeof author === "string") fact.author = author;
  const cleanDetail = typeof detail === "string" ? normalizeDetail(detail) : "";
  if (cleanDetail) fact.detail = cleanDetail;
  return { ok: true, fact };
}

/** Where a fact lives on disk, relative to the data dir: `facts/<folder>/<id>.md`. */
export function factPath(fact: Pick<Fact, "id" | "folder">): string {
  return `facts/${fact.folder}/${fact.id}.md`;
}
