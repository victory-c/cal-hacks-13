#!/usr/bin/env node
// Claude Code context hook. Wired to the UserPromptSubmit hook event: before Claude sees each
// prompt, ask the Bullwark server for this person's memory (POST /api/handoff with their own
// per-person token) and add whatever it hands back to the prompt's context. The server decides
// everything: only facts inside the person's scope are candidates, Jev judges whether the prompt
// needs stored context at all and which facts help, and a token budget caps the slice. The hook
// only formats the reply (formatContext in lib.mjs).
//
// Off unless CANON_PERSON_TOKEN is set (the person's own token, e.g. dev-dollar-bill, the one
// value canon-capture.mjs posts with too): the principal comes from that token on the server,
// never from this machine.
//
// Non-negotiable, as for the capture hook: this must NEVER block or break the user's session.
// Everything is caught and the exit code is always 0. stdout carries only the JSON that adds
// context, and only when there is some; on any failure the prompt goes through untouched, and
// stderr gets one short line when CANON_DEBUG=1.

import { formatContext, resolveEnv } from "./lib.mjs";

const DEFAULT_URL = "http://localhost:4100";
// A live handoff is two judge calls; leave room for them, but never hold a prompt for long.
const POST_TIMEOUT_MS = 8000;
const WATCHDOG_MS = 12_000;

const debug = process.env.CANON_DEBUG === "1" ? (msg) => process.stderr.write(`[canon] ${msg}\n`) : () => {};

process.on("uncaughtException", (err) => bail(`uncaught: ${String(err?.message ?? err)}`));
process.on("unhandledRejection", (err) => bail(`unhandled: ${String(err?.message ?? err)}`));
setTimeout(() => bail("watchdog: gave up after 12s"), WATCHDOG_MS).unref();

main().then(
  () => process.exit(0),
  (err) => bail(String(err?.message ?? err)),
);

function bail(msg) {
  debug(msg);
  process.exit(0);
}

async function main() {
  if (process.env.CANON_CONTEXT === "0") return debug("skip: CANON_CONTEXT=0");
  const { url, token, budget } = resolveConfig();
  if (!token) return debug("skip: CANON_PERSON_TOKEN not set");
  const payload = JSON.parse(await readStdin());
  const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
  // An empty prompt or a slash command is not a question for the memory.
  if (!prompt || prompt.startsWith("/")) return debug("skip: no prompt");

  const endpoint = `${url.replace(/\/$/, "")}/api/handoff`;
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ task: prompt, ...(budget ? { budget_tokens: budget } : {}) }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (err) {
    const why = err?.cause?.code ?? err?.cause?.message ?? err?.name ?? String(err?.message ?? err);
    return debug(`POST ${endpoint} failed: ${why} (is the Bullwark server running?)`);
  }
  if (!res.ok) return debug(`POST ${endpoint} → ${res.status}`);
  const result = await res.json();
  const context = formatContext(result);
  debug(`handoff → ${Array.isArray(result?.facts) ? result.facts.length : 0} facts, ${result?.tokens ?? 0} tokens`);
  if (!context) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }));
}

/**
 * CANON_URL / CANON_PERSON_TOKEN / CANON_CONTEXT_BUDGET through resolveEnv (lib.mjs): process env
 * wins, then the repo .env (CANON_REPO_ROOT when set, else the checkout this script lives in).
 * The same lookup canon-capture.mjs uses, so one CANON_PERSON_TOKEN serves both directions.
 */
function resolveConfig() {
  const env = resolveEnv(["CANON_URL", "CANON_PERSON_TOKEN", "CANON_CONTEXT_BUDGET"]);
  const budget = Number(env.CANON_CONTEXT_BUDGET);
  return { url: env.CANON_URL || DEFAULT_URL, token: env.CANON_PERSON_TOKEN, budget: Number.isFinite(budget) && budget > 0 ? budget : undefined };
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
