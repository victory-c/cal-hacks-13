# Canon

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

Where each sponsor's tool does real work in the product described in the PRD (context with walls
for small finance teams). Status says where the code is, and nothing counts as shipped until it
is on `main`:

- **built**: on `main` and running in the demo.
- **in review**: on an open pull request, not merged to `main` (the PR is named).
- **in progress**: on a pushed branch with no pull request yet, or still being written.
- **planned**: not started, waiting on a blocker, or in the cut order.

Paths below that are not on `main` exist only on the pull request named next to them. File-level
detail, blockers and the last check time: [`docs/SPONSORS.md`](docs/SPONSORS.md). Devpost
text: [`docs/DEVPOST.md`](docs/DEVPOST.md). Scale slide: [`docs/SCALE_SLIDE.md`](docs/SCALE_SLIDE.md).

- **Factory Droid:** runs every dispatched agent as headless `droid exec --auto low`, one
  sandbox folder per agent outside the repo, a few short steps with an inbox between them, and
  every step streamed into the agent's dashboard lane. On `main` the Droid distiller engine is
  still a stub. Dispatch and live routing: **in review** (B2, B18, PR #9); gate Sat 11:00
  (blocker Q1). See [Where Droid runs](#where-droid-runs) below.
- **Anthropic (Claude):** `claude-sonnet-5-5` writes facts from captured context
  (`distiller/src/engines/claude.ts`) and agent briefs; `claude-haiku-5-5` is the fallback judge
  (`shared/src/judge/claude.ts`); the benchmark responder is `bench/src/responder.ts`. No model
  can lower a wall or grant access, and briefs are written only from facts that passed the
  permission filter. At save time, code rules plus the judge's answers set each fact's wall
  label, which only moves up. When the fallback judge runs (no Jev key, blocker Q3), Claude
  Haiku answers the "confidential?" and "which deal?" questions, and a 20% chance counts as yes.
  The risk left is a deal fact that both the alias rules and the judge miss; the benchmark's
  paraphrase and indirect attacks and the exit check measure it. Judge, scaffold fact writer
  and responder: **built**. Finance fact writer: **in review** (B17, PR #11). Briefs and the
  fallback agent runner: **in review** (B2, PR #9).
- **Jev (TypeSafe AI)**, not a prize track: the judge behind save-time triage (keep,
  confidential, which deal, AI instructions, relation), handoff relevance, access pre-screen and
  live routing (`shared/src/judge/jev.ts`, `distiller/src/triage.ts`). Client **built** but
  unverified against TypeSafe's docs (blocker Q3). Triage: **in review** (B5, PR #10).
  Handoff relevance and pre-screen: **planned** (A7, A12).
- **Moss:** search by meaning on every handoff and routing check, after the permission filter
  (`server/src/retrieval/moss.ts`). **Planned** (A4, blocker Q2); `moss.ts` is a stub and the
  keyword retriever runs today.
- **Hyphenate (Autonomous Systems for Finance):** the whole product: deny-by-default walls,
  neutral refusals, the compliance queue and the audit log (`shared/src/types/walls.ts`,
  `server/`, `web/`). Finance contract: **in review** (draft PR #7). Permission filter, lists,
  refusals and audit in `server/`: **planned** (A6, A7, A11). Control room in `web/`:
  **planned** (C13, C14).
- **Microsoft (Built for the Real World):** the benchmark in `bench/` (leak rate,
  wrongly-blocked rate, accuracy, tokens, latency and cost across four setups), the audit log and
  the scale path. The scaffold runner for three baselines is **built**, but its results do not
  measure information barriers. Finance runner and task sets: **planned** (A8, C6). Scale slide:
  **in review** (`b/story`, stacked on PR #7).
- **Armadin (security):** injection quarantine at triage, raise-only wall labels, neutral
  refusals and the exit check on agent outputs. Triage and labels: **in review** (B5, B17; PRs
  #10, #11). Refusal wording: **in review** (PR #7). Filter and exit check: **planned** (A6,
  A11, A13). See `docs/SPONSORS.md`.
- **Bitdeer, Mana, Notability:** **planned**, see `docs/SPONSORS.md`.

### Where Droid runs

Status: **in review** (B2 dispatch, B18 live routing; PR #9, `b/dispatch`). Nothing below is on
`main`, and `distiller/src/dispatch/` exists only on that branch until it merges. If Droid can't
run headless finance tasks (gate Sat 11:00, blocker Q1), the Claude runner takes over and this
section is removed.

| Step | Where (on `b/dispatch`) | What Droid does |
|---|---|---|
| Dispatch | `distiller/src/dispatch/` | A task typed in the control room is split into one agent run per side of the wall. Each run starts `droid exec --auto low` headless, as its own principal. |
| Sandbox | `$TMPDIR/canon-agents/<run>/` | One folder per agent, outside the repo and the data directory, holding only the files its slice allows. Droid reads and writes files in that folder; whether `--auto low` also lets it run Python for the numbers is still to be confirmed at the Factory booth (blocker Q1). On macOS a `sandbox-exec` profile denies the repo, the data directory and other runs. When the run ends, the folder is locked and copied to `data/agents/<run>/` as its record. |
| Steps and lanes | `agent.step` events | Each task is a few short Droid steps. Every step, file and result streams into the agent's dashboard lane and its audit record. |
| Live routing | `distiller/src/dispatch/routing.ts` | Between steps, wall changes and new facts reach the agent's inbox. A terminated deal cancels the next step and locks the folder. |

The demo uses synthetic data. Quote measured runs only and label simulated behavior.
