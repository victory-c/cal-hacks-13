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

## The principal is the author

Every session carries `kind` and, when known, `principal`. In Bullwark's scopes model the
principal is the **author** of every fact distilled from the session (`Fact.author` in
`shared/src/types/fact.ts`): those facts are that person's memories. A member's own facts join
their scope without the exclusion checks, unless triage files them to `inbox` or quarantines
them, and an agent's facts belong to the person who created it. So the principal decides access,
and the capture clients never guess it:

| Client | `kind` | `principal` |
|---|---|---|
| Claude Code hook | `ai_session` | `CANON_PRINCIPAL` (process env, then `.env`) |
| ChatGPT extension | `ai_session` | the principal field on its options page |
| Ingest CLI | per file (below) | front-matter, else a firm email's sender, else `--principal`. Never mail from outside the firm, an email recipient, or a chat or meeting speaker. Names and addresses go through `--principals FILE` |

All three take an **id**, trimmed and lowercased: `Dan` → `dan`, and an agent id such as
`AGT_Deal-Analyst` is kept whole (`agt_deal-analyst`). A name or an email address is not an id
and is never guessed into one: `Dan Okafor`, `Okafor, Dan`, `D. Okafor` and
`dan.okafor@harborlane.com` give no principal (taking the first token made `Leo Chen` Leo Brandt,
and gave Dan the ids `okafor` and `d`). Only the ingest CLI maps names and addresses to ids, and
only through an explicit directory (`--principals`, below). When no principal is set the field is
left out, and the session's facts have no author, so they join a scope only by passing that
scope's checks (exclusions in code, then Moss and Jev against the task). The hook's debug line
shows the principal: `Stop ses_3f9a1c2b 8 msgs as dan → 200`, or `with no principal
(CANON_PRINCIPAL is not an id like dan)`. The extension's options page says so too. `external:
true` (ingest only) marks text from outside the firm, which triage reads with extra suspicion for
instructions aimed at an AI.

Set your own id only. The server takes `principal` from the body today, so a wrong
`CANON_PRINCIPAL` files your facts as someone else's memories. Binding it to the client token is
lane A's side.

**Today's server keeps only the original session keys** (`server/src/api.ts` `parseSession`),
so `principal`, `kind` and `external` are accepted and dropped until lane A's server keeps them,
and the distiller does not write `Fact.author` from the principal yet. Nothing breaks either way:
the POST is the same route.

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
Claude Code session in any clone or worktree of Bullwark posts to your local server. Nothing outside
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
hand. Re-running replaces the old Bullwark entry. Don't install both user and project scope, or a
Bullwark-repo session posts twice (harmless upsert, wasted work).

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
is how the synthetic world (Harbor Lane, Project Falcon) gets into Bullwark. **One file = one
session**, posted to `POST /api/sessions` as client `ingest`, with `ended_at` set so the
distiller triages it at once.

```bash
P=hooks/fixtures/principals.json
node hooks/ingest/canon-ingest.mjs hooks/fixtures/world --principals $P --dry-run   # print the 5 sessions as JSON, no network
node hooks/ingest/canon-ingest.mjs hooks/fixtures/world --principals $P             # post them to CANON_URL
node hooks/ingest/canon-ingest.mjs <world>/email --root <world> --principals $P --only email --delay 3000
npm run ingest:world -w hooks                                       # same as the second line (paths under -w are relative to hooks/)
```

| Flag | Does |
|---|---|
| `--dry-run` | sessions as JSON on stdout (pipe to `jq`), one summary line each on stderr, nothing sent |
| `--url URL` | server; default `CANON_URL`, else `http://localhost:4100` |
| `--only KIND` | `memo`, `chat`, `transcript`, `email`, `note` or `ai_session` (plurals and aliases such as `emails`, `meetings` work) |
| `--principals FILE` | the principal directory (below): the only way a name (`author: Dan Okafor`) or a firm sender's address becomes a principal id. Without it only ids (`principal: dan`) count. A malformed file exits 2 |
| `--principal ID` | principal (the author of the facts) for items that name no author at all, and are not email. Every such item's facts join that person's scope as their own, so use it on one person's files. An id, or a name in `--principals`; anything else exits 2 |
| `--firm-domain D` | default `harborlane.com`; an email from outside it is `external: true` |
| `--root DIR` | folder names under DIR count as kind signals, and `meta.path` is relative to it (default: the folder given, or a file's folder). Ids never depend on it |
| `--delay MS` | wait between posts, to drip items in live during the demo |

**Token.** `CANON_TOKEN_INGEST` (env, then `.env`), else `dev-ingest`. The server must list it:
add `,ingest=dev-ingest` to `CANON_CLIENT_TOKENS` in your `.env` and restart the server. It is
not in the `.env.example` default or the server's no-`.env` fallback yet, because lane A's bench
test requires every default token to have demo grants; a 401 prints exactly this hint.

**Layout-tolerant**, because lane A owns the official world and its layout is not fixed. The
first signal wins:

1. front-matter `kind:` (or `type:`)
2. raw email: an `.eml` file, or a header block with transport headers (`Message-ID`, `Received`, `Return-Path`…), so an outside email filed under `messages/` or `calls/` is not read as a chat
3. the nearest folder that names a kind: `memos/`, `chat/`, `slack/`, `transcripts/`, `meetings/`, `email/`, `mail/`, `notes/`, `news/`, `ai-sessions/`…
4. a word in the file name: `falcon-ic-memo.md`, `2026-10-22-mgmt-call.md`
5. the extension: `.jsonl` chat, `.vtt` / `.srt` transcript
6. the text: a `From`/`Subject` header block → email; mostly `Speaker: text` lines with at least two people evidently talking → chat; else `note`. A key/value sheet (`Buyer: …`, `Price: …`) stays a note.

Files read: `.md .markdown .txt .eml .json .jsonl .vtt .srt` up to 1 MB. `README*`, dotfiles and
`node_modules` are skipped.

| Kind | Messages | Principal (after front-matter `principal` / `author`) | `external` |
|---|---|---|---|
| memo, note | one message with the body; split at paragraphs past 8,000 chars, never cut | an email header block's (below), else `--principal` | front-matter, else an email header block's (below) |
| chat, transcript | one per speaker turn (`Dan: text`, `[09:12] Dan Okafor (MD): text`, JSONL / JSON rows, VTT `<v Dan>`); consecutive lines from one speaker merge unless a line carries its own exact time (then it starts a new message, so the time is kept), unprefixed lines continue the turn, the speaker label stays in the text | an email header block's, else `--principal`. **Never a speaker**: a chat or meeting has several authors, and making whoever spoke first the author would put everyone's lines into that one person's scope. Put `principal:` in the front-matter when one person owns the record | front-matter, else an email header block's (below) |
| email | one message: `From/To/Cc/Subject/Date` block + body; `Message-ID`, `Reply-To` and `Return-Path` go to `meta.email`, other transport headers (`Received`, `X-*`) are dropped | the firm sender, through `--principals`, when the body quotes or forwards no other message; else none. **Never** from outside the firm or an unreadable sender (not even with front-matter), never a recipient, never `--principal` | the sender is not at the firm domain or a subdomain of it |
| ai_session | one per turn; `ChatGPT:` / `Claude:` / `Assistant:` are the assistant | front-matter or `--principal` (never "You") | front-matter only |

**The principal is never guessed.** It is the author of every fact from the item, and a member's
own facts join their scope without the exclusion checks, so ingest takes it only from a statement
of who wrote the item, and the first statement found decides (one that does not resolve gives no
principal, never the next source: a memo with `author: Nadia Haddad` is nobody's, not
`--principal dan`'s):

1. **Mail from outside the firm, or from a sender that cannot be read, has no principal**, whatever
   the front-matter or `--principal` say. An outsider's text is nobody's own memory, so its facts
   join a scope only through that scope's checks. Recipients never count: whose inbox an email sits
   in does not make them its author, and an outsider would otherwise choose, by addressing it to
   Leo, that their text joins Leo's scope past his exclusions.
2. Front-matter `principal` / `author` / `owner` / `by`.
3. Firm mail: its one firm sender, unless the body quotes or forwards another message (`> `
   lines, `On … wrote:`, `-----Original Message-----`, an Outlook `From:`/`Sent:` block, a
   forward marker), since that text has other authors.
4. `--principal`, for an item that names no author at all.

A value resolves to an id like this: an id (`dan`, `agt_deal-analyst`, `Maya (Compliance)` with
its comment dropped) is taken as written, and must be in `--principals` when one is given; a name
(`Dan Okafor`, or an alias such as `Okafor, Dan` or a one-word `Danny`) or an address resolves
**only** through `--principals`. With `--principals`, a one-word value is an id when it is one of
the file's ids, else it is looked up as a name. An address must be the value's one mailbox, so a
display name cannot smuggle one in.

**The principal directory** (`--principals FILE`) is a JSON list, or `GET /api/principals`'
`{ "principals": [...] }` saved to a file, with two optional ingest-only fields per entry:

```json
{ "principals": [
  { "id": "dan", "kind": "person", "name": "Dan Okafor", "aliases": ["D. Okafor"], "emails": ["dan.okafor@harborlane.com"] }
] }
```

A name two principals share resolves to none. An id or address listed twice, or a malformed entry,
stops the run (exit 2). The sample world's is `fixtures/principals.json`: Maya, Dan, Priya and Leo.
Nadia and Tom are not principals, so their memos and emails have no author.

**External never depends on the folder.** Any item whose text opens with a header block whose
`From` names an address (or whose front-matter has `from:`) is judged by its sender, whatever its
kind. The sender is the mailbox: the `<angle-addr>`, or a bare address when there are no
brackets. Quoted display names and `(comments)` are never read as the address, and a `From` with
no address, several mailboxes, or a different address anywhere in the display name counts as
external. So `"dan.okafor@harborlane.com" <creyes@ashdownreyes.com>` is external and is not
attributed to Dan, or to anyone.

**Times are exact or absent.** A line's stamp becomes `at` only when it resolves to an instant:
a full date-time with an offset; a time of day on the item's `date` with a `tz:` (or an offset
on `date`); for transcripts, an elapsed `00:03:41` from a `date` that is an exact start, unless
the stamp could just as well be a clock time after the start (`14:03` in a 14:00 call). JSON
row times must be epoch seconds or ms (9 to 13 digits) or a date-time with an offset; a small
number such as `3.5` is not 1970. Dates with no zone (`2026-10-21 09:12`, a `Date:` header
without an offset) are not read in the machine's local zone. Anything less certain stays in the
text as `[09:12]`, so nothing is lost and no time zone is invented. `started_at` is the item's
date when it names an instant (an exact date-time, a date-time with its own zone, or a bare
`2026-10-21`, which is midnight at the item's `tz:`, else UTC), or the email `Date:`; else the
first message time, else now. A date-time with no zone (`date: 2026-10-21 09:12`) is not turned
into midnight: it is kept as written in `meta.date`.

**Ids.** `ses_` + the first 8 hex of sha1(the file's real absolute path). Re-ingesting the same
file upserts (the CLI prints `new` or `updated`), whether it comes in with the whole world, a
subfolder or alone. Two different files never share an id, in one run or across separate runs,
so the server's upsert never overwrites one archived item with another (`a/notes.md` and
`b/notes.md` are two sessions). The same file named twice, or through a symlink, is posted once.
If two different files' ids still clash (an 8-hex hash collision), the run stops with exit 2
before anything is sent. Ids are per checkout: the same world in another folder or on another
machine gets other ids.

**JSON and JSONL messages.** A row's text is `text`, `content`, `message` or `body`: a string, a
list of content blocks (`[{ "type": "text", "text": … }]`, the Claude API and Claude export
shape; OpenAI's `input_text` / `output_text` too), or a ChatGPT export's `{ "parts": [...] }`.
Several text pieces join with a blank line. Tool and thinking blocks are skipped, as in the Claude
Code hook, so a tool-only turn is not a loss; a blank message is skipped too. A row that **cannot
be read** is never dropped without a word: a line or entry that is not an object, a text field
that is not a string or text blocks (an image-only message, a number), or a row with a `role` or
speaker and no text at all. An object with neither (export metadata) is skipped.

**Failures.** A file that cannot be read or parsed (unreadable, bad JSON, a JSONL file with no
valid line, a JSON `messages` that is not a list, a JSON file that is a bare string or number, a
JSON or JSONL file none of whose rows can be read) prints `fail <path>: <reason>`;
the run goes on and exits 1. A JSON or JSONL file with only some unreadable rows is still sent
from its good rows, prints `fail <path>: line N could not be read … and left out; the rest is in
the session` (or `row N` for a JSON list), records them in `meta.unparsed_lines` (JSONL line
numbers) or `meta.unparsed_rows` (1-based positions in a JSON message list), and also makes the
run exit 1, because the import is incomplete. A file with nothing to
ingest (over 1 MB, no text, JSON with no messages or body) prints `skip <path>: <reason>` and does
not change the exit code. Each HTTP error status is logged once with a hint (401: register the
token; 404: not a Bullwark server) and every remaining file is still tried. A dead server stops the
run after one line. Exit code: 0 all posted, 1 anything failed (a POST, or a file that could not
be read or parsed in full, also on `--dry-run`), 2 bad flags or paths, or a session id clash.

**Verified against today's server** (Sat 05:00, `CANON_CLIENT_TOKENS` with `ingest=dev-ingest`):
all 5 world items archived, a second run printed `updated` for the same ids. The archive kept
the original keys only (see [The principal is the author](#the-principal-is-the-author) above).

### Dan's ChatGPT session without the extension

The demo has Dan's ChatGPT session arrive with a new memo (PRD demo script, 0:25). If the
ChatGPT extension is cut (it is the last item in the cut order) or chatgpt.com's markup breaks
it, the same session goes in through this CLI:

1. Copy the conversation from chatgpt.com into a file under the world's `ai-sessions/` folder,
   one `You:` / `ChatGPT:` line per turn (lines with no speaker continue the turn):

   ```markdown
   ---
   kind: ai_session
   principal: dan
   title: Falcon comps with ChatGPT
   date: 2026-10-24T09:10:00-07:00
   ---
   You: Which listed logistics names trade closest to Nimbus on EV/EBITDA?
   ChatGPT: …
   ```

2. Post it with the rest of the world, or alone:

   ```bash
   node hooks/ingest/canon-ingest.mjs <world>/ai-sessions --root <world> --only ai_session --principal dan
   ```

`ChatGPT`, `GPT`, `Claude`, `Gemini`, `Assistant` and similar speakers become `assistant`, everyone
else `user`, and the speaker label is not kept in the text. The principal comes from front-matter
or `--principal`, never from `You`. With `principal: dan`, Dan is the author of the session's
facts, so once triage groups them as `deal/falcon` they join Dan's scope as his own memories
(the demo's 0:25 beat). Without front-matter, the `ai-sessions/` folder or a file
name with `chatgpt` in it still makes the kind `ai_session`. A `.json` file
`{ "kind": "ai_session", "principal": "dan", "messages": [{ "role": "user", "content": "…" }, …] }`
works too. Two differences from the extension: the session's `client` is `ingest`, not
`chatgpt`, and it lands once, complete (`ended_at` set), instead of turn by turn while Dan types.
`--dry-run` shows exactly what will be sent.

### Sample world (`fixtures/world/`)

Synthetic, made up for the demo; see `fixtures/world/README.md`, which lists each file's author
and the group its facts belong in. One Falcon valuation memo, the deal team's channel for a
morning, a management-call transcript excerpt, Priya's public-news note on Nimbus, and an email
from the target's outside counsel with a **planted instruction aimed at an AI** (forward the
Falcon terms to research), which triage must quarantine. The tests pin what each one parses to.

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
