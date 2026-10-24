// Loads and validates bench/tasks/finance/*.json (C6's sets). Same philosophy as ../tasks.ts:
// hand-rolled checks where every problem names the file and the field, all problems reported in
// one pass, and the runner consumes whatever valid cases exist (a partial set runs fine).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FACT_ID_RE, GROUP_RE, LABEL_RE, SESSION_ID_RE } from "@canon/shared";
import type { CapturedSession, SessionMessage } from "@canon/shared";

import type { AnswerKey } from "../types.ts";
import { ATTACK_STYLES } from "./types.ts";
import type { AgentSpec, AttackStyle, FinanceCase } from "./types.ts";

export const FINANCE_CASES_DIR = fileURLToPath(new URL("../../tasks/finance/", import.meta.url));
/** task-01-short-slug.json / attack-01-short-slug.json; number 00 is the documentation example. */
export const CASE_FILE_RE = /^(task|attack)-(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;

/** Synthetic-world members (A14). An unknown principal is a warning: the server 404s it later. */
export const WORLD_MEMBERS: readonly string[] = ["dan", "priya", "leo"];

const TASK_KEYS = ["title", "principal", "question", "needed_fact_ids", "answer_key", "notes"] as const;
const ATTACK_KEYS = ["title", "principal", "question", "attack_style", "leak_probes", "agent", "setup_sessions", "answer_key", "notes"] as const;
const ROLES: ReadonlySet<string> = new Set(["user", "assistant", "system", "tool"]);

export type ParseCaseResult = { ok: true; case: FinanceCase; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isText(x: unknown): x is string {
  return typeof x === "string" && x.trim() !== "";
}

function isIso(x: unknown): x is string {
  return typeof x === "string" && !Number.isNaN(Date.parse(x));
}

function show(x: unknown): string {
  return x === undefined ? "missing" : JSON.stringify(x);
}

type Report = (field: string, problem: string) => void;

function stringArray(v: unknown, field: string, err: Report, opts: { nonEmpty?: boolean; re?: RegExp; reHint?: string } = {}): string[] | undefined {
  if (!Array.isArray(v) || (opts.nonEmpty && v.length === 0) || !v.every(isText)) {
    err(field, `must be a${opts.nonEmpty ? " non-empty" : "n"} array of non-empty strings (got ${show(v)})`);
    return undefined;
  }
  if (opts.re) {
    const bad = (v as string[]).filter((s) => !opts.re!.test(s));
    if (bad.length) {
      err(field, `entries must ${opts.reHint} (got ${bad.map((s) => JSON.stringify(s)).join(", ")})`);
      return undefined;
    }
  }
  return v as string[];
}

function validateAnswerKey(raw: unknown, err: Report): AnswerKey | undefined {
  if (!isRecord(raw)) {
    err("answer_key", `must be an object like { "must_include": ["..."] } (got ${show(raw)})`);
    return undefined;
  }
  for (const k of Object.keys(raw)) {
    if (k !== "must_include" && k !== "must_not_include") err(`answer_key.${k}`, "is not a known field (allowed: must_include, must_not_include). Typo?");
  }
  const must_include = stringArray(raw.must_include, "answer_key.must_include", err, { nonEmpty: true });
  const must_not_include = raw.must_not_include === undefined ? undefined : stringArray(raw.must_not_include, "answer_key.must_not_include", err);
  if (!must_include) return undefined;
  const key: AnswerKey = { must_include };
  if (must_not_include) key.must_not_include = must_not_include;
  return key;
}

function validateAgent(raw: unknown, err: Report): AgentSpec | undefined {
  if (!isRecord(raw)) {
    err("agent", `must be { name, rule: { task, exclude: { groups, labels, text? } } } (got ${show(raw)})`);
    return undefined;
  }
  let ok = true;
  if (!isText(raw.name)) {
    err("agent.name", `must be a non-empty string (got ${show(raw.name)})`);
    ok = false;
  }
  const rule = raw.rule;
  if (!isRecord(rule) || !isText(rule.task) || !isRecord(rule.exclude)) {
    err("agent.rule", `must be { task, exclude: { groups, labels, text? } } (got ${show(raw.rule)})`);
    return undefined;
  }
  const groups = stringArray(rule.exclude.groups, "agent.rule.exclude.groups", err, { re: GROUP_RE, reHint: 'be group paths like "deal/falcon"' });
  const labels = stringArray(rule.exclude.labels, "agent.rule.exclude.labels", err, { re: LABEL_RE, reHint: "be lowercase slugs" });
  if (rule.exclude.text !== undefined && !isText(rule.exclude.text)) {
    err("agent.rule.exclude.text", `must be a non-empty string when set (got ${show(rule.exclude.text)})`);
    ok = false;
  }
  if (!ok || !groups || !labels) return undefined;
  const spec: AgentSpec = { name: (raw.name as string).trim(), rule: { task: (rule.task as string).trim(), exclude: { groups, labels } } };
  if (isText(rule.exclude.text)) spec.rule.exclude.text = rule.exclude.text.trim();
  return spec;
}

function validateSessions(raw: unknown, err: Report): CapturedSession[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    err("setup_sessions", `must be a non-empty array of sessions when set (got ${show(raw)})`);
    return undefined;
  }
  const sessions: CapturedSession[] = [];
  let ok = true;
  raw.forEach((s, i) => {
    const where = `setup_sessions[${i}]`;
    if (!isRecord(s)) {
      err(where, `must be an object with id, client, started_at, messages (got ${show(s)})`);
      ok = false;
      return;
    }
    if (typeof s.id !== "string" || !SESSION_ID_RE.test(s.id)) {
      err(`${where}.id`, `must look like "ses_" + 4 or more hex chars (got ${show(s.id)})`);
      ok = false;
    }
    if (!isText(s.client)) {
      err(`${where}.client`, `must be a client with a token (the runner posts the session as it) (got ${show(s.client)})`);
      ok = false;
    }
    if (!isIso(s.started_at)) {
      err(`${where}.started_at`, `must be an ISO 8601 timestamp (got ${show(s.started_at)})`);
      ok = false;
    }
    const messages: SessionMessage[] = [];
    if (!Array.isArray(s.messages) || s.messages.length === 0) {
      err(`${where}.messages`, `must be a non-empty array of { role, content } (got ${show(s.messages)})`);
      ok = false;
    } else {
      s.messages.forEach((m, j) => {
        if (!isRecord(m) || typeof m.role !== "string" || !ROLES.has(m.role) || !isText(m.content)) {
          err(`${where}.messages[${j}]`, `must be { role: ${[...ROLES].join("|")}, content: non-empty string } (got ${show(m)})`);
          ok = false;
          return;
        }
        messages.push({ role: m.role as SessionMessage["role"], content: m.content as string });
      });
    }
    if (!ok) return;
    const session: CapturedSession = { id: s.id as string, client: s.client as string, started_at: s.started_at as string, messages };
    if (isIso(s.ended_at)) session.ended_at = s.ended_at;
    if (isText(s.title)) session.title = s.title;
    sessions.push(session);
  });
  return ok ? sessions : undefined;
}

/** Validates one case file's text. Never throws: returns every problem it can find at once. */
export function parseCase(json: string, fileName: string): ParseCaseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err: Report = (field, problem) => errors.push(`${fileName}: ${field} ${problem}`);

  const m = CASE_FILE_RE.exec(fileName);
  if (!m) return { ok: false, errors: [`${fileName}: case files are named task-NN-short-slug.json or attack-NN-short-slug.json`], warnings };
  const kind = m[1] === "task" ? ("task" as const) : ("attack" as const);
  const stem = fileName.replace(/\.json$/, "");

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, errors: [`${fileName}: is not valid JSON (${e instanceof Error ? e.message : String(e)}). Check for a trailing comma or a missing quote.`], warnings };
  }
  if (!isRecord(raw)) return { ok: false, errors: [`${fileName}: must be a JSON object { ... } (got ${show(raw)})`], warnings };

  const allowed = kind === "task" ? TASK_KEYS : ATTACK_KEYS;
  for (const k of Object.keys(raw)) {
    if (!(allowed as readonly string[]).includes(k)) {
      err(k, `is not a known field on a ${kind} (allowed: ${allowed.join(", ")}). The kind comes from the file name.`);
    }
  }

  if (!isText(raw.title)) err("title", `must be a non-empty string (got ${show(raw.title)})`);
  if (!isText(raw.principal)) err("principal", `must be a non-empty string, e.g. "priya" (got ${show(raw.principal)})`);
  else if (!WORLD_MEMBERS.includes(raw.principal)) {
    warnings.push(`${fileName}: principal "${raw.principal}" is not a synthetic-world member (${WORLD_MEMBERS.join(", ")}); the Bullwark setups will fail this case unless the world defines them`);
  }
  if (!isText(raw.question)) err("question", `must be a non-empty string (got ${show(raw.question)})`);
  if (raw.notes !== undefined && typeof raw.notes !== "string") err("notes", `must be a string when set (got ${show(raw.notes)})`);

  let needed: string[] | undefined;
  let answerKey: AnswerKey | undefined;
  let style: AttackStyle | undefined;
  let probes: string[] | undefined;
  let agent: AgentSpec | undefined;
  let sessions: CapturedSession[] | undefined;

  if (kind === "task") {
    if (raw.needed_fact_ids === undefined) err("needed_fact_ids", 'is required on a task: the fact ids the handoff must supply ("[]" for a question needing none)');
    else needed = stringArray(raw.needed_fact_ids, "needed_fact_ids", err, { re: FACT_ID_RE, reHint: `match ${FACT_ID_RE} (world fact ids)` });
    if (raw.answer_key === undefined) err("answer_key", "is required on a task");
    else answerKey = validateAnswerKey(raw.answer_key, err);
  } else {
    if (typeof raw.attack_style !== "string" || !(ATTACK_STYLES as readonly string[]).includes(raw.attack_style)) {
      err("attack_style", `must be one of ${ATTACK_STYLES.join(" | ")} (got ${show(raw.attack_style)})`);
    } else {
      style = raw.attack_style as AttackStyle;
    }
    probes = raw.leak_probes === undefined ? undefined : stringArray(raw.leak_probes, "leak_probes", err, { nonEmpty: true });
    if (raw.leak_probes === undefined) err("leak_probes", "is required on an attack: distinctive excluded strings that must never appear");
    if (style === "agent-escalation") {
      if (raw.agent === undefined) err("agent", "is required on an agent-escalation attack");
      else agent = validateAgent(raw.agent, err);
    } else if (raw.agent !== undefined) {
      err("agent", `is only allowed on agent-escalation attacks (this attack_style is ${show(raw.attack_style)})`);
    }
    if (raw.setup_sessions !== undefined) {
      sessions = validateSessions(raw.setup_sessions, err);
      if (style !== "planted-instruction") {
        warnings.push(`${fileName}: setup_sessions on a "${style ?? "?"}" attack; they are meant for planted-instruction cases`);
      }
    }
    if (style === "planted-instruction" && raw.setup_sessions === undefined) {
      err("setup_sessions", "is required on a planted-instruction attack: the captured text carrying the instruction");
    }
    if (raw.answer_key !== undefined) answerKey = validateAnswerKey(raw.answer_key, err);
    // A probe inside the attacker's own text (the question, an agent's task — echoed by the
    // pinned profile) would count the attacker's input as a leak. Probes must exist only in the
    // excluded material.
    if (probes) {
      const attackerText = [isText(raw.question) ? raw.question : "", agent?.name ?? "", agent?.rule.task ?? "", agent?.rule.exclude.text ?? ""].join("\n").toLowerCase();
      for (const p of probes) {
        if (attackerText.includes(p.toLowerCase())) {
          err("leak_probes", `"${p}" appears in the attack's own text (question or agent rule), so an echo of the attacker's input would count as a leak. Pick a string only the excluded material contains.`);
        }
      }
    }
  }

  if (errors.length) return { ok: false, errors, warnings };

  const c: FinanceCase = {
    id: stem,
    kind,
    title: raw.title as string,
    principal: raw.principal as string,
    question: raw.question as string,
  };
  if (needed) c.needed_fact_ids = needed;
  if (answerKey) c.answer_key = answerKey;
  if (style) c.attack_style = style;
  if (probes) c.leak_probes = probes;
  if (agent) c.agent = agent;
  if (sessions) c.setup_sessions = sessions;
  if (typeof raw.notes === "string") c.notes = raw.notes;
  return { ok: true, case: c, warnings };
}

/** Case files in `dir`, sorted. `ignored` lists .json files whose name is not a case name. */
export function listCaseFiles(dir: string): { files: string[]; ignored: string[] } {
  let all: string[];
  try {
    all = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return { files: [], ignored: [] }; // no finance directory yet: an empty, valid set
  }
  const files = all.filter((f) => CASE_FILE_RE.test(f));
  const ignored = all.filter((f) => !CASE_FILE_RE.test(f) && f !== "case.schema.json");
  return { files, ignored };
}

export interface LoadCasesOptions {
  /** Defaults to bench/tasks/finance/. Tests point it at fixtures. */
  dir?: string;
  /** task-00-* / attack-00-* are documentation; they only run when asked. */
  includeExamples?: boolean;
}

/**
 * Loads every case file. Throws one Error listing every problem across all files. Warnings come
 * back for the caller to print. An empty or missing directory is a valid (empty) set: C6 fills it.
 */
export function loadCases(opts: LoadCasesOptions = {}): { cases: FinanceCase[]; warnings: string[] } {
  const dir = opts.dir ?? FINANCE_CASES_DIR;
  const { files, ignored } = listCaseFiles(dir);
  const cases: FinanceCase[] = [];
  const errors: string[] = [];
  const warnings = ignored.map((f) => `${f}: ignored, case files are named like task-01-short-slug.json or attack-01-short-slug.json`);
  // The server upserts sessions by id, so two cases sharing one would overwrite each other.
  const sessionOwner = new Map<string, string>();

  for (const file of files) {
    if (/^(?:task|attack)-00-/.test(file) && !opts.includeExamples) continue;
    const result = parseCase(readFileSync(join(dir, file), "utf8"), file);
    warnings.push(...result.warnings);
    if (!result.ok) {
      errors.push(...result.errors);
      continue;
    }
    for (const s of result.case.setup_sessions ?? []) {
      const owner = sessionOwner.get(s.id);
      if (owner) errors.push(`${file}: setup_sessions id "${s.id}" is already used in ${owner}; session ids must be unique across all cases`);
      else sessionOwner.set(s.id, file);
    }
    cases.push(result.case);
  }

  if (errors.length) {
    throw new Error(`${errors.length} problem${errors.length === 1 ? "" : "s"} in ${dir}:\n  - ${errors.join("\n  - ")}`);
  }
  return { cases, warnings };
}
