# Bullwark + Canon

Scoped AI memory for small finance teams. Moderators see everything; every other person and agent
gets a memory that holds only what their task needs, and anything else simply isn't there.
Built at Cal Hacks 13.0.

| | Bullwark | Canon |
|---|---|---|
| **Is** | The control room people use | The agentic backend that does the work |
| **Does** | Moderator console, member view, finance wording, the demo | Capture, facts and groups, tiers and scopes, handoffs, agents, MCP, audit |
| **Spec** | [`docs/BULLWARK-PRD.md`](docs/BULLWARK-PRD.md) | [`docs/CANON-PRD.md`](docs/CANON-PRD.md); the end-to-end loop and its gaps: [`docs/PIPELINE-PRD.md`](docs/PIPELINE-PRD.md) |
| **Code** | `web/` | `server/`, `distiller/`, `hooks/`, `extension/`, `shared/` |

Bullwark decides what to show; Canon decides who may see what. They meet only through
[`docs/INTEGRATION.md`](docs/INTEGRATION.md): REST, server-sent events and one token per person or agent.

- **Owners and build order:** [`docs/WORK_SPLIT.md`](docs/WORK_SPLIT.md)
- **Working agreement:** [`CLAUDE.md`](CLAUDE.md)
- **Progress:** [`STATUS.md`](STATUS.md), generated from [`status/status.json`](status/status.json)

The finance world, moderator console and member view now run together. Canon enforces scopes
across REST, MCP, before-prompt reads and agent runs; capture feeds the writer and triage pipeline.
World state and audit survive restarts. See package READMEs and the integration contract for the
implemented routes and remaining limits.

## Quick start

```bash
npm install            # Node 22+, see .nvmrc
cp .env.example .env   # optional; without keys, providers are labelled simulated
npm run doctor
npm run seed -w server # optional development fixtures; skips existing files
npm run dev            # server :4100, distiller worker, agent dispatcher, frontend :4200
```

| URL | What runs today |
|---|---|
| http://localhost:4200/moderator.html | Live moderator console (supply an authenticated moderator token for direct development) |
| http://localhost:4200/member.html | Live member view (person token for direct development) |
| http://localhost:4100/health | Server health; `/events` for SSE, `/mcp` for MCP |
| http://localhost:4173 | Team status board (`npm run status:board`) |

## Shared preview

See [`docs/PREVIEW.md`](docs/PREVIEW.md) for the Docker preview and sponsor-host deployment.
`npm run preview:setup` generates local credentials in gitignored `.env.preview`;
`npm run preview:check` checks configured provider credentials without printing values.
The browser preview is at `http://localhost:8080`, with a visible team sign-in page.

The login selects a synthetic demo identity; Canon enforces that identity's scope. Everyone with
the shared password can select any demo identity, so this is team demo access rather than individual
employee authentication. No sponsor key is needed in a teammate's browser. Pages default to live
Canon; `?data=mock` explicitly selects labelled fixtures. Use **Switch demo identity** to change roles.
Factory extracts facts, Jev judges, Moss retrieves, and the Docker preview uses the Claude scoped
agent runner. Linux Droid dispatch requires a supported sandbox. See
[`docs/SHARED_PREVIEW.md`](docs/SHARED_PREVIEW.md) for measured live checks and hosting status.

## How it works

**Canon.** Capture and ingest archive raw context. Triage and the fact writer turn it into short facts,
each linked to its source and author and filed into one group. A moderator gives each member a
scope rule (a task in plain language plus optional exclusions): code removes excluded groups,
Moss finds candidates and Jev answers yes or no, and the result is the member's scope. Scopes
stay current as new facts arrive. Each handoff searches only inside the requester's scope, keeps
what helps, fits a token budget and is logged. Agents a member creates get the same scope or less.
It keeps the existing file store and plain SSE.

**Bullwark.** A moderator console (people and tiers, scope builder, scope inspector, feed, agent
lanes, handoff inspector) and a member view (my agents, create an agent, my memory), reading Canon
only through the integration contract. See the PRDs for the full design and the work split for
implementation ownership.

## Layout

| Folder | Part | Owner | Purpose |
|---|---|---|---|
| [`shared/`](shared/) | Canon | A + B | Contract types, validation, grants, events and `judge()` |
| [`server/`](server/) | Canon | A · Henry | Store, archive, MCP, REST, SSE, retrieval, scopes, scope builder and persistent audit |
| [`distiller/`](distiller/) | Canon | B · Victor | Capture-to-facts worker, triage, grouping, fact writing and scoped agent runs |
| [`hooks/`](hooks/) | Canon | B · Victor | Claude Code capture and before-prompt context hooks |
| [`extension/`](extension/) | Canon | B · Victor | ChatGPT web capture |
| [`web/`](web/) | Bullwark | C · Edan | Dashboard, moderator console and member view |
| [`fixtures/world/`](fixtures/world/) | Both | C · Edan | The synthetic demo world (Axe Capital, Project Stonewall) and its answer key |
| [`bench/`](bench/) | Both | A runs, C writes tasks | Measured results; target attack and legitimate-task evaluation |
| [`status/`](status/) | Team | Everyone; C maintains blockers | Progress source, generated board and sync script |
| [`scripts/`](scripts/) | Team | Root | Preflight and local process launcher |
| [`docs/`](docs/) | Both | B | PRDs, integration contract, work split, demo and sponsor documentation |

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

- **Anthropic:** Claude fact writing and briefs are the product plan. Existing Claude adapters
  are in `distiller/src/engines/claude.ts`, `shared/src/judge/claude.ts` and `bench/src/responder.ts`.
- **Factory:** the target is Droid running every agent in a sandbox folder holding only its scope,
  with visible steps and inbox updates. The scaffold now has an optional headless SDK distiller
  (`distiller/src/engines/droid.ts`) that proposes structured facts with tools disabled. Scoped
  finance-agent dispatch is separate pending work.
- **Moss:** scope builds and in-scope handoff search are planned. `server/src/retrieval/moss.ts` now implements
  local hybrid retrieval over hot facts with folder metadata prefilters and canonical-ID checks.
  Scope-based group, label and fact-ID filtering remains pending; keyword retrieval is the offline fallback.
- **Jev:** `shared/src/judge/jev.ts` provides the adapter behind `judge()`. It uses TypeSafe's
  documented keyed questions and answers at `https://api.typesafe.ai/v1/systemone` by default. Live
  requests passed; this does not validate the planned scope pipeline.
- **Hyphenate and Microsoft:** proof will come from the finance demo, audit trail and measured
  leak, missing-context, accuracy, token, latency and cost results. Existing scaffold results
  alone do not measure information barriers.

The demo uses synthetic data. Quote measured runs only and label simulated behavior.
