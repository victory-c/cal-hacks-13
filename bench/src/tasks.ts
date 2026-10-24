// Loads and validates bench/tasks/*.json. Hand-rolled checks (no ajv): every problem names the
// file and the field, so a non-coder can fix it from the message alone. ../tasks/task.schema.json
// is the same contract for editors; this file is what the runner trusts.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEMO_GRANTS, INBOX, INTERNAL_CLIENTS, SESSION_ID_RE, TOP_FOLDERS } from "@canon/shared";
import type { CapturedSession, Folder, SessionMessage } from "@canon/shared";

import type { AnswerKey, BenchTask } from "./types.ts";

export const TASKS_DIR = fileURLToPath(new URL("../tasks/", import.meta.url));
export const EXAMPLE_ID = "t00-example";
/** t01-short-slug.json: two digits keep `ls` sorted, the slug is lowercase words with dashes. */
export const TASK_FILE_RE = /^t\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;
/**
 * AI clients the demo server has both a token (.env.example CANON_CLIENT_TOKENS, mirrored by
 * server/src/auth.ts DEV_CLIENT_TOKENS) and folder grants for. The canon baseline posts sessions
 * as from_client and calls MCP as to_client, so any other client fails it with "No token for
 * client". KNOWN_CLIENTS is wider (claude-web, gemini-web, …) and is not the right check here.
 */
export const DEMO_CLIENTS: readonly string[] = DEMO_GRANTS.map((g) => g.client).filter((c) => !(INTERNAL_CLIENTS as readonly string[]).includes(c));

const ROLES: ReadonlySet<string> = new Set(["user", "assistant", "system", "tool"]);
const TASK_KEYS = ["id", "title", "from_client", "to_client", "folder", "setup_sessions", "question", "answer_key", "notes"] as const;
const SESSION_KEYS = ["id", "client", "started_at", "ended_at", "title", "messages", "meta"] as const;
const MESSAGE_KEYS = ["role", "content", "at"] as const;

export type ParseResult = { ok: true; task: BenchTask; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isText(x: unknown): x is string {
  return typeof x === "string" && x.trim() !== "";
}

function isIso(x: unknown): x is string {
  return typeof x === "string" && !Number.isNaN(Date.parse(x));
}

/** Same rule as shared/fact-file.ts: `career`, `career/anything`, … or `inbox`. */
function isFolder(s: string): s is Folder {
  if (s === INBOX) return true;
  const [top, ...rest] = s.split("/");
  if (!(TOP_FOLDERS as readonly string[]).includes(top)) return false;
  return rest.every((seg) => seg !== "" && seg !== "." && seg !== ".." && !/[\\\s]/.test(seg));
}

function show(x: unknown): string {
  return x === undefined ? "missing" : JSON.stringify(x);
}

type Report = (field: string, problem: string) => void;

function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string, err: Report): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) err(where ? `${where}.${k}` : k, `is not a known field (allowed: ${allowed.join(", ")}). Typo?`);
  }
}

function validateMessage(raw: unknown, where: string, err: Report): SessionMessage | undefined {
  if (!isRecord(raw)) {
    err(where, `must be an object like { "role": "user", "content": "..." } (got ${show(raw)})`);
    return undefined;
  }
  unknownKeys(raw, MESSAGE_KEYS, where, err);
  let ok = true;
  if (typeof raw.role !== "string" || !ROLES.has(raw.role)) {
    err(`${where}.role`, `must be one of ${[...ROLES].join(" | ")} (got ${show(raw.role)})`);
    ok = false;
  }
  if (!isText(raw.content)) {
    err(`${where}.content`, `must be a non-empty string (got ${show(raw.content)})`);
    ok = false;
  }
  if (raw.at !== undefined && !isIso(raw.at)) {
    err(`${where}.at`, `must be an ISO 8601 timestamp when set (got ${show(raw.at)})`);
    ok = false;
  }
  if (!ok) return undefined;
  const msg: SessionMessage = { role: raw.role as SessionMessage["role"], content: raw.content as string };
  if (typeof raw.at === "string") msg.at = raw.at;
  return msg;
}

function validateSession(raw: unknown, where: string, fromClient: string | undefined, err: Report): CapturedSession | undefined {
  if (!isRecord(raw)) {
    err(where, `must be an object with id, client, started_at, messages (got ${show(raw)})`);
    return undefined;
  }
  unknownKeys(raw, SESSION_KEYS, where, err);
  let ok = true;
  if (typeof raw.id !== "string" || !SESSION_ID_RE.test(raw.id)) {
    err(`${where}.id`, `must look like "ses_" + 4 or more hex chars (0-9, a-f), e.g. "ses_07000001" (got ${show(raw.id)})`);
    ok = false;
  }
  if (!isText(raw.client)) {
    err(`${where}.client`, `must be a non-empty string (got ${show(raw.client)})`);
    ok = false;
  } else if (fromClient !== undefined && raw.client !== fromClient) {
    // The setup sessions ARE the "from" AI's history; posting them under another client's token
    // would exercise the wrong grants.
    err(`${where}.client`, `must equal from_client ("${fromClient}") (got ${show(raw.client)})`);
    ok = false;
  }
  if (!isIso(raw.started_at)) {
    err(`${where}.started_at`, `must be an ISO 8601 timestamp like "2026-10-20T18:30:00Z" (got ${show(raw.started_at)})`);
    ok = false;
  }
  if (raw.ended_at !== undefined && !isIso(raw.ended_at)) {
    err(`${where}.ended_at`, `must be an ISO 8601 timestamp when set (got ${show(raw.ended_at)})`);
    ok = false;
  }
  if (raw.title !== undefined && !isText(raw.title)) {
    err(`${where}.title`, `must be a non-empty string when set (got ${show(raw.title)})`);
    ok = false;
  }
  if (raw.meta !== undefined && !isRecord(raw.meta)) {
    err(`${where}.meta`, `must be an object when set (got ${show(raw.meta)})`);
    ok = false;
  }
  const messages: SessionMessage[] = [];
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    err(`${where}.messages`, `must be a non-empty array of { role, content } (got ${show(raw.messages)})`);
    ok = false;
  } else {
    raw.messages.forEach((m, i) => {
      const msg = validateMessage(m, `${where}.messages[${i}]`, err);
      if (msg) messages.push(msg);
      else ok = false;
    });
  }
  if (!ok) return undefined;
  const session: CapturedSession = {
    id: raw.id as string,
    client: raw.client as string,
    started_at: raw.started_at as string,
    messages,
  };
  if (typeof raw.ended_at === "string") session.ended_at = raw.ended_at;
  if (typeof raw.title === "string") session.title = raw.title;
  if (isRecord(raw.meta)) session.meta = raw.meta;
  return session;
}

function validateAnswerKey(raw: unknown, err: Report): AnswerKey | undefined {
  if (!isRecord(raw)) {
    err("answer_key", `must be an object like { "must_include": ["..."] } (got ${show(raw)})`);
    return undefined;
  }
  unknownKeys(raw, ["must_include", "must_not_include"], "answer_key", err);
  let ok = true;
  const phrases = (field: string, v: unknown, required: boolean): string[] | undefined => {
    if (v === undefined) {
      if (required) {
        err(`answer_key.${field}`, "is required: a non-empty array of phrases");
        ok = false;
      }
      return undefined;
    }
    if (!Array.isArray(v) || (required && v.length === 0) || !v.every(isText)) {
      err(`answer_key.${field}`, `must be a${required ? " non-empty" : "n"} array of non-empty strings (got ${show(v)})`);
      ok = false;
      return undefined;
    }
    return v as string[];
  };
  const must_include = phrases("must_include", raw.must_include, true);
  const must_not_include = phrases("must_not_include", raw.must_not_include, false);
  if (!ok || !must_include) return undefined;
  const key: AnswerKey = { must_include };
  if (must_not_include) key.must_not_include = must_not_include;
  return key;
}

/** Validates one task file's text. Never throws: returns every problem it can find at once. */
export function parseTask(json: string, fileName: string): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err: Report = (field, problem) => errors.push(`${fileName}: ${field} ${problem}`);

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, errors: [`${fileName}: is not valid JSON (${e instanceof Error ? e.message : String(e)}). Check for a trailing comma or a missing quote.`], warnings };
  }
  if (!isRecord(raw)) return { ok: false, errors: [`${fileName}: must be a JSON object { ... } (got ${show(raw)})`], warnings };

  unknownKeys(raw, TASK_KEYS, "", err);

  const stem = fileName.replace(/\.json$/, "");
  if (!isText(raw.id)) err("id", `must be a non-empty string (got ${show(raw.id)})`);
  else if (raw.id !== stem) err("id", `must equal the file name without .json ("${stem}") (got ${show(raw.id)})`);

  if (!isText(raw.title)) err("title", `must be a non-empty string (got ${show(raw.title)})`);

  for (const field of ["from_client", "to_client"] as const) {
    const v = raw[field];
    if (!isText(v)) err(field, `must be a non-empty string, e.g. "chatgpt" or "claude-code" (got ${show(v)})`);
    else if (!DEMO_CLIENTS.includes(v)) {
      // A warning, not an error: a server with its own CANON_CLIENT_TOKENS + CANON_GRANTS_FILE
      // can serve more clients. On the demo defaults the canon baseline throws for this task.
      warnings.push(`${fileName}: ${field} "${v}" has no token on the demo server, so the canon baseline will fail with "No token for client". Use one of ${DEMO_CLIENTS.join(", ")}, or add "${v}" to CANON_CLIENT_TOKENS and CANON_GRANTS_FILE`);
    }
  }
  if (isText(raw.from_client) && raw.from_client === raw.to_client) {
    err("to_client", `must differ from from_client ("${raw.from_client}"): a handoff crosses two AIs`);
  }

  if (typeof raw.folder !== "string" || !isFolder(raw.folder)) {
    err("folder", `must be ${TOP_FOLDERS.join(" | ")}, "<top>/<sub>" or "${INBOX}" (got ${show(raw.folder)})`);
  }

  const fromClient = isText(raw.from_client) ? raw.from_client : undefined;
  const sessions: CapturedSession[] = [];
  let sessionsOk = true;
  if (!Array.isArray(raw.setup_sessions) || raw.setup_sessions.length === 0) {
    err("setup_sessions", `must be a non-empty array of sessions (got ${show(raw.setup_sessions)})`);
    sessionsOk = false;
  } else {
    const seen = new Set<string>();
    raw.setup_sessions.forEach((s, i) => {
      const session = validateSession(s, `setup_sessions[${i}]`, fromClient, err);
      if (!session) {
        sessionsOk = false;
        return;
      }
      if (seen.has(session.id)) {
        err(`setup_sessions[${i}].id`, `"${session.id}" is used twice in this file`);
        sessionsOk = false;
      }
      seen.add(session.id);
      sessions.push(session);
    });
  }

  if (!isText(raw.question)) err("question", `must be a non-empty string (got ${show(raw.question)})`);
  const answerKey = validateAnswerKey(raw.answer_key, err);
  if (raw.notes !== undefined && typeof raw.notes !== "string") err("notes", `must be a string when set (got ${show(raw.notes)})`);

  if (errors.length || !sessionsOk || !answerKey) return { ok: false, errors, warnings };

  const task: BenchTask = {
    id: raw.id as string,
    title: raw.title as string,
    from_client: raw.from_client as string,
    to_client: raw.to_client as string,
    folder: raw.folder as Folder,
    setup_sessions: sessions,
    question: raw.question as string,
    answer_key: answerKey,
  };
  if (typeof raw.notes === "string") task.notes = raw.notes;
  return { ok: true, task, warnings };
}

/** Task files in `dir`, sorted. `ignored` lists .json files whose name is not a task name. */
export function listTaskFiles(dir: string): { files: string[]; ignored: string[] } {
  const all = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const files = all.filter((f) => TASK_FILE_RE.test(f));
  const ignored = all.filter((f) => !TASK_FILE_RE.test(f) && f !== "task.schema.json");
  return { files, ignored };
}

export interface LoadOptions {
  /** Defaults to bench/tasks/. Tests point it at fixtures. */
  dir?: string;
  /** t00-example.json is documentation; it only runs when asked. */
  includeExample?: boolean;
}

/**
 * Loads every task file. Throws one Error listing every problem across all files (so one pass
 * fixes everything). Warnings (unknown clients, ignored files) come back for the caller to print.
 */
export function loadTasks(opts: LoadOptions = {}): { tasks: BenchTask[]; warnings: string[] } {
  const dir = opts.dir ?? TASKS_DIR;
  const { files, ignored } = listTaskFiles(dir);
  const tasks: BenchTask[] = [];
  const errors: string[] = [];
  const warnings = ignored.map((f) => `${f}: ignored, task files are named like t01-short-slug.json`);
  // The server upserts sessions by id, so two tasks sharing one would overwrite each other.
  const sessionOwner = new Map<string, string>();

  for (const file of files) {
    if (file.slice(0, -5) === EXAMPLE_ID && !opts.includeExample) continue;
    const result = parseTask(readFileSync(join(dir, file), "utf8"), file);
    warnings.push(...result.warnings);
    if (!result.ok) {
      errors.push(...result.errors);
      continue;
    }
    for (const s of result.task.setup_sessions) {
      const owner = sessionOwner.get(s.id);
      if (owner) errors.push(`${file}: setup_sessions id "${s.id}" is already used in ${owner}; session ids must be unique across all tasks`);
      else sessionOwner.set(s.id, file);
    }
    tasks.push(result.task);
  }

  if (errors.length) {
    throw new Error(`${errors.length} problem${errors.length === 1 ? "" : "s"} in ${dir}:\n  - ${errors.join("\n  - ")}`);
  }
  return { tasks, warnings };
}
