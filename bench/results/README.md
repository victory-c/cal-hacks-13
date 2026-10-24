# bench/results

Written by `npm run run -w bench` (scaffold) and `npm run finance -w bench` (A8). **Every number
Devpost, the pitch or the dashboard quotes comes from here** (CLAUDE.md: never invent numbers).
If a file says `"simulated": true`, it is not quotable.

| File | What | Committed? |
|---|---|---|
| `finance-<timestamp>.json` | One A8 finance run, full detail: every case × setup cell (facts served, leak verdict and which check caught it, missing fact ids, score, tokens, latency, errors) and the summary. | Yes, keep the runs that back a quoted figure |
| `finance-latest.json` | The summary of the most recent **measured** finance run (or `--allow-simulated`, labelled). Per setup: leak rate with a per-style breakdown, missing-context rate, accuracy, tokens handed over, time to first reply, cost per handoff, scope build times, and the not-yet-measured save-time metric (`null` + note, never a guess). | Yes |
| `finance-chart.json` | **The pitch chart** (PRD "Chart for the pitch"): `{ generated_at, simulated, series: [{ setup, leak_rate, missing_context_rate }] }`, one point per setup. | Yes |
| `raw/finance-<timestamp>/<case>.<setup>.md` | System prompt, full context injected and full answer per finance cell. Large, for debugging. | No (`.gitignore`) |
| `<timestamp>.json` | One scaffold run, full detail: the CLI args, every task × baseline cell (context preview, estimated tokens, real `usage` tokens, latency, answer, score, errors) and the summary. Timestamp is UTC with `:` replaced by `-`. | Yes, keep the runs that back a quoted figure |
| `latest.json` | The summary of the most recent **measured** scaffold run (or a simulated one written with `--allow-simulated`, labelled). Per baseline: `accuracy`, `mean_tokens_injected_est`, `mean_input_tokens`, `mean_output_tokens`, `mean_prepare_latency_ms`, `mean_respond_ms`, `cost_usd`, `simulated`. | Yes |
| `chart.json` | `{ generated_at, simulated, series: [{ baseline, accuracy, tokens, tokens_source }] }`: accuracy vs tokens, one point per baseline. The dashboard (`web/`) renders this. Scaffold chart only; the pitch quotes `finance-chart.json`. | Yes |
| `raw/<timestamp>/<task>.<baseline>.md` | The full context injected and the full answer for each scaffold cell. | No (`.gitignore`) |

## Reading the numbers

- `accuracy` is over scored cells (cells without an error). `errors` is reported next to it; a
  server that was down during the canon baseline shows up there, not as 0% accuracy.
- `*_est` fields are `estimateTokens()` (~4 chars/token). `mean_input_tokens` / `mean_output_tokens`
  are the model's own `usage` and are the figures to quote.
- `cost_usd` is `usage × BENCH_PRICE_PER_MTOK_IN/OUT` from `.env`, and `null` when either is unset
  or any scored cell lacks usage. We never guess a price.
- A dry run (`--dry`) or a run without `ANTHROPIC_API_KEY` uses an echo responder: `accuracy`,
  `mean_input_tokens`, `mean_respond_ms` and `cost_usd` are `null`, the run is `simulated`, and
  `latest.json` / `chart.json` are not touched unless `--allow-simulated` is passed.
- The canon baseline is also `simulated` when the server reports a fake judge or a heuristic
  distiller: the slice was not chosen by the real pipeline.
- Finance runs: `leak_rate` is over **evaluated** attacks — a cell whose only remaining check was
  a simulated answer counts as `null`, never as a pass — and `missing_context_rate` is over tasks
  that produced a context. The Bullwark setups are `simulated` whenever the fake judge or the
  keyword retriever stood in for Jev/Claude or Moss; the leak **code checks** still measure the
  real enforcement path, but the labels stay until real providers run.
