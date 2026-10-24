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

## Integration evidence

- **Anthropic:** Claude fact writing and briefs are the product plan. Existing Claude adapters
  are in `distiller/src/engines/claude.ts`, `shared/src/judge/claude.ts` and `bench/src/responder.ts`.
- **Factory:** the target is dispatched finance agents with isolated context, visible steps and
  inbox updates. The current Droid distiller adapter is a stub; headless dispatch is pending.
- **Moss:** permission-scoped retrieval is planned. `server/src/retrieval/moss.ts` is currently
  a stub; the working local fallback is keyword retrieval.
- **Jev:** `shared/src/judge/jev.ts` provides the adapter behind `judge()`. API access and the
  provider contract must be verified before claiming a real integration.
- **Hyphenate and Microsoft:** proof will come from the finance demo, audit trail and measured
  leak, wrongly blocked, accuracy, token, latency and cost results. Existing scaffold results
  alone do not measure information barriers.

The demo uses synthetic data. Quote measured runs only and label simulated behavior.
