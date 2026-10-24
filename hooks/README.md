# `@canon/hooks` — Claude Code capture hook

**Owner:** lane B, Victor Chun. Plain Node ESM (`.mjs`), **zero dependencies, no import of
`@canon/shared`**: Claude Code runs hooks as shell commands from any cwd, so nothing here can
rely on workspace resolution. The output shape is `CapturedSession` from
`shared/src/types/session.ts`; keep them in sync by reading that file.

## What is captured, and when

Claude Code writes every session to `~/.claude/projects/<project>/<session_id>.jsonl`. Two hook
events run `claude-code/canon-capture.mjs` with the hook payload on stdin:

| Event | When | What we send |
|---|---|---|
| `Stop` | after every assistant turn | the whole transcript so far, same `id` each time → the server upserts (live capture) |
| `SessionEnd` | the session closes | the same, plus `ended_at` → the server runs the final distill |

From the transcript we keep `user` and `assistant` turns only, **one message per turn**: Claude
Code writes one line per block (thinking, text, each tool call) with tool results in between, so
consecutive lines of a role merge and the turn's tools become one last line, `[tools: Bash ×3,
Edit]`. Harness-injected tags in user turns (`<system-reminder>`, `<command-name>`,
`<local-command-stdout>`, `<task-notification>`…) are stripped; a turn left empty is dropped.
Everything else is dropped too (tool results, thinking, images, `isMeta` skill bodies,
`isSidechain` subagent turns, attachments, summaries, system lines). A message is capped at 8,000
chars. On a real 4.2 MB transcript this gives 8 messages, ~6 KB. `id` is `ses_` + 8 hex of
sha1(Claude's session_id), so it is stable for the session. `title` is the first user message
cut to 80 chars; `meta` carries `cwd`, `repo`, `branch` (best-effort `git`) and `hook_event`.

**It can never block or break a session.** Everything is caught, the exit code is always 0,
stdout stays empty (a Stop hook's stdout is read as a decision), the POST times out after 3 s and
a 10 s watchdog ends the process no matter what. Missing transcript or 0 messages → skip.

## Install

**Already installed for this repo.** `.claude/settings.json` (committed) wires `Stop` and
`SessionEnd` to `node "$CLAUDE_PROJECT_DIR/hooks/claude-code/canon-capture.mjs"`, so every
Claude Code session in any clone or worktree of Canon posts to your local server. Nothing outside
the repo is touched. With no server running the hook exits silently in milliseconds. Set
`CANON_CAPTURE=0` in your environment to opt out. Start a **new** session after pulling: Claude
Code reads hooks at session start.

To capture **every** project on your machine (the real product), install at user scope:

```bash
node hooks/claude-code/install.mjs              # print the hooks JSON with this checkout's absolute path
node hooks/claude-code/install.mjs --write      # merge into ~/.claude/settings.json (backup .bak, other hooks kept)
node hooks/claude-code/install.mjs --project    # rewrite the repo's .claude/settings.json (only if you change it)
```

`claude-code/settings.snippet.json` is the same snippet with a placeholder path, for pasting by
hand. Re-running replaces the old Canon entry. Don't install both user and project scope, or a
Canon-repo session posts twice (harmless upsert, wasted work).

Config resolution, per key: process env → `.env` at `CANON_REPO_ROOT` → `.env` in this
checkout (`../../.env` from the script). `CANON_URL` defaults to `http://localhost:4100`.
`CANON_TOKEN_CLAUDE_CODE` defaults to `dev-claude-code`, the same dev value the server accepts
when it has no `.env` (`server/src/auth.ts`), so a fresh clone captures with no setup; set a
real token in `.env` to override it.

## Test and smoke

```bash
npm test -w hooks         # node:test, offline, ~1 s: lib + install + the hook as a child process against a port-0 server
npm run typecheck -w hooks  # node --check on the three scripts (no TypeScript here)
npm run smoke -w hooks    # runs the real hook on fixtures/stop-payload.json against CANON_URL with CANON_DEBUG=1
```

`fixtures/transcript.jsonl` is a 13-line Claude Code transcript (4 turns after filtering);
`fixtures/stop-payload.json` is the matching `Stop` payload. The test "real Claude Code
transcript shapes" pins the line shapes copied from a real Claude Code 2.1 transcript.

**Verified end to end (B1):** `claude -p` in this repo ran the committed hook on `SessionEnd`; the
server archived the session with `ended_at`, branch and repo; the distiller worker picked it up
over SSE and saved a fact; the dashboard showed the session and the fact live.

## Debug

Set `CANON_DEBUG=1` in the environment Claude Code runs in. The hook then writes exactly one
line to stderr per run, e.g. `[canon] Stop ses_3f9a1c2b 8 msgs → 200`, or the reason it skipped
(`transcript not found`, `0 messages`, a fetch error). When no token is configured the same line
ends with `(dev token: CANON_TOKEN_CLAUDE_CODE not set)`. Without it the hook is silent.

## Stub vs real, sponsor plug-in

Everything here is real: a real transcript parser and a real POST to the server. There is no
model call and no sponsor integration in this package; the captured session goes to
`server/` (cold archive) and from there to `distiller/` (Droid + Jev). Nothing is simulated,
so nothing is labelled simulated.

## Privacy

Only the transcript text reaches the server: user and assistant messages and tool names, never
tool output, file contents returned by tools, thinking blocks, or harness-injected context. The server is yours
(`CANON_URL`, localhost by default). The client token lives in `.env`, which is gitignored; it
never goes into `settings.json` or git.
