#!/usr/bin/env node
// Opens Claude Code as one synthetic person, with the whole Bullwark loop on for that session only.
//
//   npm run demo:claude -- dollar-bill                 # this machine's server, token from .env
//   npm run demo:claude -- axe --url https://…         # a shared server (the team preview)
//   npm run demo:claude -- ben --token <ben's token>   # a token handed to you directly
//   npm run demo:claude -- dollar-bill -- --model opus # everything after `--` goes to claude
//   npm run demo:claude                                # list the people this .env can open
//
// The checkout's .env can keep CANON_CAPTURE=0 and CANON_CONTEXT=0 so day-to-day coding sessions
// never become anyone's memory. This launcher sets, for the launched process only:
//   CANON_PERSON_TOKEN  the person's own token: capture, before-prompt memory and the canon MCP
//                       server (.mcp.json) all act as them
//   CANON_CAPTURE=1     the Stop/SessionEnd hook records the session as theirs
//   CANON_CONTEXT=1     the UserPromptSubmit hook adds their memory before every prompt
//   CANON_URL           the server they belong to
// Before launching it asks that server who the token is (GET /api/me). Only a person opens a
// session: an internal worker token (distiller, dispatcher, ingest, …) has no principal and is
// refused. The token is never printed.
//
// The session opens in the person's own empty workspace (<tmp>/bullwark-demo/<person>/), not in
// this repo: there Claude could read the raw demo world off disk (every group, every person's
// facts) instead of answering from the person's memory. The workspace holds only a CLAUDE.md, the
// hooks (this checkout's scripts, by absolute path) and the canon MCP server with its read tools
// allowed.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseClientTokens, parseDotEnv } from "./doctor.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_URL = "http://localhost:4100";
const ME_TIMEOUT_MS = 4000;

/** `[person] [--url u] [--token t] [--dry-run] [-- claude args…]` → options, or an error string. */
export function parseArgs(argv) {
  const out = { person: "", url: "", token: "", dryRun: false, claudeArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { out.claudeArgs = argv.slice(i + 1); break; }
    if (arg === "--dry-run") { out.dryRun = true; continue; }
    if (arg === "--url" || arg === "--token") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) return { error: `${arg} needs a value` };
      out[arg.slice(2)] = value;
      continue;
    }
    if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
    if (out.person) return { error: `one person at a time (got "${out.person}" and "${arg}")` };
    out.person = arg;
  }
  return out;
}

/** The client → token pairs this machine knows, process env first, then the .env. */
export function knownTokens(env, dotenv) {
  const byToken = parseClientTokens(env.CANON_CLIENT_TOKENS || dotenv.CANON_CLIENT_TOKENS);
  return new Map([...byToken].map(([token, client]) => [client, token]));
}

/** The environment for the launched claude process: the caller's, with the loop switched on as `token`. */
export function launchEnv(base, { token, url }) {
  return { ...base, CANON_PERSON_TOKEN: token, CANON_URL: url, CANON_CAPTURE: "1", CANON_CONTEXT: "1" };
}

/** The canon tools a demo session may call without asking. canon_save is left out: the hooks already capture the session. */
export const ALLOWED_TOOLS = ["mcp__canon__canon_whoami", "mcp__canon__canon_context", "mcp__canon__canon_search"];

/** A person's demo workspace: path relative to the workspace → contents. */
export function workspaceFiles(person, repoRoot = root) {
  const hook = (name) => {
    const script = join(repoRoot, "hooks", "claude-code", name).replace(/\\/g, "/");
    return [{ hooks: [{ type: "command", command: `node "${script}"`, timeout: 15 }] }];
  };
  const settings = {
    hooks: { Stop: hook("canon-capture.mjs"), SessionEnd: hook("canon-capture.mjs"), UserPromptSubmit: hook("canon-context.mjs") },
    permissions: { allow: ALLOWED_TOOLS },
    enableAllProjectMcpServers: true,
  };
  // Claude Code expands these from the launched process's environment (launchEnv).
  const mcp = { mcpServers: { canon: { type: "http", url: "${CANON_URL}/mcp", headers: { Authorization: "Bearer ${CANON_PERSON_TOKEN}" } } } };
  const guide = [
    `# Working as ${person.name}`,
    "",
    `You are ${person.name}'s work assistant at Axe Capital.${person.task ? ` Their task: ${person.task}` : ""}`,
    "",
    `What you know about the firm is ${person.name}'s Bullwark memory: the memory added before each prompt, and the canon tools (canon_context, canon_search) when you need more. Answer from that memory. There are no project files here to look through. If the memory does not cover something, say it is not in your memory.`,
    "",
  ].join("\n");
  return {
    ".claude/settings.json": `${JSON.stringify(settings, null, 2)}\n`,
    ".mcp.json": `${JSON.stringify(mcp, null, 2)}\n`,
    "CLAUDE.md": guide,
  };
}

/** Writes the person's workspace (again on every launch, so it follows this checkout) and returns its path. */
export function prepareWorkspace(person, base = join(tmpdir(), "bullwark-demo")) {
  const dir = join(base, person.id);
  for (const [rel, text] of Object.entries(workspaceFiles(person))) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

/** cmd.exe joins a shell spawn's args with spaces, so on Windows any arg with spaces or quotes is quoted. */
export function shellArgs(args, platform = process.platform) {
  if (platform !== "win32") return args;
  return args.map((a) => (a === "" || /[\s"&|<>^%]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a));
}

/** GET /api/me with the token: a person record, or a reason it cannot open a session. */
export async function whoIs(url, token, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(`${url.replace(/\/$/, "")}/api/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(ME_TIMEOUT_MS) });
  } catch (err) {
    const why = err?.cause?.code ?? err?.name ?? String(err?.message ?? err);
    return { error: `cannot reach ${url} (${why}). Start it with \`npm run dev\`, or pass --url.` };
  }
  if (res.status === 401) return { error: `${url} does not know this token.` };
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.kind !== "person") return { error: "this token is not a person's (worker and agent tokens cannot open a session)." };
  return { person: body };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ("error" in args) return fail(args.error);

  const dotenvPath = join(root, ".env");
  const dotenv = existsSync(dotenvPath) ? parseDotEnv(readFileSync(dotenvPath, "utf8")) : {};
  const url = args.url || process.env.CANON_URL || dotenv.CANON_URL || DEFAULT_URL;
  const tokens = knownTokens(process.env, dotenv);

  if (!args.person && !args.token) {
    console.log("Usage: npm run demo:claude -- <person> [--url <server>] [--token <token>] [-- <claude args>]\n");
    const people = [];
    for (const [client, token] of tokens) {
      const who = await whoIs(url, token);
      if ("person" in who) people.push(`  ${client.padEnd(14)} ${who.person.name} (${who.person.tier ?? "member"})`);
      else if (who.error.startsWith("cannot reach")) return fail(who.error);
    }
    console.log(people.length ? `People on ${url}:\n${people.join("\n")}` : `No person tokens in CANON_CLIENT_TOKENS for ${url}.`);
    return;
  }

  const token = args.token || tokens.get(args.person);
  if (!token) return fail(`no token for "${args.person}" in CANON_CLIENT_TOKENS. Pass --token, or run \`npm run demo:claude\` to list people.`);
  const who = await whoIs(url, token);
  if ("error" in who) return fail(who.error);
  if (args.person && !args.token && who.person.id !== args.person) return fail(`the token for "${args.person}" belongs to ${who.person.id}.`);

  const { person } = who;
  console.log(`Claude Code as ${person.name} (${person.tier ?? "member"}) on ${url}`);
  console.log(`  memory before every prompt · this session saved as ${person.name}'s · canon MCP tools act as ${person.name}`);
  if (person.task) console.log(`  their task: ${person.task}`);
  if (args.dryRun) return;
  const workspace = prepareWorkspace(person);
  console.log(`  workspace: ${workspace} (memory only, no repo files)`);

  const child = spawn("claude", shellArgs(args.claudeArgs), {
    cwd: workspace,
    env: launchEnv(process.env, { token, url }),
    stdio: "inherit",
    // claude is a .cmd shim on Windows, which only a shell can start.
    shell: process.platform === "win32",
  });
  child.on("error", (err) => fail(`could not start claude: ${err.message}. Is Claude Code installed and on PATH?`));
  child.on("exit", (code) => process.exit(code ?? 0));
}

function fail(message) {
  console.error(`demo:claude: ${message}`);
  process.exit(1);
}

function isMain() {
  if (!process.argv[1]) return false;
  const argv = resolve(process.argv[1]);
  const self = fileURLToPath(import.meta.url);
  return process.platform === "win32" ? argv.toLowerCase() === self.toLowerCase() : argv === self;
}

if (isMain()) await main();
