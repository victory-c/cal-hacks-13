# `bench/` — the only source of quotable numbers

**Owner:** lane A · Henry Lai runs it. Lane C · Edan Wong writes the tasks in [`tasks/`](tasks/)
(see [`tasks/README.md`](tasks/README.md)). Skeleton built by lane B.

Every token, latency, cost and accuracy figure on Devpost, in the pitch and on the dashboard
comes from a run of this package (CLAUDE.md: *never invent numbers*, *only compare against
baselines we run*). The runner refuses to write quotable files from a simulated run.

## Finance benchmark (A8): four setups, leaks and missing context

`npm run finance -w bench` runs every case in [`tasks/finance/`](tasks/finance/) (C6: 30 tasks +
60 attacks, 10 per PRD style, in the Axe Capital world of `fixtures/world/`; the runner consumes
whatever exists) across the four PRD setups. Each setup's server is seeded with that world's answer
key (every non-quarantined item; no scaffold notes), so a case's `needed_fact_ids` are the facts in
the store. A case may set `"state": "announced"`: the runner runs every confidential case first,
then moves the world to 1:20 once (the moderator refiles the announced terms to `market/public`
through `POST /api/facts/:id/file`), then runs the announced cases.

| Setup | What it is |
|---|---|
| `no-memory` | agents start from zero |
| `shared-memory` | every fact in one store; the prompt is told to respect the walls |
| `bullwark-claude` | Bullwark scopes, Claude making the yes/no calls |
| `bullwark-jev` | the full product (Jev when credentialed) |

The Bullwark setups start the **real server** (`server/src/app.ts`) in-process on a free port with
a throwaway seeded data dir and the setup's judge, rebuild every member scope (as Wags) through
`PUT /api/scope-rules` (scope build time is measured there), and run every case as one
`POST /api/handoff` — the same `server/src/scopes.ts runHandoff` pipeline production traffic uses,
never a bench-side reimplementation. Agent-escalation attacks create their agent through
`POST /api/agents` as the member and ask through it; planted-instruction sessions go in through
`POST /api/sessions` (they become facts only when lane B's distiller worker is attached — the
runner says so).

**Measured per setup:** leak rate (code check: served facts against the member's excluded groups,
leak-probe strings in everything served and answered, plus one judge question for paraphrased
leakage), missing-context rate (needed fact ids the handoff did not supply), task accuracy
(answer keys), tokens handed over, time to first reply, cost per handoff, scope build time.
Save-time cost per 100 items (with/without Jev triage) is **not measured yet** — it runs through
the distiller (B5/B17) — and the results carry that as `null` with a note, never a guess.

Results: `results/finance-<stamp>.json` always; `results/finance-latest.json` and
`results/finance-chart.json` (the pitch chart: leak rate against missing-context rate, one point
per setup) only from a measured run or with `--allow-simulated`, labelled. Cells that cannot be
evaluated (e.g. shared-memory leaks under an echo responder) count as `null`, never as a pass.

```bash
npm run finance:dry -w bench -- --include-examples   # offline plumbing check: SIMULATED
npm run finance -w bench                             # measured (ANTHROPIC_API_KEY; Jev/Moss keys for the full product)
npm run finance -w bench -- --setup bullwark-jev --case attack-01-direct-tmc-position
```

**Exit status:** `0` only when every requested cell ran. If any cell errors (a setup that fails to
open errors every case of that setup, a provider failure errors one) the runner still writes the
results with the error recorded, then exits `1`. Pass `--allow-partial` to accept a run where only
some cells errored; a run where every cell errored exits `1` regardless. A run with no cases at all
seeds the null results schema and exits `0`.

## Existing runner

The current runner accepts **handoff tasks**: context created in one AI (`from_client`, as short setup sessions), a
question asked in another (`to_client`), an answer key (`must_include` phrases, optional
`must_not_include`). Each task runs three ways; the same responder answers the same question:

| Baseline | Context injected | What it shows |
|---|---|---|
| `no-memory` | nothing | the fresh-session floor |
| `full-history` | every setup session pasted in | "just paste it all": the token ceiling |
| `canon` | `canon_context(question)` from the live server, as `to_client` | the lean slice |

Per cell we record `tokens_injected_est` (≈4 chars/token, labelled est.), the model's real
`usage.input_tokens` / `output_tokens`, prepare latency (for canon: the `canon_context` call),
answer latency, the answer, and the score. Summary: accuracy, mean tokens, mean latency, cost.

## Run

```bash
npm run validate -w bench                 # Edan: check every task file, no server needed
npm run dry -w bench -- --include-example # plumbing check, no model: SIMULATED, nothing quotable
npm run run -w bench                      # the real thing (needs ANTHROPIC_API_KEY + the server)
npm run run -w bench -- --baseline canon --task t03-public-summary
npm run run -w bench -- --help
```

**Exit status:** `0` only when every requested cell ran. If any cell errors (a missing token, an
unreachable server, a provider failure) the runner still writes the results with the error recorded,
then exits `1`, so CI cannot mistake an incomplete comparison for a complete one. Pass
`--allow-partial` to accept a run where only some cells errored; a run where every cell errored
exits `1` regardless.

**Real run needs:** `.env` with `ANTHROPIC_API_KEY` (responder: `claude-sonnet-5-5` over the
Messages API, usage recorded), `CANON_URL` + `CANON_CLIENT_TOKENS` (the canon baseline posts
sessions with `from_client`'s token and calls MCP with `to_client`'s), the server running with a
**real** judge and distiller, and optionally `BENCH_PRICE_PER_MTOK_IN` / `_OUT` for cost (unset →
cost is `null`, never guessed). `no-memory` and `full-history` need no server.

**Dry run** (`--dry`, or automatically when `ANTHROPIC_API_KEY` is unset): an echo responder
stands in for the model. The banner says `SIMULATED — not quotable`, accuracy / usage / cost are
`null`, and `results/latest.json` + `results/chart.json` are **not written** (`--allow-simulated`
writes them labelled `simulated: true`). The canon baseline still talks to the server, so a dry run
is the end-to-end plumbing test for lane A. The canon baseline also flags itself simulated when
`/health` reports `judge: fake` or the distiller ran as `heuristic`.

## Files

| Path | What |
|---|---|
| `tasks/finance/` | C6's finance cases: `task-NN-….json` + `attack-NN-….json`. See [`tasks/finance/README.md`](tasks/finance/README.md) |
| `examples/finance/` | `case.schema.json` for editors and the `*-00-example.json` documentation cases (run only with `--include-examples`), kept out of C6's directory |
| `tasks/t01-….json` | Edan's v1 handoff tasks. `task.schema.json` for editors, `t00-example.json` a full example (runs only with `--include-example`) |
| `results/<timestamp>.json` | One run, full detail. `results/latest.json` + `chart.json` (scaffold), `finance-latest.json` + `finance-chart.json` (A8): what Devpost and the dashboard quote. `results/raw/`: full contexts and answers, gitignored. See [`results/README.md`](results/README.md) |
| `src/run.ts` | scaffold CLI: tasks × baselines → prepare → respond → score → write |
| `src/finance/` | A8: `run.ts` (CLI), `cases.ts` (load + validate), `setups.ts` (the four setups), `world.ts` (real server per setup, driven over HTTP), `leak.ts` (leak + missing-context checks, subtle-leak judge), `results.ts` (summary, pitch chart, file gating) |
| `src/tasks.ts` | load + validate v1 task files; every error names file and field. `src/validate-tasks.ts` is Edan's CLI for both formats |
| `src/baselines/` | `Baseline` interface and the three scaffold strategies. `canon.ts` also holds `waitForDistill` (SSE) |
| `src/mcp.ts` | MCP Streamable HTTP over fetch: initialize → initialized → `tools/call`, JSON or SSE body |
| `src/responder.ts` | `ClaudeResponder` (real) and `EchoResponder` (stub); the finance setups pass their own system prompt |
| `src/score.ts`, `src/results.ts` | pure scoring; summary, chart data, the refusal to write quotable files |

## Stub vs real

| Piece | Real | Stub | Labelled how |
|---|---|---|---|
| Responder | `ClaudeResponder`, `ANTHROPIC_API_KEY` set | `EchoResponder` (`--dry` or no key) | banner, `simulated: true`, null figures |
| Canon slice | server with Jev/Claude judge + Droid/Claude distiller | server on fake judge / heuristic distiller | `prepare.simulated`, baseline + run `simulated` |
| Token counts | `usage.input_tokens` from the model | `estimateTokens` | field name ends in `_est`; chart says `tokens_source` |
| Cost | `usage × BENCH_PRICE_PER_MTOK_*` | none | `null` |

## Sponsor work and tests

- **Anthropic:** `src/responder.ts` is the answering model (raw Messages API, no SDK dependency
  here). The judge and distiller it measures live in `shared/` and `distiller/`.
- **Microsoft (Built for the Real World):** the pitch chart is `results/finance-chart.json` —
  leak rate against missing-context rate, one point per setup (A8). It is written only from a
  measured run. The scaffold's `results/chart.json` (accuracy vs tokens) remains for the dashboard.

`npm run typecheck -w bench && npm test -w bench`: offline, ~2 s, fake Canon server on port 0,
injected fetch, tmp dirs.
