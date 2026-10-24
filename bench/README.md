# `bench/` — the only source of quotable numbers

**Owner:** lane A · Henry Lai runs it. Lane C · Edan Wong writes the tasks in [`tasks/`](tasks/)
(see [`tasks/README.md`](tasks/README.md)). Skeleton built by lane B.

Every token, latency, cost and accuracy figure on Devpost, in the pitch and on the dashboard
comes from a run of this package (CLAUDE.md: *never invent numbers*, *only compare against
baselines we run*). The runner refuses to write quotable files from a simulated run.

## Finance evaluation target

C6 supplies 50 attacks (10 per PRD style) and 30 legitimate tasks in the synthetic Harbor Lane
world. A8 extends the evaluator to four setups: no memory, shared memory, Canon + Claude filter
and Canon + Jev. Measure leak rate, wrongly blocked rate, task accuracy, tokens, latency and cost;
also record save-time cost per 100 captured items. These are planned extensions, not capabilities
of the existing three-strategy runner. Only measured runs support pitch claims.

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
| `tasks/t01-….json` | Edan's tasks. `task.schema.json` for editors, `t00-example.json` a full example (runs only with `--include-example`) |
| `results/<timestamp>.json` | One run, full detail. `results/latest.json` + `chart.json`: what Devpost and the dashboard quote. `results/raw/`: full contexts and answers, gitignored. See [`results/README.md`](results/README.md) |
| `src/run.ts` | CLI: tasks × baselines → prepare → respond → score → write |
| `src/tasks.ts` | load + validate task files; every error names file and field. `src/validate-tasks.ts` is Edan's CLI |
| `src/baselines/` | `Baseline` interface and the three strategies. `canon.ts` also holds `waitForDistill` (SSE) |
| `src/mcp.ts` | MCP Streamable HTTP over fetch: initialize → initialized → `tools/call`, JSON or SSE body |
| `src/responder.ts` | `ClaudeResponder` (real) and `EchoResponder` (stub) |
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
- **Microsoft (Built for the Real World):** the pitch chart is leak rate against wrongly blocked
  rate (PRD), which needs the A8 finance evaluator. Today's `results/chart.json` is the scaffold's
  accuracy-vs-tokens chart; `results/latest.json` feeds the scale slide.

`npm run typecheck -w bench && npm test -w bench`: offline, ~2 s, fake Canon server on port 0,
injected fetch, tmp dirs.
