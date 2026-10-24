# bench/results

Written by `npm run run -w bench`. **Every number Devpost, the pitch or the dashboard quotes comes
from here** (CLAUDE.md: never invent numbers). If a file says `"simulated": true`, it is not quotable.

| File | What | Committed? |
|---|---|---|
| `<timestamp>.json` | One run, full detail: the CLI args, every task × baseline cell (context preview, estimated tokens, real `usage` tokens, latency, answer, score, errors) and the summary. Timestamp is UTC with `:` replaced by `-`. | Yes, keep the runs that back a quoted figure |
| `latest.json` | The summary of the most recent **measured** run (or a simulated one written with `--allow-simulated`, labelled). Per baseline: `accuracy`, `mean_tokens_injected_est`, `mean_input_tokens`, `mean_output_tokens`, `mean_prepare_latency_ms`, `mean_respond_ms`, `cost_usd`, `simulated`. This is what the Devpost text and the scale slide quote. | Yes |
| `chart.json` | `{ generated_at, simulated, series: [{ baseline, accuracy, tokens, tokens_source }] }`: accuracy vs tokens, one point per baseline. The dashboard (`web/`) renders this. `tokens` is the model's real `usage.input_tokens` when known, else the `est.` figure, and `tokens_source` says which. Scaffold chart only: the PRD's pitch chart (leak rate against wrongly blocked rate) arrives with the A8 finance evaluator. | Yes |
| `raw/<timestamp>/<task>.<baseline>.md` | The full context injected and the full answer for each cell. Large, for debugging. | No (`.gitignore`) |

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
