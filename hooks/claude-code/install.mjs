#!/usr/bin/env node
// Prints the Claude Code hooks snippet for this checkout (Stop + SessionEnd → canon-capture.mjs,
// UserPromptSubmit → canon-context.mjs) with the real absolute paths. `--write` merges it into
// ~/.claude/settings.json instead:
// backs the file up first, keeps every other hook, replaces an older Canon entry, creates the
// file when missing. `--settings <path>` targets another settings file (used by the tests).
// `--project` writes the repo's committed .claude/settings.json with a $CLAUDE_PROJECT_DIR
// path instead, so every checkout and worktree of Canon captures its own sessions and nothing
// outside this repo is touched. That file is already committed; re-run only after changing it.
//
//   node hooks/claude-code/install.mjs              # print, paste into settings.json
//   node hooks/claude-code/install.mjs --write      # merge into ~/.claude/settings.json (all projects)
//   node hooks/claude-code/install.mjs --project    # merge into <repo>/.claude/settings.json
//   node hooks/claude-code/install.mjs --mcp        # print POSIX + PowerShell MCP setup commands

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEnv } from "./lib.mjs";

export const HOOK_SCRIPTS = { Stop: "canon-capture.mjs", SessionEnd: "canon-capture.mjs", UserPromptSubmit: "canon-context.mjs" };
export const EVENTS = Object.keys(HOOK_SCRIPTS);
export const SCRIPT_NAME = "canon-capture.mjs";
export const CONTEXT_SCRIPT_NAME = "canon-context.mjs";
const SCRIPT_NAMES = [...new Set(Object.values(HOOK_SCRIPTS))];
// Claude Code kills a hook that runs longer than this many seconds. The hook itself gives up
// well before (3s POST timeout, 10s watchdog), so this is a second fence, not the first.
const HOOK_TIMEOUT_S = 15;

// Claude Code sets CLAUDE_PROJECT_DIR for hook commands, so one committed command works in
// every clone and worktree.
export const PROJECT_DIR_VAR = "${CLAUDE_PROJECT_DIR}";
export function projectCommand(name = SCRIPT_NAME) {
  return `node "${PROJECT_DIR_VAR}/hooks/claude-code/${name}"`;
}
export const PROJECT_COMMAND = projectCommand();

export const MCP_SERVER_NAME = "canon";
export const MCP_DEFAULT_URL = "http://localhost:4100";
export const MCP_DEV_TOKEN = "dev-claude-code";
export const TOKEN_PLACEHOLDER = "${CANON_PERSON_TOKEN}";
export const POWERSHELL_TOKEN_PLACEHOLDER = "$env:CANON_PERSON_TOKEN";

export function repoSettingsPath() {
  return fileURLToPath(new URL("../../.claude/settings.json", import.meta.url));
}

export function scriptPath(name = SCRIPT_NAME) {
  return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

export function capturePath() {
  return scriptPath();
}

/** `node <path>`; the path is quoted only when sh would split it. */
export function commandFor(path = capturePath()) {
  return /[\s'"$`\\]/.test(path) ? `node '${path.replace(/'/g, `'\\''`)}'` : `node ${path}`;
}

export function commandsFor(dir) {
  const out = {};
  for (const [event, name] of Object.entries(HOOK_SCRIPTS)) {
    const path = dir === undefined ? scriptPath(name) : `${dir.replace(/[\\/]+$/, "")}/${name}`;
    out[event] = commandFor(path);
  }
  return out;
}

export function projectCommands() {
  return Object.fromEntries(Object.entries(HOOK_SCRIPTS).map(([event, name]) => [event, projectCommand(name)]));
}

export function snippet(commands = commandsFor()) {
  const hooks = {};
  for (const event of EVENTS) hooks[event] = [{ hooks: [{ type: "command", command: commands[event], timeout: HOOK_TIMEOUT_S }] }];
  return { hooks };
}

/** Merge our entries into an existing settings object. Idempotent; other hooks untouched. */
export function mergeSettings(settings, commands = commandsFor()) {
  const out = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  if (!out.hooks || typeof out.hooks !== "object" || Array.isArray(out.hooks)) out.hooks = {};
  const ours = snippet(commands).hooks;
  for (const ev of EVENTS) {
    const existing = Array.isArray(out.hooks[ev]) ? out.hooks[ev] : [];
    // Drop any earlier Canon entry (old path, old timeout) so re-running updates in place.
    const kept = existing.filter((group) => !isCanonGroup(group));
    out.hooks[ev] = [...kept, ...ours[ev]];
  }
  return out;
}

function isCanonGroup(group) {
  const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
  return hooks.some((h) => typeof h?.command === "string" && SCRIPT_NAMES.some((name) => h.command.includes(name)));
}

export function writeSettings(settingsPath, commands = commandsFor()) {
  let current = {};
  if (existsSync(settingsPath)) {
    const text = readFileSync(settingsPath, "utf8");
    try {
      current = text.trim() ? JSON.parse(text) : {};
    } catch (err) {
      throw new Error(`${settingsPath} is not valid JSON (${err.message}). Fix it or paste the snippet by hand.`);
    }
    copyFileSync(settingsPath, `${settingsPath}.bak`);
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
  }
  const merged = mergeSettings(current, commands);
  writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

/** A copy-pasteable `claude mcp add` command for POSIX shells or PowerShell. */
export function mcpAddCommand({ url = MCP_DEFAULT_URL, token, shell = "posix" } = {}) {
  const auth = token ?? (shell === "powershell" ? POWERSHELL_TOKEN_PLACEHOLDER : TOKEN_PLACEHOLDER);
  return `claude mcp add --transport http ${MCP_SERVER_NAME} --scope user "${url.replace(/\/$/, "")}/mcp" --header "Authorization: Bearer ${auth}"`;
}

function main(argv) {
  if (argv.includes("--mcp")) {
    const env = resolveEnv(["CANON_URL", "CANON_PERSON_TOKEN"]);
    const show = argv.includes("--show-token");
    const url = env.CANON_URL || MCP_DEFAULT_URL;
    const token = show ? env.CANON_PERSON_TOKEN || MCP_DEV_TOKEN : undefined;
    console.log(`POSIX:\n${mcpAddCommand({ url, token, shell: "posix" })}`);
    console.log(`\nPowerShell:\n${mcpAddCommand({ url, token, shell: "powershell" })}`);
    if (!show) console.error("\nExport CANON_PERSON_TOKEN in that shell first, or re-run with --show-token to print its configured value. Then run: claude mcp list");
    else if (!env.CANON_PERSON_TOKEN) console.error(`\nCANON_PERSON_TOKEN is not set: ${MCP_DEV_TOKEN} is the dev operator token (scaffold folders, nobody's scope).`);
    return;
  }
  if (argv.includes("--project")) {
    const settingsPath = repoSettingsPath();
    writeSettings(settingsPath, projectCommands());
    console.log(`Wrote Bullwark hooks (${EVENTS.join(", ")}) to ${settingsPath} with ${PROJECT_DIR_VAR} paths`);
    console.log(`Commit it. New Claude Code sessions in this repo now post to the Bullwark server (CANON_CAPTURE=0 opts out).`);
    return;
  }
  const write = argv.includes("--write");
  const i = argv.indexOf("--settings");
  const settingsPath = i >= 0 && argv[i + 1] ? argv[i + 1] : join(homedir(), ".claude", "settings.json");

  if (!write) {
    console.log(JSON.stringify(snippet(), null, 2));
    console.error(`\nPaste the "hooks" block above into ~/.claude/settings.json, or run with --write to merge it.`);
    return;
  }
  const hadFile = existsSync(settingsPath);
  writeSettings(settingsPath);
  console.log(`Wrote Bullwark hooks (${EVENTS.join(", ")}) to ${settingsPath}${hadFile ? ` (backup: ${settingsPath}.bak)` : " (new file)"}.`);
  console.log(`Next: set CANON_PERSON_TOKEN in the repo .env so capture, prompt context and MCP all act as you, then start a new Claude Code session.`);
}

// Run only as a CLI; the tests import the functions above.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`install failed: ${err.message}`);
    process.exit(1);
  }
}
