# Where each sponsor runs in Canon

**Owner:** Victor (task B23). One line per sponsor: the file where its tool does real work in the
running product, and an honest status. The README's "Sponsor tracks" section and the Devpost
sponsor paragraphs ([`DEVPOST.md`](DEVPOST.md)) come from this file, so update it first.

**Status markers**

- **built**: on `main` and running in the demo today. Nothing else counts, not even the contract
  branch.
- **in progress**: written or being built on a branch, not merged to `main` yet.
- **planned**: not started, waiting on a blocker, or cut if time runs short.

**Last checked:** Sat 10/24 04:43 PDT, against `origin/main` and the remote branch list.
Contract v2 (`shared/src/types/walls.ts`, `agents.ts`, the v2 judge thresholds) is on
`origin/b/contract-v2`, not on `main`. `b/writer` (B20) is pushed to origin, not merged.
`b/ingest`, `b/triage` and `b/dispatch` are local worktrees only, and lane A's v2 server routes
are not built. Re-check before the 21:00 sync and again at code freeze (Sun 07:00): flip a marker
to **built** only when the code is on `main` and runs in the demo. Factory says it scores down "a
chatbot wrapper with Droid added on," and every track wants real work, so never mark a stub as
built.

**Devpost link.** [`DEVPOST.md`](DEVPOST.md) ends every claim that depends on a status below
that isn't **built** with `[[SHIPPED? Row: item]]`, using the row and item names in this file
(for example `Armadin: filter and exit check`). Flip the marker here first, then resolve the
tags there.

## Core tools and tracks

| Sponsor | Track | Where it does real work | Status |
|---|---|---|---|
| **Factory Droid** | Factory Droid SDK (core) | `distiller/src/dispatch/` (not in the repo yet): the dispatcher runs every agent as headless `droid exec` at a restricted autonomy level (read and write files and run local commands such as Python, inside its own folder only), one sandbox folder per agent (`data/agents/<run>/`), short steps with an inbox between them, every step streamed as an `agent.step` event into the agent's dashboard lane. Live routing in `distiller/src/dispatch/routing.ts`. The v1 distiller engine `distiller/src/engines/droid.ts` is a stub that throws until wired. | **in progress** (B21, B22 on `b/dispatch`). Gate Sat 11:00, blocker Q1: if Droid can't run headless finance tasks, the Claude runner takes over and this track is dropped. |
| **Anthropic (Claude)** | Anthropic (core) | Fallback judge `shared/src/judge/claude.ts` (`claude-haiku-5-5`, one forced tool call). `createJudge()` picks it whenever `ANTHROPIC_API_KEY` is set and `JEV_API_KEY` isn't, so while blocker Q3 is open Claude Haiku answers triage's "confidential?" and "which deal?" questions, which help set wall labels (raise-only; it can never lower one). Fact writer `distiller/src/engines/claude.ts` (`claude-sonnet-5-5`): built for v1 sessions, finance writer prompt and wall labels in progress. Agent briefs and the fallback agent runner in `distiller/src/dispatch/`. Benchmark answering model `bench/src/responder.ts`. | Judge: **built**. Writer: **built** (v1). v2 writer: **in progress** (B20, pushed to `origin/b/writer`, not merged). Briefs and runner: **in progress** (B21). Responder: **built**. |
| **Jev (TypeSafe AI)** | Not a separate prize track; it's the judge behind every decision | `shared/src/judge/jev.ts` behind `createJudge()` in `shared/src/judge/index.ts`. Save-time triage (keep, confidential, which deal, AI instructions, relation) in `distiller/src/triage.ts`. Handoff relevance and access pre-screen in `server/` (lane A). Routing questions in `distiller/src/dispatch/routing.ts`. | Client: **built**, but the request shape is unverified against TypeSafe's docs (blocker Q3; gate Sat 09:00, else the Claude fallback). Triage: **in progress** (B19 on `b/triage`). Handoff and pre-screen: **planned** (lane A). |
| **Moss** | Moss (add-on) | `server/src/retrieval/moss.ts`, picked by `createRetriever()` in `server/src/retrieval/index.ts`: search by meaning on every handoff and routing check, after the permission filter. Today `server/src/retrieval/keyword.ts` runs instead. | **planned** (A4, blocker Q2: credentials). The class exists and throws "not implemented." |
| **Hyphenate** | Autonomous Systems for Finance (core) | The whole product. Walls contract in `shared/src/types/walls.ts` (deals, entitlements, restricted and watch lists, `NEUTRAL_REFUSALS`, review queue, audit log). Permission filter, refusals and audit in `server/` (lane A). Control room in `web/` (Edan). Story in `docs/VIDEO_SCRIPT.md` and `docs/PITCH.md`. | Contract: **in progress** (written on `b/contract-v2`, not on `main`). Server and control room: **planned** (lanes A and C). Video and pitch scripts: **in progress** (written on `b/story`). |
| **Microsoft** | Built for the Real World + Customer Impact (core) | `bench/`: runner, scoring and `bench/results/chart.json`. Scale path in `docs/DEVPOST.md` and `docs/PITCH.md`. Audit log from the server (`/api/audit`). | Runner: **built** for v1's 3 baselines. v2's 4 setups (leak rate, wrongly-blocked rate) and the 50-attack / 30-task sets: **planned** (lane A runner, Edan's task sets). Scale path text: **in progress** (written on `b/story`). |
| **Armadin** | Best Security Hack (add-on) | Injection question and quarantine review items in `distiller/src/triage.ts`. Raise-only wall labels in `distiller/src/walls.ts`. Neutral refusals in `shared/src/types/walls.ts`. Permission filter and exit check (`/api/exit-check`) in `server/`. Attack box in `web/`. | Triage and labels: **in progress** (B19, B20). Refusal wording: **in progress** (in the contract on `b/contract-v2`). Filter and exit check: **planned** (lane A). Attack box: **planned** (should ship, Edan). |

## Add-ons that depend on process or time

| Sponsor | Track | Where it does real work | Status |
|---|---|---|---|
| **Bitdeer AI Model Studio** | Bitdeer (add-on) | An open model on Model Studio writing facts from high-volume chat and meeting text, as a second writer engine next to `distiller/src/engines/claude.ts`. | **planned**, 4th in the cut order. Nothing in the repo yet. |
| **Mana.space** | Mana (add-on) | Used while building, not in the product: public Mana chats or pages, and one moment where Mana changed what we built. | **planned**. Needs links from whoever used it. |
| **Notability** | Notability (add-on) | Edan's design notes, sketches and decisions, from Saturday on. Not in the product. | **planned**. Needs the notes link from Edan. |
| **Cal Hacks general** | Overall, Technically Complex, People-First, Hacker's Choice | Automatic. | Nothing to build. |

## Not a sponsor, but judges will ask where capture runs

| Piece | Where | Status |
|---|---|---|
| Claude Code hook | `hooks/claude-code/` | **built** (B1). v2 fields (principal, kind): **in progress** (B18 on `b/ingest`). |
| ChatGPT extension | `extension/` | **built** for v1 capture (code and tests in the repo; B4's live demo test is still open). First capture path to cut. |
| Ingest client (memos, chat, notes, email) | `hooks/ingest/` | **in progress** (B18 on `b/ingest`). |
