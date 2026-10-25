#!/usr/bin/env node
// Supervise the existing entrypoints together; Compose/Caddy supplies HTTPS and persistence.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const required = ["CANON_CLIENT_TOKENS", "CANON_TOKEN_DISTILLER"];
for (const key of required) if (!process.env[key]) throw new Error(`${key} is missing; run npm run preview:setup.`);
const tokens = new Map(process.env.CANON_CLIENT_TOKENS.split(",").map((pair) => {
  const at = pair.indexOf("=");
  return [pair.slice(0, at), pair.slice(at + 1)];
}));
for (const client of ["claude-code", "chatgpt", "teammate-cursor", "distiller", "dispatcher", "ingest", "wags", "axe", "ben", "dollar-bill"]) {
  if ((tokens.get(client)?.length ?? 0) < 24 || tokens.get(client).startsWith("dev-")) {
    throw new Error(`Preview needs a random token for ${client}; run npm run preview:setup.`);
  }
}
if (new Set(tokens.values()).size !== tokens.size) throw new Error("Each preview client needs a different token.");
for(const name of ["distiller","dispatcher"]) {
  if(tokens.get(name)!==process.env[`CANON_TOKEN_${name.toUpperCase()}`]) throw new Error(`${name} token does not match CANON_CLIENT_TOKENS.`);
}
const simulated = process.env.PREVIEW_ALLOW_SIMULATED === "1";
if (!simulated) {
  const engine=process.env.DISTILLER || (process.env.FACTORY_API_KEY ? "droid" : "claude");
  const judge=process.env.JUDGE_PROVIDER || (process.env.JEV_API_KEY ? "jev" : "claude");
  process.env.DISTILLER=engine;
  process.env.JUDGE_PROVIDER=judge;
  process.env.DISPATCH_RUNTIME ||= "claude";
  if(process.env.DISPATCH_RUNTIME==="fake") throw new Error("Simulated dispatch requires PREVIEW_ALLOW_SIMULATED=1.");
  if(process.env.DISPATCH_RUNTIME==="claude" && !process.env.ANTHROPIC_API_KEY) throw new Error("Claude dispatch needs ANTHROPIC_API_KEY.");
  const keys={droid:"FACTORY_API_KEY",claude:"ANTHROPIC_API_KEY",jev:"JEV_API_KEY"};
  for (const provider of [engine,judge]) if (!keys[provider] || !process.env[keys[provider]]) throw new Error(`Real preview needs credentials for ${provider}; simulated mode must be explicit.`);
}
if (simulated) console.warn("[preview] Explicit simulated mode: no model API calls.");
if (simulated) {
  process.env.DISTILLER = "heuristic";
  process.env.JUDGE_PROVIDER = "fake";
  process.env.DISPATCH_RUNTIME = "fake";
  delete process.env.MOSS_PROJECT_ID;
  delete process.env.MOSS_PROJECT_KEY;
}
if (!existsSync(resolve(root, "web/dist/index.html"))) throw new Error("Build the dashboard first: npm run build -w web.");

const children = [];
let stopping = false;
let killTimer;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  // Distiller has up to 120s to finish its current provider request before shutdown.
  killTimer = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  }, 145_000);
  killTimer.unref();
  // Let the worker finish writing to the API before stopping the API itself.
  for(const worker of children.filter(child=>["distiller","dispatcher"].includes(child.previewName))) {
  if (worker.exitCode === null && worker.signalCode === null) {
    await new Promise((done) => {
      worker.once("exit", done);
      worker.kill("SIGTERM");
    });
  }
  }
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
}
for (const [name, entry] of [["server", "server/src/index.ts"], ["web", "web/scripts/serve.mjs"], ["distiller", "distiller/src/index.ts"], ["dispatcher", "distiller/src/dispatch/index.ts"], ["gateway", "scripts/preview-gateway.mjs"]]) {
  const child = spawn(process.execPath, ["--import", "tsx", entry], { stdio: "inherit", env: process.env });
  child.previewName = name;
  children.push(child);
  child.on("error", (err) => {
    console.error(`[preview] ${name} could not start: ${err.message}`);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`[preview] ${name} stopped (${signal ?? code}); restarting the stack is required.`);
      stop(1);
    }
    if (children.every((c) => c.exitCode !== null || c.signalCode !== null)) clearTimeout(killTimer);
  });
}
process.once("SIGTERM", () => stop(0));
process.once("SIGINT", () => stop(0));
