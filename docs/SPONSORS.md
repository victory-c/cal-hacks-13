# Where each sponsor runs in Bullwark

**Owner:** Victor (task B13). One line per sponsor: the file where its tool does real work in the
running product, and an honest status. The README's "Sponsor tracks and integration evidence"
section and the Devpost sponsor paragraphs ([`DEVPOST.md`](DEVPOST.md)) come from this file, so
update it first. The product is the one in [`PRD.md`](PRD.md): two tiers (moderators and
members) and task-built scopes, with no refusals.

**Status markers**

- **built**: on `main` and running in the demo today. Nothing else counts, not even an open pull
  request.
- **in review**: on an open pull request, not merged to `main`. The PR is named.
- **in progress**: on a pushed branch with no pull request yet, or still being written. When an
  open PR holds an older version written for the cut walls design, the item is **in progress**
  until the scopes version is up for review.
- **planned**: not started, waiting on a blocker, or cut if time runs short.

**Last checked:** Sat 10/24 06:27 PDT, against `origin/main`, the open pull requests and the
remote branch list.

- **On `main`:** the scopes PRD (#14) and the capture scaffold: Claude Code hook, ChatGPT
  extension, file store, plain SSE, keyword retrieval, `judge()` with Jev, Claude and fake
  judges, the scaffold benchmark and dashboard.
- **In review on draft PR #7 (`b/contract-v2`):** the scopes contract (`shared/src/types/scopes.ts`
  for tiers, principals, groups, scope rules, scopes, quarantine and audit; `agents.ts` for agent
  runs, steps and inboxes; `TRIAGE_THRESHOLDS` in `judge.ts`; the scope routes in `api.ts`), the
  finance fact writer (B17, merged into that branch from #11), the synthetic-world capture
  fixtures in `distiller/fixtures/world/`, and the story docs (#13, #15). These story docs'
  scopes rewrite is on `b/story-scopes`, stacked on PR #7.
- **Open, written for the cut walls design:** PR #9 `b/dispatch` (B2, B18), PR #10 `b/triage`
  (B5) and PR #12 `b/ingest` (B19, B4). Each is being reworked for scopes (see the B task notes
  in `status/status.json`). Their sides, wall labels, restricted lists, compliance queue and exit
  checks will not ship.
- **Not built:** lane A's scope routes (groups, principals, scope rules, scopes, agents,
  quarantine, handoff, audit), Moss, and Edan's moderator console and member view.

Re-check before the 21:00 sync and again at code freeze (Sun 07:00): flip a marker to **built**
only when the code is on `main` and runs in the demo. Factory says it scores down "a chatbot
wrapper with Droid added on," and every track wants real work, so never mark a stub as built.

**Devpost link.** [`DEVPOST.md`](DEVPOST.md) ends every claim that depends on a status below
that isn't **built** with `[[SHIPPED? Row: item]]`, using the row and item names in this file
(for example `Hyphenate: scope builder`). Flip the marker here first, then resolve the tags
there.

## Core tools and tracks

| Sponsor | Track | Where it does real work | Status |
|---|---|---|---|
| **Factory Droid** | Factory Droid SDK (core) | **Agent runs:** `distiller/src/dispatch/` runs every agent as headless `droid exec --auto low` (Factory's docs: it may create and edit files and blocks package installs and remote writes; whether it runs Python for the numbers at that level is to be confirmed at the booth, blocker Q1), one sandbox folder per run outside the repo and the data directory (on PR #9: `$TMPDIR/canon-agents/<run>/`, on macOS also under a `sandbox-exec` profile that denies the repo, the data directory and other runs), short steps with an inbox between them, every step streamed as an `agent.step` event into the agent's dashboard lane. For scopes, the folder holds the agent's scope as markdown files (from `GET /api/scopes/:principal/facts`) and nothing else, and the agent's new facts are saved as its creator's memories. **Live routing:** `distiller/src/dispatch/routing.ts` delivers facts that join an agent's scope at its next step (Jev: "does this agent need it now?"), and a narrowed scope discards the run folder and restarts from the plan step in a fresh folder. On `main`, the distiller engine `distiller/src/engines/droid.ts` is a stub that throws until wired. | Agent runs, live routing: **in progress** (B2, B18). The walls-era dispatcher is on open PR #9 (`b/dispatch`); its sides and exit check are cut. Gate Sat 11:00, blocker Q1: if Droid can't run headless finance tasks, the Claude runner takes over and this track is dropped. |
| **Anthropic (Claude)** | Anthropic (core) | **Judge:** fallback judge `shared/src/judge/claude.ts` (`claude-haiku-5-5`, one forced tool call). `createJudge()` picks it whenever `ANTHROPIC_API_KEY` is set and `JEV_API_KEY` isn't, so while blocker Q3 is open Claude Haiku answers the triage questions (including which group a fact goes in) and the scope-build questions. **Scaffold writer** and **finance writer:** `distiller/src/engines/claude.ts` (`claude-sonnet-5-5`): on `main` it writes the scaffold's session facts; the finance writer (verbatim deal names, author, `happened` dates) is on PR #7's branch. **Briefs and runner:** agent briefs from the agent's scope and the fallback agent runner in `distiller/src/dispatch/`. **Responder:** benchmark answering model `bench/src/responder.ts`. | Judge: **built**. Scaffold writer: **built**. Finance writer: **in review** (B17, merged into draft PR #7; suggesting a group and labels is a B17 follow-up, **in progress**). Briefs and runner: **in progress** (B2; walls-era version on PR #9). Responder: **built**. |
| **Jev (TypeSafe AI)** | Not a separate prize track; it's the judge behind every decision | **Client:** `shared/src/judge/jev.ts` behind `createJudge()` in `shared/src/judge/index.ts`. **Triage:** save-time questions (keep, which group or unsure, AI instructions, relation) in `distiller/src/triage.ts`, thresholds in `TRIAGE_THRESHOLDS`. **Scope and handoff questions:** exclusion yes/no per group and per fact, relevance per fact at scope build and live update, and "needs context?" and relevance at handoff, in `server/` (lane A). **Routing:** "does agent *k* need this now?" in `distiller/src/dispatch/routing.ts`. | Client: **built**, but the request shape is unverified against TypeSafe's docs (blocker Q3; gate Sat 09:00, else the Claude fallback). Triage: **in progress** (B5; walls-era version on PR #10, `b/triage`). Scope and handoff questions: **planned** (lane A). Routing: **in progress** (B18). |
| **Moss** | Moss (add-on) | **Search:** `server/src/retrieval/moss.ts`, picked by `createRetriever()` in `server/src/retrieval/index.ts`: candidates for every scope build, live update and handoff, with each fact indexed by id, group and labels, and handoffs filtered with `$in` on the scope's fact ids. Today `server/src/retrieval/keyword.ts` runs instead. | **planned** (A4, blocker Q2: credentials). The class exists and throws "not implemented." |
| **Hyphenate** | Autonomous Systems for Finance (core) | The whole product. **Contract:** `shared/src/types/scopes.ts`, `agents.ts`, `api.ts`. **Scope builder:** exclusions in code → Moss → Jev yes/no → a fixed list of fact ids, each stage timed (`scope.stage` events), in `server/`. **Living scopes:** new facts join scopes, rule edits rebuild them (`scope.updated`), in `server/`. **Handoff and audit:** search inside the scope → Jev relevance → token budget → audit row, the pinned profile and `canon_whoami` without exclusions (`/api/handoff`, `/api/audit`, MCP), in `server/`. **Tiers and agent profiles:** moderators add people and edit rules, members create agents whose scope is checked in code to be a subset of theirs (`/api/principals`, `/api/scope-rules`, `/api/agents`), in `server/`. **Moderator console** and **member view:** `web/` (Edan). **Video and pitch scripts:** `docs/VIDEO_SCRIPT.md`, `docs/PITCH.md`. | Contract: **in review** (draft PR #7). Scope builder, living scopes, handoff and audit, tiers and agent profiles: **planned** (lane A; the status tasks still carry walls-era titles). Moderator console, member view: **planned** (C13, C14). Video and pitch scripts: **in review** (`b/story-scopes`, stacked on PR #7). |
| **Microsoft** | Built for the Real World + Customer Impact (core) | **Runner:** `bench/`: runner, scoring and `bench/results/chart.json`. **Finance benchmark:** four setups (no memory, shared memory, Bullwark + Claude filter, Bullwark + Jev) measuring leak rate, missing-context rate, task accuracy, tokens, time to first reply, cost, scope build time and save-time cost, over 60 attacks (10 per style, including agent escalation) and 30 tasks. **Scale slide text:** [`SCALE_SLIDE.md`](SCALE_SLIDE.md), plus `docs/DEVPOST.md` and `docs/PITCH.md`. Audit log from the server (`/api/audit`). | Runner: **built** for the scaffold's 3 baselines; those results don't measure scopes. Finance benchmark: **planned** (A8 runner, C6 task and attack sets; both status tasks still say 50 attacks and "wrongly blocked"). Scale slide text: **in review** (`b/story-scopes`, stacked on PR #7). |
| **Armadin** | Best Security Hack (add-on) | **Quarantine:** the "instructions aimed at an AI?" question in `distiller/src/triage.ts`; a flagged item is posted to `/api/quarantine` and joins no scope until a moderator releases it. Scopes enforced in code and agents capped at their creator's scope are the Hyphenate rows above. **Attack box:** in `web/`, where judges try to extract Falcon as a member or by creating an agent. | Quarantine: **in progress** (B5; walls-era version on PR #10). Attack box: **planned** (should ship, C16). |

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
| Claude Code hook | `hooks/claude-code/` | **built** (B1). Author fields (principal, kind): **in review** (B19; PR #12, `b/ingest`), being updated for the scopes contract. |
| ChatGPT extension | `extension/` | **built** for scaffold capture (code and tests on `main`). Author fields: **in review** (B4; PR #12, `b/ingest`). Live demo test: not done. First capture path to cut; if it is cut, Dan's ChatGPT session goes in through the ingest client as an `ai_session`. |
| Ingest client (memos, chat, notes, email, AI sessions) | `hooks/ingest/` | **in review** (B19; PR #12, `b/ingest`), being updated for the scopes contract. Posts to `POST /api/sessions`, which is on `main`. |
| Storage and events | `server/` | **built**: local files (one markdown file per fact, filed by group, raw sessions in a cold archive) and plain SSE. There is no database. |
| Memory browser (view, edit, retire facts) | `web/` (C18) | **planned**. Members browse only their scope. Retiring moves a fact to cold storage with its history kept; nothing is hard-deleted. |
| Scope map, quarantine view | `web/` (C15, B11) | **planned**, first and third in the cut order. |
