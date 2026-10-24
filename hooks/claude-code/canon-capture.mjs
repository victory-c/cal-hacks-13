#!/usr/bin/env node
// Claude Code capture hook. Wired to the Stop and SessionEnd hook events (see install.mjs).
// Reads the hook payload from stdin, turns the transcript into a CapturedSession and POSTs it
// to the Canon server, which upserts by id (Stop = live update, SessionEnd = final, ended_at).
//
// Non-negotiable: this must NEVER block or break the user's session. Everything is caught,
// the exit code is always 0, stdout stays empty (Claude Code reads a Stop hook's stdout as a
// decision), and stderr gets one short line only when CANON_DEBUG=1.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSession, gitInfo, parseTranscript, readDotEnv } from "./lib.mjs";

const DEFAULT_URL = "http://localhost:4100";
// Same value as the server's dev fallback (server/src/auth.ts DEV_CLIENT_TOKENS) and .env.example,
// so a fresh clone with no .env still captures. A dev value, not a secret.
const DEV_TOKEN = "dev-claude-code";
const POST_TIMEOUT_MS = 3000;
// If anything hangs (a stuck stdin, a slow DNS), leave anyway. Unref'd so it never keeps the
// process alive on its own.
const WATCHDOG_MS = 10_000;

const debug = process.env.CANON_DEBUG === "1" ? (msg) => process.stderr.write(`[canon] ${msg}\n`) : () => {};

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

  const { url, token, devToken, principal } = resolveConfig();
  // Folded into the one debug line below (never a second line): the fallback stays visible.
  const tokenNote = devToken ? " (dev token: CANON_TOKEN_CLAUDE_CODE not set)" : "";

  const session = buildSession({
    payload,
    messages,
    hookEvent: payload.hook_event_name,
    git: gitInfo(payload.cwd ?? process.cwd()),
    principal,
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
  const as = session.principal ? ` as ${session.principal}` : "";
  debug(`${payload.hook_event_name ?? "?"} ${session.id} ${messages.length} msgs${as} → ${res.status}${res.ok ? "" : " (server rejected)"}${tokenNote}`);
}

/**
 * CANON_URL / CANON_TOKEN_CLAUDE_CODE / CANON_PRINCIPAL: process env wins, then the repo .env.
 * The repo is CANON_REPO_ROOT when set, else the checkout this script lives in
 * (hooks/claude-code → ../../). No token anywhere → DEV_TOKEN, the same default the server
 * accepts without a .env; `devToken` says so, so the fallback can be surfaced in the debug line.
 * No principal anywhere → none is sent (v2: triage treats an unknown principal cautiously).
 */
function resolveConfig() {
  const candidates = [];
  if (process.env.CANON_REPO_ROOT) candidates.push(resolve(process.env.CANON_REPO_ROOT, ".env"));
  candidates.push(fileURLToPath(new URL("../../.env", import.meta.url)));

  let fileEnv = {};
  for (const path of candidates) {
    if (existsSync(path)) {
      fileEnv = readDotEnv(path);
      break;
    }
  }
  const pick = (name) => process.env[name] || fileEnv[name] || "";
  const token = pick("CANON_TOKEN_CLAUDE_CODE");
  return { url: pick("CANON_URL") || DEFAULT_URL, token: token || DEV_TOKEN, devToken: !token, principal: pick("CANON_PRINCIPAL") };
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
