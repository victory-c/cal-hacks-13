#!/usr/bin/env node
// Claude Code capture hook. Wired to the Stop and SessionEnd hook events (see install.mjs).
// Reads the hook payload from stdin, turns the transcript into a CapturedSession and POSTs it
// to the Canon server, which upserts by id (Stop = live update, SessionEnd = final, ended_at).
//
// One token for both directions: with CANON_PERSON_TOKEN set (the same value canon-context.mjs
// reads), the session is posted with it and names no principal; the server binds the author to
// the token. Without it, the operator path: CANON_TOKEN_CLAUDE_CODE (or the dev token) plus an
// optional CANON_PRINCIPAL, which the server accepts only from ingest or an internal client.
//
// Non-negotiable: this must NEVER block or break the user's session. Everything is caught,
// the exit code is always 0, stdout stays empty (Claude Code reads a Stop hook's stdout as a
// decision), and stderr gets one short line only when CANON_DEBUG=1.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLIENT, buildSession, gitInfo, parseTranscript, resolveEnv } from "./lib.mjs";

const DEFAULT_URL = "http://localhost:4100";
// Same value as the server's dev fallback (server/src/auth.ts DEV_CLIENT_TOKENS) and .env.example,
// so a fresh clone with no .env still captures. A dev value, not a secret.
const DEV_TOKEN = "dev-claude-code";
const POST_TIMEOUT_MS = 3000;
// If anything hangs (a stuck stdin, a slow DNS), leave anyway. Unref'd so it never keeps the
// process alive on its own.
const WATCHDOG_MS = 10_000;
/** Longest server error text folded into the debug line; the line stays one line either way. */
const ERROR_MAX = 200;

const DEBUG = process.env.CANON_DEBUG === "1";
const debug = DEBUG ? (msg) => process.stderr.write(`[canon] ${msg}\n`) : () => {};

process.on("uncaughtException", (err) => bail(`uncaught: ${String(err?.message ?? err)}`));
process.on("unhandledRejection", (err) => bail(`unhandled: ${String(err?.message ?? err)}`));
setTimeout(() => bail("watchdog: gave up after 10s"), WATCHDOG_MS).unref();

main().then(
  () => process.exit(0),
  (err) => bail(String(err?.message ?? err)),
);

function bail(msg) {
  debug(msg);
  process.exit(0);
}

async function main() {
  // Opt-out for anyone who has the project hook but doesn't want this session captured.
  if (process.env.CANON_CAPTURE === "0") return debug("skip: CANON_CAPTURE=0");
  const payload = JSON.parse(await readStdin());
  const transcriptPath = payload.transcript_path ? resolve(process.cwd(), payload.transcript_path) : "";
  if (!transcriptPath || !existsSync(transcriptPath)) return debug(`skip: transcript not found (${transcriptPath || "none"})`);

  const messages = parseTranscript(readFileSync(transcriptPath, "utf8"));
  if (messages.length === 0) return debug("skip: transcript has 0 messages");

  const { url, token, person, devToken, principal } = resolveConfig();
  // Folded into the one debug line below (never a second line): the fallback stays visible.
  const tokenNote = devToken ? " (dev token: CANON_TOKEN_CLAUDE_CODE not set)" : "";

  const session = buildSession({
    payload,
    messages,
    hookEvent: payload.hook_event_name,
    git: gitInfo(payload.cwd ?? process.cwd()),
    // A person token names nobody: the server binds the author to the token, and a body field
    // naming anyone is one constant 403 (PIPELINE-PRD, Rule 1).
    principal: person ? undefined : principal,
  });

  const endpoint = `${url.replace(/\/$/, "")}/api/sessions`;
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(session),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (err) {
    // undici wraps the useful part (ECONNREFUSED, ENOTFOUND, "bad port") under err.cause;
    // a timeout arrives as err.name === "TimeoutError" with no cause.
    const why = err?.cause?.code ?? err?.cause?.message ?? err?.name ?? String(err?.message ?? err);
    return debug(`POST ${endpoint} failed: ${why} (is the Bullwark server running?)${tokenNote}`);
  }
  // Only the debug line reads the body, so the silent path does no more work than before.
  const rejected = res.ok ? "" : ` (server rejected${DEBUG ? await serverError(res) : ""})`;
  debug(`${payload.hook_event_name ?? "?"} ${session.id} ${messages.length} msgs ${describeAuth(session, person, principal)} → ${res.status}${rejected}${tokenNote}`);
}

/**
 * Which mode the hook used, for the debug line: `as person token` (CANON_PERSON_TOKEN; the server
 * knows who), `as claude-code, principal dan` (operator token naming an author), `as claude-code
 * with no principal (…)` (CANON_PRINCIPAL set but not an id), or plain `as claude-code`.
 */
function describeAuth(session, person, principal) {
  if (person) return "as person token";
  if (session.principal) return `as ${CLIENT}, principal ${session.principal}`;
  if (principal.trim()) return `as ${CLIENT} with no principal (CANON_PRINCIPAL is not an id like dan)`;
  return `as ${CLIENT}`;
}

/**
 * The server's `error` text from a non-2xx JSON body, as `: <text>`, so a misconfigured machine
 * says why in its one debug line (a capture token naming a principal, an unknown token…).
 * Defensive: a body of any shape, or none at all, gives "".
 */
async function serverError(res) {
  try {
    const body = JSON.parse(await res.text());
    const text = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : "";
    const oneLine = text.replace(/\s+/g, " ").trim();
    if (!oneLine) return "";
    return `: ${oneLine.length > ERROR_MAX ? `${oneLine.slice(0, ERROR_MAX)}…` : oneLine}`;
  } catch {
    return "";
  }
}

/**
 * CANON_URL / CANON_PERSON_TOKEN / CANON_TOKEN_CLAUDE_CODE / CANON_PRINCIPAL through resolveEnv
 * (lib.mjs, shared with canon-context.mjs): process env wins, then the repo .env (CANON_REPO_ROOT
 * when set, else the checkout this script lives in). CANON_PERSON_TOKEN set → the person path:
 * that token, no principal in the body. Else the operator path: CANON_TOKEN_CLAUDE_CODE, or
 * DEV_TOKEN (the same default the server accepts without a .env; `devToken` says so, so the
 * fallback can be surfaced in the debug line), plus CANON_PRINCIPAL when set.
 */
function resolveConfig() {
  const env = resolveEnv(["CANON_URL", "CANON_PERSON_TOKEN", "CANON_TOKEN_CLAUDE_CODE", "CANON_PRINCIPAL"]);
  const url = env.CANON_URL || DEFAULT_URL;
  if (env.CANON_PERSON_TOKEN) return { url, token: env.CANON_PERSON_TOKEN, person: true, devToken: false, principal: "" };
  const token = env.CANON_TOKEN_CLAUDE_CODE;
  return { url, token: token || DEV_TOKEN, person: false, devToken: !token, principal: env.CANON_PRINCIPAL };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
