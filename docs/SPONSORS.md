# Where each sponsor runs in Bullwark

**Owner:** Victor (task B13). One line per sponsor: the file where its tool does real work in the
running product, and an honest status. The README's "Sponsor tracks and integration evidence"
section and the Devpost sponsor paragraphs ([`DEVPOST.md`](DEVPOST.md)) come from this file, so
update it first.

**Status markers**

- **built**: on `main` and running in the demo today. Nothing else counts, not even an open pull
  request.
- **in review**: on an open pull request, not merged to `main`. The PR is named.
- **in progress**: on a pushed branch with no pull request yet, or still being written.
- **planned**: not started, waiting on a blocker, or cut if time runs short.

**Last checked:** Sat 10/24 05:37 PDT, against `origin/main`, the open pull requests and the
remote branch list. On `main`: the capture scaffold (Claude Code hook, ChatGPT extension, file
store, plain SSE, keyword retrieval, `judge()` with Jev, Claude and fake judges, the scaffold
benchmark and dashboard). In review: the finance contract (`shared/src/types/walls.ts`,
`agents.ts`, the finance judge thresholds) on draft PR #7 (`b/contract-v2`), and these story docs
on `b/story`, stacked on PR #7. Also in review, each stacked on PR #7: PR #9 `b/dispatch` (B2,
B18), PR #10 `b/triage` (B5), PR #11 `b/writer` (B17) and PR #12 `b/ingest` (B19, B4). Lane A's
finance server routes and Edan's control room are not built. Re-check before the 21:00 sync and
again at code freeze (Sun 07:00): flip a marker to **built** only when the code is on `main` and
runs in the demo. Factory says it scores down "a chatbot wrapper with Droid
added on," and every track wants real work, so never mark a stub as built.

**Devpost link.** [`DEVPOST.md`](DEVPOST.md) ends every claim that depends on a status below
that isn't **built** with `[[SHIPPED? Row: item]]`, using the row and item names in this file
(for example `Armadin: filter and exit check`). Flip the marker here first, then resolve the
tags there.

## Core tools and tracks

| Sponsor | Track | Where it does real work | Status |
|---|---|---|---|
| **Factory Droid** | Factory Droid SDK (core) | `distiller/src/dispatch/` (on `b/dispatch` only): the dispatcher runs every agent as headless `droid exec --auto low` (Factory's docs: it may create and edit files and blocks package installs and remote writes; whether it runs Python for the numbers at that level is to be confirmed at the booth, blocker Q1), one sandbox folder per agent at `$TMPDIR/canon-agents/<run>/`, outside the repo and the data directory (on macOS also under a `sandbox-exec` profile that denies the repo, the data directory and other runs), short steps with an inbox between them, every step streamed as an `agent.step` event into the agent's dashboard lane. A finished run's folder is locked and copied to `data/agents/<run>/` as its record. Live routing in `distiller/src/dispatch/routing.ts`. On `main`, the distiller engine `distiller/src/engines/droid.ts` is a stub that throws until wired. | **in review** (B2 dispatch, B18 routing; PR #9, `b/dispatch`). Gate Sat 11:00, blocker Q1: if Droid can't run headless finance tasks, the Claude runner takes over and this track is dropped. |
| **Anthropic (Claude)** | Anthropic (core) | Fallback judge `shared/src/judge/claude.ts` (`claude-haiku-5-5`, one forced tool call). `createJudge()` picks it whenever `ANTHROPIC_API_KEY` is set and `JEV_API_KEY` isn't, so while blocker Q3 is open Claude Haiku answers triage's "confidential?" and "which deal?" questions, which help set wall labels (raise-only; it can never lower one). Fact writer `distiller/src/engines/claude.ts` (`claude-sonnet-5-5`): on `main` it writes the scaffold's session facts; the finance writer prompt and wall labels are on `b/writer`. Agent briefs and the fallback agent runner in `distiller/src/dispatch/` (on `b/dispatch`). Benchmark answering model `bench/src/responder.ts`. | Judge: **built**. Scaffold writer: **built**. Finance writer: **in review** (B17; PR #11, `b/writer`). Briefs and runner: **in review** (B2; PR #9, `b/dispatch`). Responder: **built**. |
| **Jev (TypeSafe AI)** | Not a separate prize track; it's the judge behind every decision | `shared/src/judge/jev.ts` behind `createJudge()` in `shared/src/judge/index.ts`. Save-time triage (keep, confidential, which deal, AI instructions, relation) in `distiller/src/triage.ts` (on `b/triage`). Handoff relevance and access pre-screen in `server/` (lane A). Routing questions in `distiller/src/dispatch/routing.ts` (on `b/dispatch`). | Client: **built**, but the request shape is unverified against TypeSafe's docs (blocker Q3; gate Sat 09:00, else the Claude fallback). Triage: **in review** (B5; PR #10, `b/triage`). Handoff and pre-screen: **planned** (A7, A12). |
| **Moss** | Moss (add-on) | `server/src/retrieval/moss.ts`, picked by `createRetriever()` in `server/src/retrieval/index.ts`: search by meaning on every handoff and routing check, after the permission filter. Today `server/src/retrieval/keyword.ts` runs instead. | **planned** (A4, blocker Q2: credentials). The class exists and throws "not implemented." |
| **Hyphenate** | Autonomous Systems for Finance (core) | The whole product. Walls contract in `shared/src/types/walls.ts` (deals, entitlements, restricted and watch lists, `NEUTRAL_REFUSALS`, review queue, audit log). Permission filter, refusals and audit in `server/` (lane A). Control room in `web/` (Edan). Story in `docs/VIDEO_SCRIPT.md` and `docs/PITCH.md`. | Contract: **in review** (draft PR #7). Server and control room: **planned** (A6, A7, A11 in `server/`; C13, C14 in `web/`). Video and pitch scripts: **in review** (`b/story`, stacked on PR #7). |
| **Microsoft** | Built for the Real World + Customer Impact (core) | `bench/`: runner, scoring and `bench/results/chart.json`. Scale path in [`SCALE_SLIDE.md`](SCALE_SLIDE.md), `docs/DEVPOST.md` and `docs/PITCH.md`. Audit log from the server (`/api/audit`). | Runner: **built** for the scaffold's 3 baselines; those results don't measure information barriers. Finance setups (the finance runner's 4 setups with leak rate and wrongly-blocked rate, and the 50-attack / 30-task sets): **planned** (A8 runner, C6 task sets). Scale slide text: **in review** (`b/story`, stacked on PR #7). |
| **Armadin** | Best Security Hack (add-on) | Injection question and quarantine review items in `distiller/src/triage.ts`. Raise-only wall labels in `distiller/src/walls.ts` (both on `b/triage`). Neutral refusals in `shared/src/types/walls.ts`. Permission filter and exit check (`/api/exit-check`) in `server/`. Attack box in `web/`. | Triage and labels: **in review** (B5, PR #10; B17, PR #11). Refusal wording: **in review** (in the contract, draft PR #7). Filter and exit check: **planned** (A6, A11, A13). Attack box: **planned** (should ship, C16). |

## Add-ons that depend on process or time

| Sponsor | Track | Where it does real work | Status |
|---|---|---|---|
| **Bitdeer AI Model Studio** | Bitdeer (add-on) | An open model on Model Studio writing facts from high-volume chat and meeting text, as a second writer engine next to `distiller/src/engines/claude.ts`. | **planned**, 4th in the cut order. Nothing in the repo yet. |
| **Mana.space** | Mana (add-on) | Used while building, not in the product: public Mana chats or pages, and one moment where Mana changed what we built. | **planned**. Needs links from whoever used it. |
| **Notability** | Notability (add-on) | Edan's design notes, sketches and decisions, from Saturday on. Not in the product. | **planned**. Needs the notes link from Edan. |
| **Cal Hacks general** | Overall, Technically Complex, People-First, Hacker's Choice | Automatic. | Nothing to build. |

We enter only the tracks in these two tables. Elastic is not one of them.

## Not a sponsor, but judges will ask about these

| Piece | Where | Status |
|---|---|---|
| Claude Code hook | `hooks/claude-code/` | **built** (B1). Finance fields (principal, kind): **in review** (B19; PR #12, `b/ingest`). |
| ChatGPT extension | `extension/` | **built** for scaffold capture (code and tests on `main`). Finance fields: **in review** (B4; PR #12, `b/ingest`). Live demo test: not done. First capture path to cut; if it is cut, Dan's ChatGPT session goes in through the ingest client as an `ai_session`. |
| Ingest client (memos, chat, notes, email, AI sessions) | `hooks/ingest/` | **in review** (B19; PR #12, `b/ingest`). Posts to `POST /api/sessions`, which is on `main`. |
| Storage and events | `server/` | **built**: local files (one markdown file per fact, raw sessions in a cold archive) and plain SSE. There is no database. |
| Memory browser (view, edit, retire facts) | `web/` (C18) | **planned**. Retiring moves a fact to cold storage with its history kept; nothing is hard-deleted. |
