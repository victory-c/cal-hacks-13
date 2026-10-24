# Bullwark + Canon

Scoped AI memory for small finance teams. Moderators see everything; every other person and agent
gets a memory that holds only what their task needs, and anything else simply isn't there.
Built at Cal Hacks 13.0.

| | Bullwark | Canon |
|---|---|---|
| **Is** | The control room people use | The agentic backend that does the work |
| **Does** | Moderator console, member view, finance wording, the demo | Capture, facts and groups, tiers and scopes, handoffs, agents, MCP, audit |
| **Spec** | [`docs/BULLWARK-PRD.md`](docs/BULLWARK-PRD.md) | [`docs/CANON-PRD.md`](docs/CANON-PRD.md) |
| **Code** | `web/` | `server/`, `distiller/`, `hooks/`, `extension/`, `shared/` |

Bullwark decides what to show; Canon decides who may see what. They meet only through
[`docs/INTEGRATION.md`](docs/INTEGRATION.md): REST, server-sent events and one token per person or agent.

- **Owners and build order:** [`docs/WORK_SPLIT.md`](docs/WORK_SPLIT.md)
- **Working agreement:** [`CLAUDE.md`](CLAUDE.md)
- **Progress:** [`STATUS.md`](STATUS.md), generated from [`status/status.json`](status/status.json)

The current code is a working capture, distillation and retrieval scaffold. Tiers, scopes, the
scope builder, audit records and agent runs are planned work; existing folder grants do not
establish those protections. Package READMEs describe implemented behavior.

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
| [`server/`](server/) | Canon | A · Henry | Store, archive, MCP, REST, SSE, retrieval; planned scopes, scope builder and audit |
| [`distiller/`](distiller/) | Canon | B · Victor | Capture-to-facts worker; planned triage, grouping, fact writing and agent runs |
| [`hooks/`](hooks/) | Canon | B · Victor | Claude Code capture hook |
| [`extension/`](extension/) | Canon | B · Victor | ChatGPT web capture |
| [`web/`](web/) | Bullwark | C · Edan | Dashboard, moderator console and member view |
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

## Integration evidence

- **Anthropic:** Claude fact writing and briefs are the product plan. Existing Claude adapters
  are in `distiller/src/engines/claude.ts`, `shared/src/judge/claude.ts` and `bench/src/responder.ts`.
- **Factory:** the target is Droid running every agent in a sandbox folder holding only its scope,
  with visible steps and inbox updates. The current Droid distiller adapter is a stub; headless dispatch is pending.
- **Moss:** scope builds and in-scope handoff search are planned. `server/src/retrieval/moss.ts` is currently
  a stub; the working local fallback is keyword retrieval.
- **Jev:** `shared/src/judge/jev.ts` provides the adapter behind `judge()`. API access and the
  provider contract must be verified before claiming a real integration.
- **Hyphenate and Microsoft:** proof will come from the finance demo, audit trail and measured
  leak, missing-context, accuracy, token, latency and cost results. Existing scaffold results
  alone do not measure information barriers.

The demo uses synthetic data. Quote measured runs only and label simulated behavior.
