# Canon

One place that keeps your context from every AI session, live, and gives each new chat only
what it needs. Built at Cal Hacks 13.0.

Canon captures sessions from Claude, ChatGPT and Gemini on the web and from Claude Code,
Cursor and Hermes as they happen, with no export or import. When you open a new session
anywhere, Jev picks the small slice of context that's relevant and Moss retrieves it. You
decide which AI can see which folder.

- **Spec:** [`docs/PRD.md`](docs/PRD.md)
- **Working agreement for humans and agents:** [`CLAUDE.md`](CLAUDE.md)
- **Progress:** [`STATUS.md`](STATUS.md), generated from [`status/status.json`](status/status.json)

## Quick start

```bash
npm install            # Node 22+ (see .nvmrc)
cp .env.example .env   # optional: without keys everything runs on local stubs, labelled simulated
npm run doctor         # preflight: node, install, .env, ports, data dir
npm run seed -w server # demo facts + a session into data/ (skips files already there)
npm run dev            # server :4100 + distiller worker + dashboard :4200
```

| URL | What |
|---|---|
| http://localhost:4200 | Live dashboard: sessions, facts, token / latency / cost counter |
| http://localhost:4200/resume.html | Resume viewer, each line linking to its source session |
| http://localhost:4100/health | Server health; `/events` is the SSE stream, `/mcp` the MCP endpoint |
| http://localhost:4173 | Team status board (`npm run status:board`) |

Before every PR: `npm run check` (status.json valid → typecheck → tests).

## How it fits together

```
hooks/ (Claude Code)   ─┐
extension/ (ChatGPT)   ─┼─ POST /api/sessions ─▶  server/  ─▶ cold archive   data/sessions/*.json
canon_save over MCP    ─┘                            │
                                              SSE  /events  (session.captured, fact.saved, context.served …)
                                                     │
                      distiller/ worker:  session ─▶ Droid distills ─▶ Jev decides (hot? folder? dupe?) ─▶ POST /api/facts
                                                     │
                                        hot facts   data/facts/<folder>/*.md   ─▶ retriever (Moss)
                                                     │
   Claude Code · ChatGPT · Cursor  ──  MCP canon_context(task)  ─▶  Jev filters candidates  ─▶  ~1–2K tokens back
                                                     │
                                          web/ dashboard renders every event + the counter
```

Every piece is a separate process talking over HTTP, so each lane runs and tests its own
folder against the server (or against a recorded session fixture) without waiting.

## Layout

| Folder | Lane | What |
|---|---|---|
| [`shared/`](shared/) | A + B | The A↔B contract as code: fact schema, session capture, MCP tool I/O, SSE events, grants, `judge()` interface. `shared/src/types/` is frozen; change it with `CLAUDE.md` and the other builder. |
| [`server/`](server/) | A · Henry | MCP server (Streamable HTTP) + REST + SSE, file-backed fact store, cold archive, folder grants, retrieval (`KeywordRetriever` now, Moss next). |
| [`distiller/`](distiller/) | B · Victor | Worker on the event stream: captured session → facts (Droid, Claude fallback, heuristic stub) → Jev save-time decisions → server. |
| [`hooks/`](hooks/) | B · Victor | Claude Code capture hook. Plain Node, zero deps. |
| [`extension/`](extension/) | B · Victor | Chrome MV3 extension capturing ChatGPT (then Claude, Gemini) web sessions live. |
| [`web/`](web/) | B · Victor | Live dashboard with the token counter, and the resume viewer. Static, bundled with esbuild. |
| [`bench/`](bench/) | A runs · C writes tasks | 20 handoff tasks × 3 baselines. The only source of quotable numbers. |
| [`status/`](status/) | everyone | `status.json` (source of truth), board, sync script. |
| [`scripts/`](scripts/) | root | `doctor.mjs` preflight, `dev.mjs` runs the stack. |
| [`docs/`](docs/) | B | PRD, demo script, sponsor notes. |

## Root scripts

| Command | Does |
|---|---|
| `npm run doctor` | Checks Node ≥ 22, install, `.env` keys (names only), free ports, `status.json`, data dir (warns to seed) |
| `npm run dev [-- server web distiller status \| all]` | Runs the stack in one terminal, prefixed per process |
| `npm run check` | `status:check` + `typecheck` + `test` across all workspaces. CI runs the same |
| `npm run build` | Bundles the extension and the dashboard into their `dist/` |
| `npm run status` / `status:check` / `status:board` | Regenerate `STATUS.md` / validate only / serve the board |
| `npm run <script> -w <pkg>` | Any single package, e.g. `npm run dev -w server`, `npm test -w shared` |

## Status board

`npm run status:board`, then open http://localhost:4173. After editing `status/status.json`,
run `npm run status`: it validates the file and regenerates `STATUS.md`. Commit both with your
work.

## Setup

Copy `.env.example` to `.env` and fill in the keys you have. Never commit `.env`. Keys are
handed person to person, never through git or chat logs.

## Sponsor tracks

Where each sponsor's tool does real work in the running product (PRD v2: context with walls for
small finance teams). Status is honest: **built** = on `main` and in the demo, **in progress** =
on a branch, **planned** = not started or blocked. Full detail, blockers and the last check
time: [`docs/SPONSORS.md`](docs/SPONSORS.md). Devpost text: [`docs/DEVPOST.md`](docs/DEVPOST.md).

- **Factory Droid:** runs every dispatched agent as headless `droid exec` at a low permission
  level, one sandbox folder per agent, steps streamed into the agent's dashboard lane, updates
  routed between steps (`distiller/src/dispatch/`). **In progress**; gate Sat 11:00 (blocker Q1).
- **Anthropic (Claude):** `claude-sonnet-5-5` writes facts from captured context
  (`distiller/src/engines/claude.ts`) and agent briefs; `claude-haiku-5-5` is the fallback judge
  (`shared/src/judge/claude.ts`). Claude never decides access: wall labels come from code rules
  and Jev and only move up, and briefs are written only from facts that passed the permission
  filter. Judge **built**; finance writer and briefs **in progress**.
- **Jev (TypeSafe AI):** the judge behind save-time triage (keep, confidential, which deal, AI
  instructions, relation), handoff relevance, access pre-screen and live routing
  (`shared/src/judge/jev.ts`, `distiller/src/triage.ts`). Client **built** but unverified
  against TypeSafe's docs (blocker Q3); triage **in progress**.
- **Moss:** search by meaning on every handoff and routing check, after the permission filter
  (`server/src/retrieval/moss.ts`). **Planned** (blocker Q2); the keyword retriever runs today.
- **Hyphenate (Autonomous Systems for Finance):** the whole product: deny-by-default walls,
  neutral refusals, the compliance queue and the audit log (`shared/src/types/walls.ts`,
  `server/`, `web/`). Contract **built** on `b/contract-v2`; server and control room **planned**.
- **Microsoft (Built for the Real World):** the benchmark in `bench/` (leak rate, wrongly-blocked
  rate, accuracy, tokens, latency, cost across four setups) and the scale path. v1 runner
  **built**; v2 setups **planned**.
- **Armadin (security):** injection quarantine at triage, raise-only wall labels, neutral
  refusals and the exit check on agent outputs. **In progress / planned**, see
  `docs/SPONSORS.md`.
- **Bitdeer, Mana, Notability:** **planned**, see `docs/SPONSORS.md`.
