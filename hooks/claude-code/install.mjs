#!/usr/bin/env node
// Prints the Claude Code hooks snippet for this checkout (Stop + SessionEnd → canon-capture.mjs)
// with the real absolute path. `--write` merges it into ~/.claude/settings.json instead:
// backs the file up first, keeps every other hook, replaces an older Canon entry, creates the
// file when missing. `--settings <path>` targets another settings file (used by the tests).
// `--project` writes the repo's committed .claude/settings.json with a $CLAUDE_PROJECT_DIR
// path instead, so every checkout and worktree of Canon captures its own sessions and nothing
// outside this repo is touched. That file is already committed; re-run only after changing it.
//
//   node hooks/claude-code/install.mjs              # print, paste into settings.json
//   node hooks/claude-code/install.mjs --write      # merge into ~/.claude/settings.json (all projects)
//   node hooks/claude-code/install.mjs --project    # merge into <repo>/.claude/settings.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const EVENTS = ["Stop", "SessionEnd"];
export const SCRIPT_NAME = "canon-capture.mjs";
// Claude Code kills a hook that runs longer than this many seconds. The hook itself gives up
// well before (3s POST timeout, 10s watchdog), so this is a second fence, not the first.
const HOOK_TIMEOUT_S = 15;

// Claude Code sets CLAUDE_PROJECT_DIR for hook commands, so one committed command works in
// every clone and worktree.
export const PROJECT_COMMAND = `node "$CLAUDE_PROJECT_DIR/hooks/claude-code/${SCRIPT_NAME}"`;

export function repoSettingsPath() {
  return fileURLToPath(new URL("../../.claude/settings.json", import.meta.url));
}

export function capturePath() {
  return fileURLToPath(new URL(`./${SCRIPT_NAME}`, import.meta.url));
}

/** `node <path>`; the path is quoted only when sh would split it. */
export function commandFor(path = capturePath()) {
  return /[\s'"$`\\]/.test(path) ? `node '${path.replace(/'/g, `'\\''`)}'` : `node ${path}`;
}

export function snippet(path = capturePath(), command = commandFor(path)) {
  const entry = { hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] };
  const hooks = {};
  for (const ev of EVENTS) hooks[ev] = [structuredClone(entry)];
  return { hooks };
}

/** Merge our entries into an existing settings object. Idempotent; other hooks untouched. */
export function mergeSettings(settings, path = capturePath(), command = commandFor(path)) {
  const out = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  if (!out.hooks || typeof out.hooks !== "object" || Array.isArray(out.hooks)) out.hooks = {};
  const ours = snippet(path, command).hooks;
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
  return hooks.some((h) => typeof h?.command === "string" && h.command.includes(SCRIPT_NAME));
}

export function writeSettings(settingsPath, path = capturePath(), command = commandFor(path)) {
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
  const merged = mergeSettings(current, path, command);
  writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

function main(argv) {
  if (argv.includes("--project")) {
    const settingsPath = repoSettingsPath();
    writeSettings(settingsPath, capturePath(), PROJECT_COMMAND);
    console.log(`Wrote Canon hooks (${EVENTS.join(", ")}) to ${settingsPath} with ${PROJECT_COMMAND}`);
    console.log(`Commit it. New Claude Code sessions in this repo now post to the Canon server (CANON_CAPTURE=0 opts out).`);
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
  console.log(`Wrote Canon hooks (${EVENTS.join(", ")}) to ${settingsPath}${hadFile ? ` (backup: ${settingsPath}.bak)` : " (new file)"}.`);
  console.log(`Next: start a new Claude Code session. Without CANON_TOKEN_CLAUDE_CODE in the repo .env the hook uses the dev token (dev-claude-code).`);
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
