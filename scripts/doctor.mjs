#!/usr/bin/env node
// Preflight for a fresh clone, or for the 4 AM "why is nothing working" moment.
// Usage: npm run doctor        (no dependencies; never prints key or token values)
//
// The checks that need no network or filesystem are pure functions, exported and tested in
// doctor.test.mjs; main() below reads the files and the ports and prints ok / warn / FAIL lines.

import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let fatal = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const warn = (m) => console.log(`  warn  ${m}`);
const bad = (m) => {
  fatal++;
  console.log(`  FAIL  ${m}`);
};
/** Prints a pure check's result (null = nothing to say). */
const report = (r) => {
  if (!r) return;
  (r.level === "ok" ? ok : r.level === "warn" ? warn : bad)(r.message);
};

/** The hook events the committed .claude/settings.json must wire, and the script each one runs. */
export const HOOK_SCRIPTS = { Stop: "canon-capture.mjs", SessionEnd: "canon-capture.mjs", UserPromptSubmit: "canon-context.mjs" };

/**
 * Flat .env text → { KEY: value }: comments, blank lines and an unquoted ` #` tail dropped,
 * matching quotes stripped. The same subset hooks/claude-code/lib.mjs readDotEnv reads, so the
 * doctor and the hooks agree on what a line means.
 */
export function parseDotEnv(text) {
  const env = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    let value = t.slice(i + 1).trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    value = quoted ? quoted[2] : value.split(" #")[0].trim();
    env[t.slice(0, i).trim()] = value;
  }
  return env;
}

/** `client=token,…` → Map token → client, exactly as shared/src/grants.ts parseClientTokens does. */
export function parseClientTokens(raw) {
  const map = new Map();
  for (const entry of String(raw ?? "").split(",")) {
    const i = entry.indexOf("=");
    if (i <= 0) continue;
    const client = entry.slice(0, i).trim();
    const token = entry.slice(i + 1).trim();
    if (client && token) map.set(token, client);
  }
  return map;
}

/**
 * CANON_PERSON_TOKEN, when set, must be a token value in CANON_CLIENT_TOKENS whose client is a
 * `kind: "person"` principal of the world: that is what lets the server bind this machine's
 * captures and reads to one person (docs/PIPELINE-PRD.md 4.1). The token is never echoed.
 * `principals` is fixtures/world/world.json's list; `tokensSource` names where the pairs came from.
 */
export function checkPersonToken({ personToken, clientTokens, principals, tokensSource = "CANON_CLIENT_TOKENS" }) {
  if (!personToken) return null;
  const client = parseClientTokens(clientTokens).get(personToken);
  if (!client) {
    return { level: "FAIL", message: `CANON_PERSON_TOKEN is not a token value in ${tokensSource}: the server would answer 401. Add a <your-id>=<token> pair there, or use one that exists.` };
  }
  const principal = (Array.isArray(principals) ? principals : []).find((p) => p && p.id === client);
  if (!principal) {
    return { level: "FAIL", message: `CANON_PERSON_TOKEN maps to client "${client}", which is not a principal in fixtures/world/world.json: captures would have no author and the context hook nothing to read. Use a person's token (dollar-bill=…, ben=…).` };
  }
  if (principal.kind !== "person") {
    return { level: "FAIL", message: `CANON_PERSON_TOKEN maps to "${client}", a ${principal.kind ?? "non-person"} principal, not a person. Both hooks need a person's token.` };
  }
  return { level: "ok", message: `CANON_PERSON_TOKEN maps to person "${client}" (both hooks and the MCP header act as them)` };
}

/** A machine that can capture but names no author. */
export function checkAuthor({ personToken, principal }) {
  if (personToken || principal) return null;
  return { level: "warn", message: "neither CANON_PERSON_TOKEN nor CANON_PRINCIPAL is set: captures will have no author. Set CANON_PERSON_TOKEN, the one value a person needs." };
}

/**
 * .mcp.json text (undefined when the file is missing) → one result: it parses, has
 * mcpServers.bullwark over http at …/mcp, and its Authorization header reads ${CANON_PERSON_TOKEN}
 * from the environment rather than holding a token.
 */
export function checkMcpJson(text) {
  if (text === undefined || text === null) {
    return { level: "FAIL", message: ".mcp.json missing at the repo root: Claude Code has no Bullwark MCP server (git checkout .mcp.json)" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { level: "FAIL", message: `.mcp.json does not parse: ${err.message}` };
  }
  const server = parsed?.mcpServers?.bullwark;
  if (!server || typeof server !== "object") return { level: "FAIL", message: ".mcp.json has no mcpServers.bullwark entry" };
  const problems = [];
  if (server.type !== "http") problems.push(`type is ${JSON.stringify(server.type)}, expected "http"`);
  if (typeof server.url !== "string" || !server.url.endsWith("/mcp")) problems.push("url should end with /mcp");
  const auth = server.headers?.Authorization;
  if (typeof auth !== "string" || !/^Bearer \$\{CANON_PERSON_TOKEN/.test(auth)) {
    problems.push("headers.Authorization should be `Bearer ${CANON_PERSON_TOKEN…}` (read from the environment), never a literal token");
  }
  if (problems.length) return { level: "FAIL", message: `.mcp.json: ${problems.join("; ")}` };
  return { level: "ok", message: ".mcp.json wires the bullwark MCP server (http, …/mcp, Authorization from CANON_PERSON_TOKEN)" };
}

/**
 * Parsed .claude/settings.json → one result per event in HOOK_SCRIPTS: the event runs its script
 * and declares a timeout (SessionEnd gets 1.5 s otherwise). A command written with the bare
 * $CLAUDE_PROJECT_DIR warns: PowerShell expands it to nothing and the hook never runs there; the
 * braced ${CLAUDE_PROJECT_DIR} works in both shells.
 */
export function checkHookWiring(settings) {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    return [{ level: "FAIL", message: ".claude/settings.json has no hooks block: neither hook runs (node hooks/claude-code/install.mjs --project)" }];
  }
  const results = [];
  for (const [event, script] of Object.entries(HOOK_SCRIPTS)) {
    const entries = (Array.isArray(hooks[event]) ? hooks[event] : [])
      .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
      .filter((h) => typeof h?.command === "string" && h.command.includes(`hooks/claude-code/${script}`));
    if (entries.length === 0) {
      results.push({ level: "FAIL", message: `.claude/settings.json: ${event} does not run hooks/claude-code/${script} (node hooks/claude-code/install.mjs --project)` });
      continue;
    }
    if (entries.some((h) => h.command.includes("$CLAUDE_PROJECT_DIR"))) {
      results.push({ level: "warn", message: `.claude/settings.json: ${event} uses the bare $CLAUDE_PROJECT_DIR, which PowerShell expands to nothing; write \${CLAUDE_PROJECT_DIR} (node hooks/claude-code/install.mjs --project)` });
    } else if (entries.some((h) => typeof h.timeout !== "number")) {
      results.push({ level: "warn", message: `.claude/settings.json: ${event} → ${script} has no timeout (SessionEnd hooks get 1.5 s without one; ours declare 15)` });
    } else {
      results.push({ level: "ok", message: `.claude/settings.json: ${event} → ${script}` });
    }
  }
  return results;
}

async function main() {
  console.log("Bullwark doctor\n");

  // Node version
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) ok(`node ${process.versions.node}`);
  else bad(`node ${process.versions.node}: need 22+ (see .nvmrc)`);

  // Workspaces installed
  if (existsSync(join(root, "node_modules", "@canon", "shared"))) ok("workspaces installed");
  else bad("node_modules missing: run `npm install` at the repo root");

  // .env
  const envPath = join(root, ".env");
  const env = {};
  if (!existsSync(envPath)) {
    warn(".env missing: `cp .env.example .env`. Everything still runs on local stubs.");
  } else {
    Object.assign(env, parseDotEnv(readFileSync(envPath, "utf8")));
    for (const k of ["ANTHROPIC_API_KEY", "JEV_API_KEY", "FACTORY_API_KEY", "MOSS_PROJECT_KEY"]) {
      if (env[k]) ok(`${k} set`);
      else warn(`${k} empty (that integration runs as a stub)`);
    }
    if (env.CANON_CLIENT_TOKENS) ok("CANON_CLIENT_TOKENS set");
    else warn("CANON_CLIENT_TOKENS empty: every MCP call will be refused");
  }

  // One person token for both hooks and the MCP header (PIPELINE-PRD 4.1). Process env wins over
  // .env, as in the hooks. With no CANON_CLIENT_TOKENS the server falls back to its dev tokens,
  // which are the .env.example line, so the check reads that line in that case.
  const pick = (k) => process.env[k] || env[k] || "";
  const personToken = pick("CANON_PERSON_TOKEN");
  let clientTokens = pick("CANON_CLIENT_TOKENS");
  let tokensSource = "CANON_CLIENT_TOKENS";
  if (!clientTokens) {
    clientTokens = parseDotEnv(readText(join(root, ".env.example"))).CANON_CLIENT_TOKENS ?? "";
    tokensSource = "the server's dev tokens (CANON_CLIENT_TOKENS in .env.example)";
  }
  let principals = [];
  try {
    principals = JSON.parse(readFileSync(join(root, "fixtures", "world", "world.json"), "utf8")).principals ?? [];
  } catch (err) {
    bad(`fixtures/world/world.json: ${err.message}`);
  }
  report(checkPersonToken({ personToken, clientTokens, principals, tokensSource }));
  report(checkAuthor({ personToken, principal: pick("CANON_PRINCIPAL") }));

  // Claude Code connector files: the MCP server and the committed hooks.
  report(checkMcpJson(readText(join(root, ".mcp.json"))));
  try {
    for (const r of checkHookWiring(JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8")))) report(r);
  } catch (err) {
    bad(`.claude/settings.json: ${err.message}`);
  }

  // Ports
  const ports = {
    server: Number(env.CANON_PORT ?? process.env.CANON_PORT ?? 4100),
    web: Number(env.WEB_PORT ?? process.env.WEB_PORT ?? 4200),
    "status board": 4173,
  };
  for (const [name, port] of Object.entries(ports)) {
    const free = await new Promise((resolve) => {
      const s = net
        .createServer()
        .once("error", () => resolve(false))
        .once("listening", () => s.close(() => resolve(true)));
      s.listen(port, "127.0.0.1");
    });
    if (free) ok(`port ${port} free (${name})`);
    else warn(`port ${port} busy (${name}): already running, or change it in .env`);
  }

  // Status board
  try {
    const s = JSON.parse(readFileSync(join(root, "status", "status.json"), "utf8"));
    ok(`status.json parses (updated ${s.updated})`);
  } catch (err) {
    bad(`status.json: ${err.message}`);
  }

  // Fact store + cold archive. Same resolution as dataDir() in shared/src/env.ts: process env
  // wins over .env, relative paths hang off the repo root.
  const rawData = process.env.CANON_DATA_DIR || env.CANON_DATA_DIR || "data";
  const dataDir = isAbsolute(rawData) ? rawData : join(root, rawData);
  const relData = relative(root, dataDir);
  const shownData = relData === "" ? "." : relData.startsWith("..") ? dataDir : relData; // absolute when outside the repo, like seed.ts
  if (existsSync(join(dataDir, "facts"))) ok(`data dir ${shownData}/ has facts`);
  else warn(`data dir ${shownData}/ empty or missing: \`npm run seed -w server\` copies demo facts + a session in. The server starts with 0 facts otherwise.`);

  console.log(fatal ? `\n${fatal} problem(s) above.` : "\nAll good. Next: npm run dev");
  process.exit(fatal ? 1 : 0);
}

/** File text, or undefined when it is missing. */
function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** True when run as `node scripts/doctor.mjs`; false when doctor.test.mjs imports the checks. */
function isMain() {
  if (!process.argv[1]) return false;
  const argv = resolve(process.argv[1]);
  const self = fileURLToPath(import.meta.url);
  return process.platform === "win32" ? argv.toLowerCase() === self.toLowerCase() : argv === self;
}

if (isMain()) await main();
