# Canon — Cal Hacks 13.0

Canon is one platform that keeps your context from every AI session (Claude, ChatGPT and
Gemini on the web; Claude Code, Cursor, Hermes) **live and automatically**, with no export or
import. A new session in any AI gets only the small, relevant slice it needs. **Jev**
decides what is worth keeping and what is relevant, **Moss** retrieves, and **folders** control
which AI sees what. It starts personal or small-team and shows a path to a company version.

Full spec: `docs/PRD.md`. Current progress: `STATUS.md` (generated from `status/status.json`).
Read both before starting a task.

## Hard deadlines (all times PDT)

| When | What |
|---|---|
| Sat 10/24 23:59 | Devpost draft submitted |
| Sun 10/25 07:00 | Code freeze. After this, only demo-breaking fixes |
| Sun 10/25 08:30 | Final submit (target) |
| Sun 10/25 09:00 | Devpost hard deadline. Late projects are not judged |
| Sun 10/25 10:30–12:30 | Judging. The whole team stays at the table |

## Team

| Lane | Who | Owns | Folders |
|---|---|---|---|
| **A · Server & retrieval** | Henry Lai | Fact store, cold archive, MCP server, folder grants, Moss index, Jev filter in `canon_context`, SSE event stream, benchmark runner | `server/`, `bench/` |
| **B · Capture, distill, UI & story** | Victor Chun | Claude Code hook, browser extension, Droid distiller, Jev save-time decisions, ChatGPT connector, dashboard, resume viewer. Also all storytelling: Devpost text, pitch, video script, scale slide, sponsor README sections | `hooks/`, `extension/`, `distiller/`, `web/`, `docs/` |
| **C · Ops & QA (no coding, no storytelling)** | Edan Wong | Sponsor answers, accounts and keys, Devpost logistics, raw interview notes, demo test sessions, benchmark task set, QA runs, screen recording, timekeeping | `status/` (his tasks + blockers), `bench/tasks/` |

Stay inside your lane's folders unless the owner agrees. A and B agree on the interface
contracts below. Never change one without telling the other.

**How we work together**

1. First hour: Victor and Henry freeze the fact file format and the four MCP tools together.
   Henry ships a stub server that writes local files, and then they split.
2. Nobody waits. B builds capture against the stub or a mock server. A builds retrieval
   against sample facts from Edan's persona sessions.
3. Sync every 6 hours (Sat 03:00, 09:00, 15:00, 21:00), 10 minutes each: merge to `main`, run
   the demo end to end, update `status.json`. Edan's QA run follows each sync.
4. Sleep rotation, so one builder is always awake: Henry about 02:00–06:00, Victor about
   06:00–10:00, Edan Friday about 01:00–07:00.
5. Keys and credentials are shared directly between people, never through git or chat logs.

## Decisions already made (don't re-argue these)

- **Pitch:** all in one and live across web chats and code sessions, with lean context
  (~1–2K tokens instead of a dump). Never pitch "memory that works everywhere" alone,
  because Supermemory and Mem0 already do that.
- **Core sponsor tracks:** Anthropic, Factory Droid SDK, Moss, Microsoft Built for the Real
  World. "If time": SpacetimeDB, Apify, Armadin. Everything else is skipped.
- **ChatGPT web is read-only over MCP.** Writes on Plus aren't confirmed. Capture from
  ChatGPT goes through the browser extension.
- **Event stream is plain SSE from the server.** Move it to SpacetimeDB only if there's
  slack on Saturday.
- **Jev never deletes.** Raw sessions always go to the cold archive. Jev only decides what is
  promoted to hot facts and what reaches a session.
- **No LinkedIn scraping.**

## Planned layout

Create these folders as you build. Don't add new top-level folders without a reason.

```
server/      A — MCP server (Streamable HTTP) + REST + SSE, fact store, grants, Moss, Jev filter
distiller/   B — Droid distiller: session in, facts out; save-time Jev decisions
extension/   B — Chrome MV3 extension: live capture from ChatGPT / Claude / Gemini web
hooks/       B — Claude Code capture hook
web/         B — live product dashboard (token counter) + resume viewer
bench/       A runs; C writes tasks in bench/tasks/ — 20 handoff tasks, 3 baselines, results JSON
status/      everyone — status.json (source of truth), dashboard, sync script
docs/        PRD, demo script, sponsor notes
```

Stack: TypeScript on Node 22+ for everything that runs. Use npm workspaces once the second
package exists. Keep dependencies few: anything that breaks at 4 AM costs the demo.

## Interface contracts (A ↔ B)

**Fact file.** One markdown file per fact. The files are plain markdown, so the store opens
in Obsidian.

```yaml
---
id: fct_7f3a                 # fct_ + 4+ hex chars
statement: Built Canon's live capture hook for Claude Code sessions
folder: career/projects      # top level: career | projects | team | private
tier: hot                    # hot | cold
jev_keep: 0.91               # save-time relevance probability
source: { client: claude-code, session: 2026-10-24T03:12, pr: <url> }
supersedes: fct_12aa         # optional
updated: 2026-10-24
---
Optional detail.
```

**MCP tools** (the server exposes these, and every call is scoped to the client token's folders):

| Tool | Returns |
|---|---|
| `canon_context(task, budget_tokens=1500)` | The relevant slice: Moss candidates filtered by Jev, cut to the token budget |
| `canon_search(query, folders?)` | Matching facts in granted folders |
| `canon_save(text, folder?)` | Queued. It goes through the distiller and Jev, never straight to hot |
| `canon_whoami()` | This client's folders, so an AI can explain a refusal |

**Client grants.** Map each client token to its folders. Demo defaults: `claude-code` reads
`projects/` and `career/` and saves to `projects/`. `chatgpt` reads `career/`.
`teammate-cursor` reads `team/`. Nothing external reads `private/`.

**Jev decisions.** Jev answers typed questions with probabilities, and our code applies
the thresholds:

| When | Question | Type | Threshold / action |
|---|---|---|---|
| save | Worth keeping hot? | Noul | > 0.6 hot, else cold |
| save | Which folder? | Choice | Low confidence goes to the inbox |
| save | New, duplicate, or supersedes? | Choice | Add, merge, or retire the old fact |
| retrieve | Relevant to this task? | Noul | > 0.7, up to the token budget |
| retrieve | Enough to answer? | Noul | If not, pull from cold or say what's missing |

Batch all candidates into **one** Jev request. Jev is early access (`jev-latest`; request
shape is `model` + `state` + `questions`). Check it against TypeSafe's docs once we have
access. Put Jev behind a `judge()` interface with a Claude fallback (structured output with
a probability field), so swapping is a config change.

## Claude API

- Model IDs: `claude-sonnet-5-5` (distilling, resume writing), `claude-haiku-5-5` (fallback
  judge), `claude-opus-5-5` only if Sonnet is clearly not good enough.
- Keys come from `.env` only. See `.env.example`.

## Rules

- **No secrets in git.** `.env` is gitignored. Sponsor judges read the repo.
- **Never invent numbers.** Token, latency, cost and accuracy figures come only from
  `bench/` runs or the live counter. Label simulated data as simulated in the UI and on Devpost.
- **Only compare against baselines we run** (no memory, paste the full history, Canon).
  Never quote competitors' numbers.
- **`main` must always run the demo.** Finish must-ship work before stretch. The cut order when
  behind: Apify → team mode → Gemini web capture → SpacetimeDB.
- **Every sponsor integration must do real work** in the running product, and its README
  section must say where. Factory explicitly scores down "a chatbot wrapper with Droid added on".
- All code is written during the hackathon. Don't paste in prior projects.

## Status tracking (do this every time)

`status/status.json` is the single source of truth for progress. When you start, finish, or
block on a task:

1. Edit its `state` (`todo` | `doing` | `blocked` | `done`) and `note` in `status/status.json`,
   and bump the top-level `updated` timestamp.
2. Run `node status/sync.mjs`. It validates the file and regenerates `STATUS.md`. Fix any error
   it reports.
3. Commit the status change **in the same commit** as the work.

New work goes in as a new task with the next id in the owner's lane. A question that blocks
anyone goes in `blockers` with an owner. Each person updates only their own tasks. Edan also
maintains `blockers`. Don't edit `STATUS.md` by hand.

Live board: `node status/serve.mjs`, then open http://localhost:4173. It re-reads `status.json`
every 30 seconds, so `git pull` to see teammates' updates.

## Git

- Branch per task: `a/<thing>`, `b/<thing>`, `c/<thing>`. Open a PR to `main`, keep PRs small
  and merge them quickly.
- Pull `main` often. Hooks and the extension depend on the server contract.
- Commit messages: imperative, say what changed, and mention the task id (e.g. `A2: ...`).
