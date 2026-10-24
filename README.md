# Bullwark

The control room for a small finance team's AI. Each person and agent gets only the context
they are cleared to see and need, and information barriers stay enforced as deals change.
Built at Cal Hacks 13.0.

- **Product scope:** [`docs/PRD.md`](docs/PRD.md)
- **Owners and build order:** [`docs/WORK_SPLIT.md`](docs/WORK_SPLIT.md)
- **Working agreement:** [`CLAUDE.md`](CLAUDE.md)
- **Progress:** [`STATUS.md`](STATUS.md), generated from [`status/status.json`](status/status.json)

The current code is a working capture, distillation and retrieval scaffold. Deal entitlements,
wall-crossings, audit records and agent dispatch are planned work; existing folder grants do
not establish those protections. Package READMEs describe implemented behavior.

## Quick start

```bash
npm install            # Node 22+, see .nvmrc
cp .env.example .env   # optional; without keys, providers are labelled simulated
npm run doctor
npm run seed -w server # optional development fixtures; skips existing files
npm run dev            # server :4100, distiller worker, frontend :4200
```

| URL | What runs today |
|---|---|
| http://localhost:4200 | Development dashboard: sessions, facts, tokens, latency and cost |
| http://localhost:4100/health | Server health; `/events` for SSE, `/mcp` for MCP |
| http://localhost:4173 | Team status board (`npm run status:board`) |

## Product flow

Capture and ingest archive raw context. Triage and the fact writer attach sources and wall
labels. Before each handoff, code checks clearance, search finds candidates, Jev selects relevant
facts, and code applies a token budget and records the exact handoff. Dispatched agents receive
only their permitted slice, with urgent updates when a deal is announced or terminated.

The build keeps the existing file store and plain SSE. The target frontend is a control room
with deals, clearances, pending requests, agent lanes and a handoff inspector. See the PRD for
the full design and the work split for implementation ownership.

## Layout

| Folder | Owner | Purpose |
|---|---|---|
| [`shared/`](shared/) | A + B | Contract types, validation, grants, events and `judge()` |
| [`server/`](server/) | A · Henry | Store, archive, MCP, REST, SSE, retrieval; planned permission and audit pipeline |
| [`distiller/`](distiller/) | B · Victor | Capture-to-facts worker; planned triage, fact writing and agent orchestration |
| [`hooks/`](hooks/) | B · Victor | Claude Code capture hook |
| [`extension/`](extension/) | B · Victor | ChatGPT web capture |
| [`web/`](web/) | C · Edan | Dashboard and control room frontend |
| [`bench/`](bench/) | A runs, C writes tasks | Measured results; target attack and legitimate-task evaluation |
| [`status/`](status/) | Everyone; C maintains blockers | Progress source, generated board and sync script |
| [`scripts/`](scripts/) | Root | Preflight and local process launcher |
| [`docs/`](docs/) | B | PRD, work split, demo and sponsor documentation |

## Commands

| Command | Purpose |
|---|---|
| `npm run doctor` | Check Node, dependencies, environment, ports, status and data directory |
| `npm run dev [-- server web distiller status \| all]` | Run selected processes |
| `npm run check` | Validate status, typecheck workspaces and run tests |
| `npm run build` | Build browser bundles |
| `npm run status` / `status:check` / `status:board` | Regenerate, validate or serve the progress board |
| `npm run <script> -w <pkg>` | Run a package command |

After editing `status/status.json`, run `npm run status` and commit the generated board with
the work. Keep credentials in `.env`; share keys directly between teammates.

## Sponsor tracks and integration evidence

Where each sponsor's tool does real work in the product described in the PRD (two tiers and
task-built scopes for small finance teams: moderators see everything, and every other person and
agent gets a memory that holds only what their task needs). Status says where the code is, and
nothing counts as shipped until it is on `main`:

- **built**: on `main` and running in the demo.
- **in review**: on an open pull request, not merged to `main` (the PR is named).
- **in progress**: on a pushed branch with no pull request yet, or still being written. An item
  whose open PR was written for the cut walls design stays here until its scopes version is up
  for review.
- **planned**: not started, waiting on a blocker, or in the cut order.

Paths below that are not on `main` exist only on the pull request named next to them. File-level
detail, blockers and the last check time: [`docs/SPONSORS.md`](docs/SPONSORS.md). Devpost
text: [`docs/DEVPOST.md`](docs/DEVPOST.md). Scale slide: [`docs/SCALE_SLIDE.md`](docs/SCALE_SLIDE.md).

- **Factory Droid:** runs every agent as headless `droid exec --auto low`, one sandbox folder
  per run outside the repo holding only that agent's scope as markdown files, a few short steps
  with an inbox between them, and every step streamed into the agent's dashboard lane. New
  in-scope facts reach the agent at its next step; when its creator's scope narrows, the run
  restarts from the plan step in a fresh folder without the removed facts. On `main` the Droid
  distiller engine is still a stub. Agent runs and live routing: **in progress** (B2, B18; the
  walls-era version is on PR #9); gate Sat 11:00 (blocker Q1). See
  [Where Droid runs](#where-droid-runs) below.
- **Anthropic (Claude):** `claude-sonnet-5-5` writes facts from captured context
  (`distiller/src/engines/claude.ts`) and agent briefs from the agent's scope;
  `claude-haiku-5-5` is the fallback judge (`shared/src/judge/claude.ts`); the benchmark
  responder is `bench/src/responder.ts`. Excluded groups are removed in code before any model
  sees a fact, and briefs are written only from facts already in the agent's scope. When the
  fallback judge runs (no Jev key, blocker Q3), Claude Haiku picks each fact's group (unsure
  goes to the moderators-only `inbox`) and answers the scope-build questions, where a "maybe" on
  an exclusion counts as excluded. The risk left is a deal fact misfiled into a public group that
  the per-fact exclusion check also misses; the benchmark's paraphrase and indirect attacks
  measure it. Judge, scaffold fact writer and responder: **built**. Finance fact writer: **in
  review** (B17, on draft PR #7). Briefs and the fallback agent runner: **in progress** (B2).
- **Jev (TypeSafe AI)**, not a prize track: the judge behind save-time triage (keep, which group,
  AI instructions, relation), the scope builder's exclusion and relevance questions, handoff
  relevance and live routing (`shared/src/judge/jev.ts`, `distiller/src/triage.ts`,
  `server/`). Client **built** but unverified against TypeSafe's docs (blocker Q3). Triage:
  **in progress** (B5; the walls-era version is on PR #10). Scope and handoff questions:
  **planned** (lane A).
- **Moss:** candidates for every scope build, live update and handoff, with each fact indexed by
  id, group and labels so a handoff searches only inside the requester's scope
  (`server/src/retrieval/moss.ts`). **Planned** (A4, blocker Q2); `moss.ts` is a stub and the
  keyword retriever runs today.
- **Hyphenate (Autonomous Systems for Finance):** the whole product: two tiers, the scope builder
  (exclusions in code → Moss → Jev yes/no → a fixed list of fact ids), living scopes, agent
  profiles capped at their creator's scope, no refusals, and the audit log
  (`shared/src/types/scopes.ts`, `server/`, `web/`). Scopes contract: **in review** (draft PR
  #7). Scope builder, living scopes, tiers, agent profiles, handoff and audit in `server/`:
  **planned** (lane A). Moderator console and member view in `web/`: **planned** (C13, C14).
- **Microsoft (Built for the Real World):** the benchmark in `bench/` (leak rate,
  missing-context rate, accuracy, tokens, latency, cost and scope build time across four setups,
  over 60 attacks and 30 tasks), the audit log and the scale path. The scaffold runner for three
  baselines is **built**, but its results do not measure scopes. Finance runner and task sets:
  **planned** (A8, C6). Scale slide: **in review** (`b/story-scopes`, stacked on PR #7).
- **Armadin (security):** scopes enforced in code at question time (no refusal to probe),
  agents capped at their creator's scope, quarantine of captured text with instructions aimed at
  an AI, and the attack box. Quarantine: **in progress** (B5; the walls-era version is on PR
  #10). Scopes and agent caps: **planned** (lane A). Attack box: **planned** (C16). See
  `docs/SPONSORS.md`.
- **Bitdeer, Mana, Notability:** **planned**, see `docs/SPONSORS.md`.

### Where Droid runs

Status: **in progress** (B2 agent runs, B18 live routing). Nothing below is on `main`. The
walls-era dispatcher is on PR #9 (`b/dispatch`), and `distiller/src/dispatch/` exists only there
until the scopes version merges; its sides and exit check are cut. If Droid can't run headless
finance tasks (gate Sat 11:00, blocker Q1), the Claude runner takes over and this section is
removed.

| Step | Where | What Droid does |
|---|---|---|
| Create | `POST /api/agents`, then `POST /api/dispatch` | A member creates an agent with a task and optional exclusions. The server builds its scope from the creator's scope only and checks it is a subset. A dispatch request starts the run. |
| Sandbox | One folder per run, outside the repo and the data directory (on PR #9: `$TMPDIR/canon-agents/<run>/`) | The folder holds only the agent's scope as markdown files (`GET /api/scopes/:principal/facts`), quoted as information, never instructions, plus a brief Claude writes from them. Droid runs `droid exec --auto low` there and reads and writes files in that folder; whether `--auto low` also lets it run Python for the numbers is still to be confirmed at the Factory booth (blocker Q1). On macOS a `sandbox-exec` profile denies the repo, the data directory and other runs. |
| Steps and lanes | `agent.run`, `agent.step` events | Each task is a few short Droid steps. Every step, file and result streams into the agent's dashboard lane and its audit record. The agent's new facts are saved as its creator's memories. |
| Live routing | `distiller/src/dispatch/routing.ts`, `agent.inbox` events | Between steps, facts that join the agent's scope reach its inbox when Jev says it needs them now. A narrowed scope is urgent: the run folder is discarded and the run restarts from the plan step in a fresh folder built from the new scope. |

The demo uses synthetic data. Quote measured runs only and label simulated behavior.
