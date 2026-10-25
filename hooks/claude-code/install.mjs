#!/usr/bin/env node
// Prints the Claude Code hooks snippet for this checkout (Stop + SessionEnd → canon-capture.mjs,
// UserPromptSubmit → canon-context.mjs) with the real absolute paths. `--write` merges it into
// ~/.claude/settings.json instead: backs the file up first, keeps every other hook, replaces an
// older Canon entry, creates the file when missing. `--settings <path>` targets another settings
// file (used by the tests). `--project` writes the repo's committed .claude/settings.json with
// ${CLAUDE_PROJECT_DIR} paths instead, so every checkout and worktree of Canon runs its own copy
// and nothing outside this repo is touched. That file is already committed; re-run only after
// changing it. `--mcp` prints the `claude mcp add` command that registers the Bullwark MCP server
// at user scope, for anyone who prefers not to use the committed .mcp.json.
//
//   node hooks/claude-code/install.mjs              # print, paste into settings.json
//   node hooks/claude-code/install.mjs --write      # merge into ~/.claude/settings.json (all projects)
//   node hooks/claude-code/install.mjs --project    # merge into <repo>/.claude/settings.json
//   node hooks/claude-code/install.mjs --mcp        # print the claude mcp add command (--show-token for the value)

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEnv } from "./lib.mjs";

/** Hook event → the script it runs: the capture hook posts the session, the context hook reads memory. */
export const HOOK_SCRIPTS = { Stop: "canon-capture.mjs", SessionEnd: "canon-capture.mjs", UserPromptSubmit: "canon-context.mjs" };
export const EVENTS = Object.keys(HOOK_SCRIPTS);
export const SCRIPT_NAME = "canon-capture.mjs";
export const CONTEXT_SCRIPT_NAME = "canon-context.mjs";
const SCRIPT_NAMES = [...new Set(Object.values(HOOK_SCRIPTS))];
// Claude Code kills a hook that runs longer than this many seconds. The hooks themselves give up
// well before (3 s / 8 s POST timeouts, 10 s / 12 s watchdogs), so this is a second fence, not the
// first. SessionEnd hooks get 1.5 s unless they declare one, so declaring it matters there.
const HOOK_TIMEOUT_S = 15;

// Claude Code sets CLAUDE_PROJECT_DIR for hook commands, so one committed command works in
// every clone and worktree. The braced form on purpose: Claude Code expands ${VAR} in both Git
// Bash and PowerShell, while a bare $CLAUDE_PROJECT_DIR is $null under PowerShell and the hook
// never runs there.
export const PROJECT_DIR_VAR = "${CLAUDE_PROJECT_DIR}";
export function projectCommand(name = SCRIPT_NAME) {
  return `node "${PROJECT_DIR_VAR}/hooks/claude-code/${name}"`;
}
export const PROJECT_COMMAND = projectCommand(SCRIPT_NAME);

// The MCP connector. Same defaults as the committed .mcp.json at the repo root.
export const MCP_SERVER_NAME = "bullwark";
export const MCP_DEFAULT_URL = "http://127.0.0.1:4100";
export const MCP_DEV_TOKEN = "dev-claude-code";
export const TOKEN_PLACEHOLDER = "${CANON_PERSON_TOKEN}";

export function repoSettingsPath() {
  return fileURLToPath(new URL("../../.claude/settings.json", import.meta.url));
}

export function scriptPath(name = SCRIPT_NAME) {
  return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

export function capturePath() {
  return scriptPath(SCRIPT_NAME);
}

/** `node <path>`; the path is quoted only when sh would split it. */
export function commandFor(path = capturePath()) {
  return /[\s'"$`\\]/.test(path) ? `node '${path.replace(/'/g, `'\\''`)}'` : `node ${path}`;
}

/** Event → command for the scripts in `dir` (this checkout when omitted), with absolute paths. */
export function commandsFor(dir) {
  const out = {};
  for (const [ev, name] of Object.entries(HOOK_SCRIPTS)) {
    out[ev] = commandFor(dir === undefined ? scriptPath(name) : `${dir.replace(/[\\/]+$/, "")}/${name}`);
  }
  return out;
}

/** Event → command with the ${CLAUDE_PROJECT_DIR} placeholder, for the committed project settings. */
export function projectCommands() {
  const out = {};
  for (const [ev, name] of Object.entries(HOOK_SCRIPTS)) out[ev] = projectCommand(name);
  return out;
}

export function snippet(commands = commandsFor()) {
  const hooks = {};
  for (const ev of EVENTS) hooks[ev] = [{ hooks: [{ type: "command", command: commands[ev], timeout: HOOK_TIMEOUT_S }] }];
  return { hooks };
}

/** Merge our entries into an existing settings object. Idempotent; other hooks untouched. */
export function mergeSettings(settings, commands = commandsFor()) {
  const out = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  if (!out.hooks || typeof out.hooks !== "object" || Array.isArray(out.hooks)) out.hooks = {};
  const ours = snippet(commands).hooks;
  for (const ev of EVENTS) {
    const existing = Array.isArray(out.hooks[ev]) ? out.hooks[ev] : [];
    // Drop any earlier Canon entry (old path, old timeout, bare $CLAUDE_PROJECT_DIR) so re-running
    // updates in place.
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

/**
 * The `claude mcp add` line equivalent to the committed .mcp.json, for the user scope. The token
 * is the ${CANON_PERSON_TOKEN} placeholder unless the caller passes a value: a real token never
 * lands in a terminal scrollback or a pasted chat log by accident.
 */
export function mcpAddCommand({ url = MCP_DEFAULT_URL, token = TOKEN_PLACEHOLDER } = {}) {
  return `claude mcp add --transport http ${MCP_SERVER_NAME} --scope user "${url.replace(/\/$/, "")}/mcp" --header "Authorization: Bearer ${token}"`;
}

function main(argv) {
  if (argv.includes("--mcp")) {
    const env = resolveEnv(["CANON_URL", "CANON_PERSON_TOKEN"]);
    const show = argv.includes("--show-token");
    console.log(mcpAddCommand({ url: env.CANON_URL || MCP_DEFAULT_URL, token: show ? env.CANON_PERSON_TOKEN || MCP_DEV_TOKEN : TOKEN_PLACEHOLDER }));
    if (!show) console.error(`\nRun it in a shell where CANON_PERSON_TOKEN is exported, or re-run with --show-token to print the value. Then: claude mcp list`);
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
  console.log(`Next: set CANON_PERSON_TOKEN in the repo .env so both hooks act as you, then start a new Claude Code session. Without it capture uses CANON_TOKEN_CLAUDE_CODE or the dev token (${MCP_DEV_TOKEN}) and the context hook stays off.`);
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
