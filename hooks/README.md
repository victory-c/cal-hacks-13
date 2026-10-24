# `@canon/hooks` — capture clients: Claude Code hook + ingest CLI

**Owner:** lane B, Victor Chun. Plain Node ESM (`.mjs`), **zero dependencies, no import of
`@canon/shared`**: Claude Code runs hooks as shell commands from any cwd, so nothing here can
rely on workspace resolution. The output shape is `CapturedSession` from
`shared/src/types/session.ts`; keep them in sync by reading that file (the ingest tests fail if
`SOURCE_KINDS` drifts).

Two capture paths live here:

- `claude-code/`: the hook that posts every Claude Code session (below).
- `ingest/`: a CLI that posts firm content (memos, team chat, meeting transcripts, email, notes)
  as client `ingest`. See [Ingest CLI](#ingest-cli-hooksingest).

## v2 fields (PRD v2, walls)

Every session now carries `kind` and, when known, `principal` (whose context it is). The hook
sends `kind: "ai_session"` and `principal` from `CANON_PRINCIPAL` (process env, then `.env`,
trimmed and lowercased; unset = left out, and triage treats an unknown principal cautiously).
The debug line then reads `Stop ses_3f9a1c2b 8 msgs as dan → 200`.

**Today's v1 server keeps only the v1 keys** (`server/src/api.ts` `parseSession`), so
`principal`, `kind` and `external` are accepted and dropped until lane A's v2 server keeps them.
Nothing breaks either way: the POST is the same v1 route.

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

Config resolution, per key (`CANON_URL`, `CANON_TOKEN_CLAUDE_CODE`, `CANON_PRINCIPAL`): process
env → `.env` at `CANON_REPO_ROOT` → `.env` in this checkout (`../../.env` from the script).
`CANON_URL` defaults to `http://localhost:4100`.
`CANON_TOKEN_CLAUDE_CODE` defaults to `dev-claude-code`, the same dev value the server accepts
when it has no `.env` (`server/src/auth.ts`), so a fresh clone captures with no setup; set a
real token in `.env` to override it.

## Test and smoke

```bash
npm test -w hooks         # node:test, offline, ~1.5 s: hook lib + install + the hook as a child process, ingest parsing + CLI against a port-0 server
npm run typecheck -w hooks  # node --check on the five scripts (no TypeScript here)
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

## Ingest CLI (`hooks/ingest/`)

The PRD's third capture path: memos, team chat, meeting notes and email arrive through it, so it
is how the synthetic world (Harbor Lane, Project Falcon) gets into Canon. **One file = one
session**, posted to `POST /api/sessions` as client `ingest`, with `ended_at` set so the
distiller triages it at once.

```bash
node hooks/ingest/canon-ingest.mjs hooks/fixtures/world --dry-run   # print the 5 sessions as JSON, no network
node hooks/ingest/canon-ingest.mjs hooks/fixtures/world             # post them to CANON_URL
node hooks/ingest/canon-ingest.mjs <world>/email --root <world> --only email --delay 3000
npm run ingest:world -w hooks                                       # same as the second line (paths under -w are relative to hooks/)
```

| Flag | Does |
|---|---|
| `--dry-run` | sessions as JSON on stdout (pipe to `jq`), one summary line each on stderr, nothing sent |
| `--url URL` | server; default `CANON_URL`, else `http://localhost:4100` |
| `--only KIND` | `memo`, `chat`, `transcript`, `email`, `note` or `ai_session` (plurals and aliases such as `emails`, `meetings` work) |
| `--principal ID` | principal for items that name none |
| `--firm-domain D` | default `harborlane.com`; an email from outside it is `external: true` |
| `--root DIR` | ids come from paths relative to DIR (default: the folder given, or a file's folder) |
| `--delay MS` | wait between posts, to drip items in live during the demo |

**Token.** `CANON_TOKEN_INGEST` (env, then `.env`), else `dev-ingest`. The server must list it:
add `,ingest=dev-ingest` to `CANON_CLIENT_TOKENS` in your `.env` and restart the server. It is
not in the `.env.example` default or the server's no-`.env` fallback yet, because lane A's bench
test requires every default token to have demo grants; a 401 prints exactly this hint.

**Layout-tolerant**, because lane A owns the official world and its layout is not fixed. The
first signal wins:

1. front-matter `kind:` (or `type:`)
2. the nearest folder that names a kind: `memos/`, `chat/`, `slack/`, `transcripts/`, `meetings/`, `email/`, `mail/`, `notes/`, `news/`, `ai-sessions/`…
3. a word in the file name: `falcon-ic-memo.md`, `2026-10-22-mgmt-call.md`
4. the extension: `.eml` email, `.jsonl` chat, `.vtt` / `.srt` transcript
5. the text: an email header block, or mostly `Speaker: text` lines → chat; else `note`

Files read: `.md .markdown .txt .eml .json .jsonl .vtt .srt` up to 1 MB. `README*`, dotfiles and
`node_modules` are skipped.

| Kind | Messages | Principal (after front-matter `principal` / `author`) | `external` |
|---|---|---|---|
| memo, note | one message with the body; split at paragraphs past 8,000 chars, never cut | `--principal` | front-matter only |
| chat, transcript | one per speaker turn (`Dan: text`, `[09:12] Dan Okafor (MD): text`, JSONL / JSON rows, VTT `<v Dan>`); consecutive lines from one speaker merge, unprefixed lines continue the turn, the speaker label stays in the text | whoever opened it (`Dan Okafor` → `dan`) | front-matter only |
| email | one message: `From/To/Cc/Subject/Date` block + body; transport headers go to `meta.email` | a firm sender, else the first firm recipient (whose inbox it is) | sender domain is not the firm domain or a subdomain of it; an unreadable sender counts as external |
| ai_session | one per turn; `ChatGPT:` / `Claude:` / `Assistant:` are the assistant | front-matter or `--principal` (never "You") | front-matter only |

**Times are exact or absent.** A line's stamp becomes `at` only when it resolves to an instant:
a full date-time with an offset; a time of day on the item's `date` with a `tz:` (or an offset
on `date`); for transcripts, an elapsed `00:03:41` from a `date` that is an exact start. Anything
less certain stays in the text as `[09:12]`, so nothing is lost and no time zone is invented.
`started_at` is the item's date (or the email `Date:`), else the first message time, else now.

**Ids.** `ses_` + the first 8 hex of sha1(path relative to the root), so re-ingesting the same
root upserts (the CLI prints `new` or `updated`). Ingesting a subfolder? Pass `--root` with the
world's root to keep the same ids.

**Failures.** Each HTTP error status is logged once with a hint (401: register the token; 404:
not a Canon server) and every remaining file is still tried. A dead server stops the run after
one line. Exit code: 0 all posted, 1 anything failed, 2 bad flags or paths.

**Verified against today's v1 server** (Sat 05:00, `CANON_CLIENT_TOKENS` with `ingest=dev-ingest`):
all 5 world items archived, a second run printed `updated` for the same ids. The archive kept
v1 keys only (see v2 fields above).

### Sample world (`fixtures/world/`)

Synthetic, made up for the demo; see `fixtures/world/README.md`. One Falcon valuation memo, the
deal team's channel for a morning, a management-call transcript excerpt, Priya's public-news
note on Nimbus, and an email from the target's outside counsel with a **planted instruction
aimed at an AI** (forward the Falcon terms to research). The tests pin what each one parses to.

## Stub vs real, sponsor plug-in

Everything here is real: a real transcript parser, a real file parser and a real POST to the
server. There is no model call and no sponsor integration in this package; the captured session
goes to `server/` (cold archive) and from there to `distiller/` (Droid + Jev triage). Nothing is
simulated, so nothing is labelled simulated. The sample world is synthetic data and says so.

## Privacy

Only the transcript text reaches the server: user and assistant messages and tool names, never
tool output, file contents returned by tools, thinking blocks, or harness-injected context. The server is yours
(`CANON_URL`, localhost by default). The client token lives in `.env`, which is gitignored; it
never goes into `settings.json` or git.
