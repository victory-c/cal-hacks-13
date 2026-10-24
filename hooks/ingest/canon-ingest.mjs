#!/usr/bin/env node
// Ingest CLI: reads a folder of firm content (memos, team chat, meeting transcripts, email,
// notes) and POSTs one CapturedSession per file to POST /api/sessions as client "ingest". This
// is the PRD's third capture path next to the Claude Code hook and the ChatGPT extension, and the
// one the synthetic world (Harbor Lane, Project Falcon) arrives through.
//
//   node hooks/ingest/canon-ingest.mjs hooks/fixtures/world --principals hooks/fixtures/principals.json --dry-run
//   node hooks/ingest/canon-ingest.mjs <dir|file>... [--url URL] [--only KIND] [--principals FILE]
//        [--principal ID] [--firm-domain DOMAIN] [--root DIR] [--delay MS]
//
// Each file becomes a complete session (ended_at set), so the distiller triages it at once. Ids
// are ses_ + sha1 of the file's real absolute path, so re-ingesting the same file upserts (from
// the whole world, a subfolder or the file alone) and two different files never share an id,
// even across separate runs. The parsing lives in lib.mjs (pure, tested); this file is flags,
// config and HTTP. A 404 or 401 from the server is logged once with a hint, the rest of the files
// are still tried, and the exit code says whether everything landed (0), something failed (1),
// or the flags or paths were wrong (2), which includes two files whose ids clash. A file that
// cannot be read or parsed is reported as `fail <path>: <reason>`, the run goes on, and the exit
// code is 1; so is a JSON or JSONL file with rows that could not be read (its good rows are still
// sent). A file with nothing to ingest (no text, over the size cap) is `skip <path>: <reason>`.
// Names and email addresses become principal ids only through --principals FILE.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDotEnv } from "../claude-code/lib.mjs";
import {
  CLIENT,
  DEFAULT_FIRM_DOMAIN,
  KINDS,
  buildItem,
  countList,
  isIngestible,
  kindFromWord,
  principalDirectory,
  readItem,
  resolvePrincipal,
  sessionIdFor,
  walk,
} from "./lib.mjs";

export const DEFAULT_URL = "http://localhost:4100";
/** Dev value, not a secret: .env.example's CANON_TOKEN_INGEST. The server must list ingest=<it>. */
export const DEV_TOKEN = "dev-ingest";
const POST_TIMEOUT_MS = 5000;

export const USAGE = `Usage: canon-ingest <dir|file>... [options]

Reads memos, chat, transcripts, email and notes and posts one session per file to the Bullwark
server as client "ingest". Kind comes from front-matter, folder name, file name, extension or
the text itself. README files and dotfiles are skipped.

Options:
  --dry-run              print the sessions as JSON on stdout; no network
  --url URL              Bullwark server (default: CANON_URL, else ${DEFAULT_URL})
  --only KIND            only items of this kind: ${KINDS.join(" | ")}
  --principals FILE      who is who: JSON list of principals ({ id, name, aliases?, emails? }, or
                         GET /api/principals' { principals }). The only way a name ("Dan Okafor")
                         or an address becomes a principal id; without it only ids (dan) count
  --principal ID         principal (author of the facts) for items that name no author at all.
                         Front-matter wins; an email's author is its firm sender or nobody, never
                         this flag. Chats and transcripts never take one from a speaker. The facts
                         join that person's scope as their own
  --firm-domain DOMAIN   senders outside it mark an email external (default ${DEFAULT_FIRM_DOMAIN})
  --root DIR             folder names under DIR count as kind signals and meta.path is relative to
                         it (default: the dir given, or a file's folder); ids never depend on it
  --delay MS             wait between posts, to drip items in live during a demo
  -h, --help             this text

Token: CANON_TOKEN_INGEST (env, then .env), else "${DEV_TOKEN}".`;

/** argv (without node and the script) → options, or { error }. */
export function parseArgs(argv) {
  const opts = { paths: [], dryRun: false, delay: 0 };
  const takes = new Set(["--url", "--only", "--principal", "--principals", "--firm-domain", "--root", "--delay"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (flag === "-h" || flag === "--help") return { help: true };
    if (flag === "--dry-run") opts.dryRun = true;
    else if (takes.has(flag)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === "") return { error: `${flag} needs a value` };
      opts[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    } else if (flag.startsWith("-")) return { error: `unknown option ${flag}` };
    else opts.paths.push(arg);
  }
  if (opts.paths.length === 0) return { error: "give at least one folder or file to ingest" };
  if (opts.only !== undefined) {
    const kind = kindFromWord(opts.only);
    if (!kind) return { error: `--only must be one of ${KINDS.join(", ")}` };
    opts.only = kind;
  }
  if (opts.delay !== 0) {
    const ms = Number(opts.delay);
    if (!Number.isFinite(ms) || ms < 0) return { error: "--delay must be a number of milliseconds" };
    opts.delay = ms;
  }
  return opts;
}

/**
 * CANON_URL / CANON_TOKEN_INGEST: flags win, then the process env, then the repo .env
 * (CANON_REPO_ROOT, else this checkout). No token anywhere → DEV_TOKEN, and `devToken` says so.
 */
export function resolveConfig(opts, env = process.env) {
  const candidates = [];
  if (env.CANON_REPO_ROOT) candidates.push(resolve(env.CANON_REPO_ROOT, ".env"));
  candidates.push(fileURLToPath(new URL("../../.env", import.meta.url)));
  const path = candidates.find((p) => existsSync(p));
  const fileEnv = path ? readDotEnv(path) : {};
  const pick = (name) => env[name] || fileEnv[name] || "";
  const token = pick("CANON_TOKEN_INGEST");
  return {
    url: (opts.url || pick("CANON_URL") || DEFAULT_URL).replace(/\/+$/, ""),
    token: token || DEV_TOKEN,
    devToken: !token,
  };
}

/** --principals FILE → a principal directory; throws with the file name on any problem. */
export function loadDirectory(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`--principals ${path}: ${e?.code === "ENOENT" ? "no such file" : (e?.message ?? e)}`);
  }
  try {
    return principalDirectory(value);
  } catch (e) {
    throw new Error(`--principals ${path}: ${e.message}`);
  }
}

/**
 * Every file to ingest: [{ abs, rel, key }] in a stable order. `rel` (relative to --root, else
 * the folder given, else the file's folder) feeds kind signals and meta.path; `key`, the real
 * absolute path, is what the session id comes from. So `a/notes.md` and `b/notes.md` get two ids
 * whether they are ingested together or in separate runs, and the same file named twice (or
 * through a symlink) is kept once. Two different files whose ids still clash (an 8-hex hash
 * collision) throw: the server upserts by id, so the second would overwrite the first in the
 * cold archive.
 */
export function collect(paths, root) {
  const items = [];
  for (const p of paths) {
    const abs = resolve(p);
    if (!existsSync(abs)) throw new Error(`${p}: no such file or folder`);
    if (statSync(abs).isDirectory()) {
      const base = root ? resolve(root) : abs;
      for (const rel of walk(abs)) {
        const file = resolve(abs, rel);
        items.push({ abs: file, rel: relative(base, file), key: realpathSync(file) });
      }
    } else {
      if (!isIngestible(abs)) throw new Error(`${p}: not an ingestible file (README or unsupported extension)`);
      items.push({ abs, rel: relative(root ? resolve(root) : dirname(abs), abs), key: realpathSync(abs) });
    }
  }
  const byId = new Map();
  const unique = [];
  for (const item of items) {
    const id = sessionIdFor(item.key);
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, item);
      unique.push(item);
    } else if (prev.key !== item.key) {
      throw new Error(
        `${prev.abs} and ${item.abs} would both be ${id} (their paths hash alike), so the second would overwrite ` +
          "the first in the archive. Rename or move one of them; nothing was sent.",
      );
    }
  }
  return unique;
}

/** One line per item: id, kind, principal, external, message count, path. */
export function summaryLine(s) {
  const n = `${s.messages.length} msg${s.messages.length === 1 ? "" : "s"}`;
  return [s.id, s.kind.padEnd(10), (s.principal ?? "-").padEnd(8), (s.external ? "external" : "").padEnd(8), n.padEnd(7), s.meta?.path ?? ""].join("  ");
}

/**
 * Runs the CLI. `io` is injectable for tests: { env, stdout, stderr, fetch, now, sleep }.
 * Returns the exit code instead of exiting.
 */
export async function run(argv, io = {}) {
  const env = io.env ?? process.env;
  const out = (s) => (io.stdout ?? process.stdout).write(`${s}\n`);
  const err = (s) => (io.stderr ?? process.stderr).write(`${s}\n`);
  const doFetch = io.fetch ?? fetch;
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const opts = parseArgs(argv);
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  if (opts.error) {
    err(`canon-ingest: ${opts.error}\n\n${USAGE}`);
    return 2;
  }

  let items;
  let directory;
  try {
    if (opts.principals) directory = loadDirectory(opts.principals);
    if (opts.principal !== undefined && !resolvePrincipal(opts.principal, directory)) {
      throw new Error(
        directory
          ? `--principal ${JSON.stringify(opts.principal)} is not in ${opts.principals}`
          : `--principal ${JSON.stringify(opts.principal)} is not a principal id (dan, agt_…); for a name or an address, pass --principals FILE`,
      );
    }
    items = collect(opts.paths, opts.root);
  } catch (e) {
    err(`canon-ingest: ${e.message}`);
    return 2;
  }

  const sessions = [];
  // Files that could not be read or parsed in full. Each is reported and the other items still
  // go, but the run exits 1: content that never reached the archive is a failure, not a skip.
  let unreadable = 0;
  for (const { abs, rel, key } of items) {
    let built;
    try {
      const read = readItem(abs);
      built = read.skip ? read : buildItem({ relPath: rel, idKey: key, text: read.text, firmDomain: opts.firmDomain, principal: opts.principal, directory, now: io.now });
    } catch (e) {
      built = { error: `could not read or parse it (${e?.message ?? e})` };
    }
    if (built.error) {
      unreadable++;
      err(`fail  ${rel}: ${built.error}`);
      continue;
    }
    if (built.skip) {
      err(`skip  ${rel}: ${built.skip}`);
      continue;
    }
    if (opts.only && built.kind !== opts.only) continue;
    const lost = [built.meta?.unparsed_lines?.length && countList("line", built.meta.unparsed_lines), built.meta?.unparsed_rows?.length && countList("row", built.meta.unparsed_rows)].filter(Boolean);
    if (lost.length) {
      unreadable++;
      err(`fail  ${rel}: ${lost.join(" and ")} could not be read (not valid JSON, not an object, or no text we can read) and left out; the rest is in the session`);
    }
    sessions.push(built);
  }
  const unreadNote = unreadable ? `, ${unreadable} file${unreadable === 1 ? "" : "s"} could not be read or parsed in full` : "";

  if (opts.dryRun) {
    for (const s of sessions) err(summaryLine(s));
    err(`dry run: ${sessions.length} session${sessions.length === 1 ? "" : "s"}, nothing sent${unreadNote}`);
    out(JSON.stringify(sessions, null, 2));
    return unreadable ? 1 : 0;
  }

  const { url, token, devToken } = resolveConfig(opts, env);
  const endpoint = `${url}/api/sessions`;
  if (devToken) err(`(dev token: CANON_TOKEN_INGEST not set, using ${DEV_TOKEN})`);

  let posted = 0;
  let failed = 0;
  const logged = new Set();
  const once = (key, line) => {
    if (logged.has(key)) return;
    logged.add(key);
    err(line);
  };

  for (const [i, s] of sessions.entries()) {
    if (i > 0 && opts.delay) await sleep(opts.delay);
    let res;
    try {
      res = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(s),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
    } catch (e) {
      const why = e?.cause?.code ?? e?.cause?.message ?? e?.name ?? String(e?.message ?? e);
      err(`POST ${endpoint} failed: ${why}. Is the Bullwark server running (npm run dev)? Stopped after ${posted} of ${sessions.length}.`);
      return 1;
    }
    if (res.ok) {
      posted++;
      const body = await res.json().catch(() => ({}));
      out(`${summaryLine(s)}  → ${res.status}${body.updated ? " updated" : " new"}`);
      continue;
    }
    failed++;
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    once(res.status, `POST ${endpoint} → ${res.status} ${detail}${hintFor(res.status)}`.trim());
  }

  err(`${posted} posted, ${failed} failed, ${sessions.length} total → ${url}${unreadNote}`);
  return failed || unreadable ? 1 : 0;
}

function hintFor(status) {
  if (status === 401) return `\n  hint: the server does not know this token. Add ${CLIENT}=${DEV_TOKEN} (or your CANON_TOKEN_INGEST) to CANON_CLIENT_TOKENS in .env and restart the server.`;
  if (status === 403) return `\n  hint: the token belongs to another client; CANON_TOKEN_INGEST must be the ${CLIENT}=… token.`;
  if (status === 404) return "\n  hint: no /api/sessions here. Is --url / CANON_URL a Bullwark server? (Logged once; the other files were still tried.)";
  return "";
}

/** Run as a script, also through a symlink: Node resolves import.meta.url to the real path. */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`canon-ingest: ${e?.stack ?? e}\n`);
      process.exit(1);
    },
  );
}
