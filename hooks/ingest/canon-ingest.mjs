#!/usr/bin/env node
// Ingest CLI: reads a folder of firm content (memos, team chat, meeting transcripts, email,
// notes) and POSTs one CapturedSession per file to POST /api/sessions as client "ingest". This
// is the PRD's third capture path next to the Claude Code hook and the ChatGPT extension, and the
// one the synthetic world (Harbor Lane, Project Falcon) arrives through.
//
//   node hooks/ingest/canon-ingest.mjs hooks/fixtures/world --dry-run
//   node hooks/ingest/canon-ingest.mjs <dir|file>... [--url URL] [--only KIND] [--principal ID]
//        [--firm-domain DOMAIN] [--root DIR] [--delay MS]
//
// Each file becomes a complete session (ended_at set), so the distiller triages it at once. Ids
// are ses_ + sha1 of the path relative to the root, so re-ingesting the same root upserts. The
// parsing lives in lib.mjs (pure, tested); this file is flags, config and HTTP. A 404 or 401
// from the server is logged once with a hint, the rest of the files are still tried, and the
// exit code says whether everything landed (0), something failed (1) or the flags were wrong (2).

import { existsSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readDotEnv } from "../claude-code/lib.mjs";
import { CLIENT, DEFAULT_FIRM_DOMAIN, KINDS, buildItem, isIngestible, kindFromWord, readItem, walk } from "./lib.mjs";

export const DEFAULT_URL = "http://localhost:4100";
/** Dev value, not a secret: .env.example's CANON_TOKEN_INGEST. The server must list ingest=<it>. */
export const DEV_TOKEN = "dev-ingest";
const POST_TIMEOUT_MS = 5000;

export const USAGE = `Usage: canon-ingest <dir|file>... [options]

Reads memos, chat, transcripts, email and notes and posts one session per file to the Canon
server as client "ingest". Kind comes from front-matter, folder name, file name, extension or
the text itself. README files and dotfiles are skipped.

Options:
  --dry-run              print the sessions as JSON on stdout; no network
  --url URL              Canon server (default: CANON_URL, else ${DEFAULT_URL})
  --only KIND            only items of this kind: ${KINDS.join(" | ")}
  --principal ID         principal for items that name none (front-matter, sender, speaker win)
  --firm-domain DOMAIN   senders outside it mark an email external (default ${DEFAULT_FIRM_DOMAIN})
  --root DIR             ids come from paths relative to DIR (default: the dir given, or a file's folder)
  --delay MS             wait between posts, to drip items in live during a demo
  -h, --help             this text

Token: CANON_TOKEN_INGEST (env, then .env), else "${DEV_TOKEN}".`;

/** argv (without node and the script) → options, or { error }. */
export function parseArgs(argv) {
  const opts = { paths: [], dryRun: false, delay: 0 };
  const takes = new Set(["--url", "--only", "--principal", "--firm-domain", "--root", "--delay"]);
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

/** Every file to ingest with the path its id comes from: [{ abs, rel }], in a stable order. */
export function collect(paths, root) {
  const items = [];
  for (const p of paths) {
    const abs = resolve(p);
    if (!existsSync(abs)) throw new Error(`${p}: no such file or folder`);
    if (statSync(abs).isDirectory()) {
      const base = root ? resolve(root) : abs;
      for (const rel of walk(abs)) items.push({ abs: resolve(abs, rel), rel: relative(base, resolve(abs, rel)) });
    } else {
      if (!isIngestible(abs)) throw new Error(`${p}: not an ingestible file (README or unsupported extension)`);
      items.push({ abs, rel: relative(root ? resolve(root) : dirname(abs), abs) });
    }
  }
  return items;
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
  try {
    items = collect(opts.paths, opts.root);
  } catch (e) {
    err(`canon-ingest: ${e.message}`);
    return 2;
  }

  const sessions = [];
  for (const { abs, rel } of items) {
    const read = readItem(abs);
    const built = read.skip ? read : buildItem({ relPath: rel, text: read.text, firmDomain: opts.firmDomain, principal: opts.principal, now: io.now });
    if (built.skip) {
      err(`skip  ${rel}: ${built.skip}`);
      continue;
    }
    if (opts.only && built.kind !== opts.only) continue;
    sessions.push(built);
  }

  if (opts.dryRun) {
    for (const s of sessions) err(summaryLine(s));
    err(`dry run: ${sessions.length} session${sessions.length === 1 ? "" : "s"}, nothing sent`);
    out(JSON.stringify(sessions, null, 2));
    return 0;
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
      err(`POST ${endpoint} failed: ${why}. Is the Canon server running (npm run dev)? Stopped after ${posted} of ${sessions.length}.`);
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

  err(`${posted} posted, ${failed} failed, ${sessions.length} total → ${url}`);
  return failed ? 1 : 0;
}

function hintFor(status) {
  if (status === 401) return `\n  hint: the server does not know this token. Add ${CLIENT}=${DEV_TOKEN} (or your CANON_TOKEN_INGEST) to CANON_CLIENT_TOKENS in .env and restart the server.`;
  if (status === 403) return `\n  hint: the token belongs to another client; CANON_TOKEN_INGEST must be the ${CLIENT}=… token.`;
  if (status === 404) return "\n  hint: no /api/sessions here. Is --url / CANON_URL a Canon server? (Logged once; the other files were still tried.)";
  return "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`canon-ingest: ${e?.stack ?? e}\n`);
      process.exit(1);
    },
  );
}
