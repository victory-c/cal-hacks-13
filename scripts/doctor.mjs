#!/usr/bin/env node
// Preflight for a fresh clone, or for the 4 AM "why is nothing working" moment.
// Usage: npm run doctor        (no dependencies; never prints key values)

import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let fatal = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const warn = (m) => console.log(`  warn  ${m}`);
const bad = (m) => {
  fatal++;
  console.log(`  FAIL  ${m}`);
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
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    env[t.slice(0, i).trim()] = t.slice(i + 1).split(" #")[0].trim();
  }
  for (const k of ["ANTHROPIC_API_KEY", "JEV_API_KEY", "FACTORY_API_KEY", "MOSS_PROJECT_KEY"]) {
    if (env[k]) ok(`${k} set`);
    else warn(`${k} empty (that integration runs as a stub)`);
  }
  if (env.CANON_CLIENT_TOKENS) ok("CANON_CLIENT_TOKENS set");
  else warn("CANON_CLIENT_TOKENS empty: every MCP call will be refused");
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
