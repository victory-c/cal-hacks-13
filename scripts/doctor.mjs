#!/usr/bin/env node
// Preflight for a fresh clone, or for the 4 AM "why is nothing working" moment.
// Usage: npm run doctor        (no dependencies; never prints key values)

import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const HOOK_SCRIPTS = { Stop: "canon-capture.mjs", SessionEnd: "canon-capture.mjs", UserPromptSubmit: "canon-context.mjs" };

export function parseDotEnv(text) {
  const out = {};
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const quoted = /^(\"|')(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    out[match[1]] = value;
  }
  return out;
}

export function parseClientTokens(raw) {
  const out = new Map();
  for (const entry of String(raw ?? "").split(",")) {
    const at = entry.indexOf("=");
    if (at <= 0) continue;
    const client = entry.slice(0, at).trim();
    const token = entry.slice(at + 1).trim();
    if (client && token) out.set(token, client);
  }
  return out;
}

export function checkPersonToken({ personToken, clientTokens, principals, tokensSource = "CANON_CLIENT_TOKENS" }) {
  if (!personToken) return null;
  const client = parseClientTokens(clientTokens).get(personToken);
  if (!client) return { level: "FAIL", message: `CANON_PERSON_TOKEN is not a token value in ${tokensSource}: the server would answer 401.` };
  const principal = (Array.isArray(principals) ? principals : []).find((candidate) => candidate?.id === client);
  if (!principal) return { level: "FAIL", message: `CANON_PERSON_TOKEN maps to client "${client}", which is not a principal in fixtures/world/world.json.` };
  if (principal.kind !== "person") return { level: "FAIL", message: `CANON_PERSON_TOKEN maps to "${client}", a ${principal.kind ?? "non-person"} principal, not a person.` };
  return { level: "ok", message: `CANON_PERSON_TOKEN maps to person "${client}" (capture, prompt context and MCP act as them)` };
}

export function checkAuthor({ personToken, principal }) {
  if (personToken || principal) return null;
  return { level: "warn", message: "neither CANON_PERSON_TOKEN nor CANON_PRINCIPAL is set: captures will have no author. Set CANON_PERSON_TOKEN for the complete person loop." };
}

export function checkMcpJson(text) {
  if (text === undefined) return { level: "FAIL", message: ".mcp.json missing at the repo root: Claude Code has no Canon MCP connector" };
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (err) { return { level: "FAIL", message: `.mcp.json does not parse: ${err.message}` }; }
  const server = parsed?.mcpServers?.canon;
  if (!server || typeof server !== "object" || Array.isArray(server)) return { level: "FAIL", message: ".mcp.json has no mcpServers.canon entry" };
  const problems = [];
  if (server.type !== "http") problems.push(`type is ${JSON.stringify(server.type)}, expected "http"`);
  if (typeof server.url !== "string" || !server.url.endsWith("/mcp")) problems.push("url must end with /mcp");
  const auth = server.headers?.Authorization;
  if (typeof auth !== "string" || !/^Bearer \$\{CANON_PERSON_TOKEN/.test(auth)) problems.push("Authorization must start with `Bearer ${CANON_PERSON_TOKEN` and never contain a literal token");
  return problems.length ? { level: "FAIL", message: `.mcp.json: ${problems.join("; ")}` } : { level: "ok", message: ".mcp.json wires canon over HTTP with CANON_PERSON_TOKEN" };
}

export function checkHookWiring(settings) {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return [{ level: "FAIL", message: ".claude/settings.json has no hooks block" }];
  return Object.entries(HOOK_SCRIPTS).map(([event, script]) => {
    const matches = (Array.isArray(hooks[event]) ? hooks[event] : [])
      .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
      .filter((hook) => typeof hook?.command === "string" && hook.command.includes(`hooks/claude-code/${script}`));
    if (matches.length === 0) return { level: "FAIL", message: `.claude/settings.json: ${event} does not run hooks/claude-code/${script}` };
    if (matches.some((hook) => typeof hook.timeout !== "number")) return { level: "warn", message: `.claude/settings.json: ${event} → ${script} has no timeout` };
    return { level: "ok", message: `.claude/settings.json: ${event} → ${script}` };
  });
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

async function main() {
let fatal = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const warn = (m) => console.log(`  warn  ${m}`);
const bad = (m) => {
  fatal++;
  console.log(`  FAIL  ${m}`);
};
const report = (result) => {
  if (!result) return;
  (result.level === "ok" ? ok : result.level === "warn" ? warn : bad)(result.message);
};

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

// Same precedence as env() in shared/src/env.ts: a variable already in the process environment
// wins over .env (process.loadEnvFile never overrides it), and an empty value counts as unset.
const setting = (name, fallback) => {
  const v = process.env[name] ?? env[name];
  return v === undefined || v === "" ? fallback : v;
};

// One person token drives capture, automatic prompt context and the MCP connector. If the user
// has not configured server tokens, validate against the same development map the server uses.
const pick = (name) => process.env[name] || env[name] || "";
let clientTokens = pick("CANON_CLIENT_TOKENS");
let tokensSource = "CANON_CLIENT_TOKENS";
if (!clientTokens) {
  clientTokens = parseDotEnv(readText(join(root, ".env.example"))).CANON_CLIENT_TOKENS ?? "";
  tokensSource = "the development tokens in .env.example";
}
let principals = [];
try {
  principals = JSON.parse(readFileSync(join(root, "fixtures", "world", "world.json"), "utf8")).principals ?? [];
} catch (err) {
  bad(`fixtures/world/world.json: ${err.message}`);
}
report(checkPersonToken({ personToken: pick("CANON_PERSON_TOKEN"), clientTokens, principals, tokensSource }));
report(checkAuthor({ personToken: pick("CANON_PERSON_TOKEN"), principal: pick("CANON_PRINCIPAL") }));
report(checkMcpJson(readText(join(root, ".mcp.json"))));
try {
  for (const result of checkHookWiring(JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8")))) report(result);
} catch (err) {
  bad(`.claude/settings.json: ${err.message}`);
}

// Ports
const ports = {
  server: Number(setting("CANON_PORT", "4100")),
  web: Number(setting("WEB_PORT", "4200")),
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

// Fact store + cold archive. Same resolution as dataDir() in shared/src/env.ts: relative paths
// hang off the repo root.
const rawData = setting("CANON_DATA_DIR", "data");
const dataDir = isAbsolute(rawData) ? rawData : join(root, rawData);
const relData = relative(root, dataDir);
const shownData = relData === "" ? "." : relData.startsWith("..") ? dataDir : relData; // absolute when outside the repo, like seed.ts
if (existsSync(join(dataDir, "facts"))) ok(`data dir ${shownData}/ has facts`);
else warn(`data dir ${shownData}/ empty or missing: the server will seed the demo world on first start. \`npm run seed -w server\` scaffolds it explicitly.`);

console.log(fatal ? `\n${fatal} problem(s) above.` : "\nAll good. Next: npm run dev");
process.exit(fatal ? 1 : 0);
}

function isMain() {
  if (!process.argv[1]) return false;
  const argv = resolve(process.argv[1]);
  const self = fileURLToPath(import.meta.url);
  return process.platform === "win32" ? argv.toLowerCase() === self.toLowerCase() : argv === self;
}

if (isMain()) await main();
