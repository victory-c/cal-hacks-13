// Pure helpers for the Claude Code capture hook. No I/O except gitInfo (best-effort shell out)
// and readDotEnv (one file read). Zero dependencies and no import of @canon/shared on purpose:
// hooks run as `node <path>` from any cwd, with no workspace resolution.
//
// The output shape mirrors shared/src/types/session.ts (CapturedSession). Keep them in sync by
// reading that file; it is the frozen A↔B contract.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const CLIENT = "claude-code";
export const TITLE_MAX = 80;

/**
 * Transcript JSONL → SessionMessage[]. Claude Code writes one JSON object per line to
 * ~/.claude/projects/<project>/<session_id>.jsonl. We keep only real conversation turns:
 *   - type "user" | "assistant" (not "summary", "system", "progress", "file-history-snapshot"…)
 *   - not isMeta (local-command caveats, injected context) and not isSidechain (subagents)
 * Content is a string or an array of blocks: "text" blocks are joined, "tool_use" becomes
 * "[tool: <name>]", everything else (tool_result, thinking, image…) is dropped. A line whose
 * content ends up empty (a tool_result-only turn) is dropped too; it carries nothing to distill.
 * Malformed lines are skipped rather than failing the whole capture.
 */
export function parseTranscript(jsonlText) {
  const messages = [];
  for (const raw of String(jsonlText).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (entry.isMeta === true || entry.isSidechain === true) continue;

    const content = renderContent(entry.message?.content);
    if (!content) continue;

    const msg = { role: entry.type, content };
    if (typeof entry.timestamp === "string" && entry.timestamp) msg.at = entry.timestamp;
    messages.push(msg);
  }
  return messages;
}

function renderContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      const t = block.text.trim();
      if (t) parts.push(t);
    } else if (block.type === "tool_use") {
      parts.push(`[tool: ${typeof block.name === "string" ? block.name : "unknown"}]`);
    }
    // tool_result, thinking, image, document…: not conversation text, skipped.
  }
  return parts.join("\n");
}

/**
 * Claude Code's session_id is a UUID. The contract wants `ses_` + hex, stable for the whole
 * session so every Stop re-posts to the same id and the server upserts. sha1 is plenty: this
 * is an identifier, not a secret.
 */
export function sessionIdFor(sessionId) {
  const hex = createHash("sha1").update(String(sessionId)).digest("hex");
  return `ses_${hex.slice(0, 8)}`;
}

/**
 * Assemble the CapturedSession body for POST /api/sessions.
 * ended_at is set only on SessionEnd: that is what tells the server to run the final distill.
 */
export function buildSession({ payload = {}, messages = [], hookEvent, git = {} }) {
  const event = hookEvent ?? payload.hook_event_name ?? "Stop";
  const firstUser = messages.find((m) => m.role === "user");
  const session = {
    id: sessionIdFor(payload.session_id ?? ""),
    client: CLIENT,
    started_at: messages[0]?.at ?? new Date().toISOString(),
    messages,
    meta: compact({
      cwd: payload.cwd,
      repo: git.repo,
      branch: git.branch,
      hook_event: event,
    }),
  };
  if (event === "SessionEnd") session.ended_at = new Date().toISOString();
  if (firstUser) session.title = makeTitle(firstUser.content);
  return session;
}

/** First user message, whitespace collapsed, cut to TITLE_MAX chars. */
export function makeTitle(text) {
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length > TITLE_MAX ? oneLine.slice(0, TITLE_MAX).trimEnd() : oneLine;
}

/**
 * Tiny .env reader: KEY=value per line, `#` comments and blank lines ignored, optional
 * `export ` prefix, matching quotes stripped, and an unquoted ` #` starts an inline comment.
 * Returns {} when the file is missing. Not a full dotenv (no multiline, no interpolation):
 * .env.example is flat, and the hook only needs CANON_URL and CANON_TOKEN_CLAUDE_CODE.
 */
export function readDotEnv(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Best-effort repo + branch for meta. Any failure (not a repo, git missing, slow) yields {}:
 * the hook must never fail or stall because of git. `repo` is "owner/name" when origin looks
 * like a GitHub-style URL, else the origin URL as-is, else the top-level folder name.
 */
export function gitInfo(cwd) {
  const run = (args) => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  };
  if (!cwd) return {};
  const info = {};
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch) info.branch = branch;

  const origin = run(["remote", "get-url", "origin"]);
  if (origin) {
    const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(origin);
    info.repo = m ? m[1] : origin;
  } else {
    const top = run(["rev-parse", "--show-toplevel"]);
    if (top) info.repo = top.split("/").filter(Boolean).pop();
  }
  return info;
}

/** Drop undefined values so the JSON body stays clean. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out;
}
