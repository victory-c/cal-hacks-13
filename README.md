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

## Sponsor integrations

Each section says where the integration does real work in the running product. They get
filled in as the work lands.

- **Anthropic (Claude):** distiller fallback (`distiller/src/engines/claude.ts`, `claude-sonnet-5-5`), judge fallback (`shared/src/judge/claude.ts`, `claude-haiku-5-5`), resume writing. _Role and failure modes: TBD_
- **Factory Droid SDK:** the distiller engine (`distiller/src/engines/droid.ts`): runs on every captured session, can only write to the fact store, plan + fact diffs shown on the dashboard. _TBD_
- **Moss:** the retrieval layer behind `canon_context` (`server/src/retrieval/`). Retrieval latency shows on the dashboard. _TBD_
- **Microsoft (Built for the Real World):** benchmark chart from `bench/results/`, scale slide, responsible-design notes (folders, cold archive). _TBD_
