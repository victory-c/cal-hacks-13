# `@canon/web` — dashboard and control room frontend

**Owner:** lane C, Edan Wong. The current app is HTML and TypeScript bundled by esbuild and
served by `scripts/serve.mjs`. This README documents its working event panels and counters.
The target control room adds deals, clearances, pending requests, Droid agent lanes and a
handoff inspector. Those are implementation tasks C13 and C14; the demo opens on a neutral
refusal and its compliance record. Optional views are the wall map and attack box.

Build against the agreed mock REST and SSE contract, then connect to Henry's server. The
frontend never imports server code. Framework choice is optional within `web/`.

## Run

```bash
npm run dev -w web      # build, watch src/, serve → http://localhost:4200
npm run build -w web    # one-shot build into dist/
npm start -w web        # serve an existing dist/ (fails with a clear message when it is missing)
npm test -w web         # node:test, offline, ~0.3 s
npm run typecheck -w web
```

Port: `WEB_PORT` in `.env` (default 4200). The page talks to the Bullwark server at
`?server=<url>` (remembered in localStorage), else the remembered one, else
`DEFAULT_SERVER_URL` from `@canon/shared`. Those server routes are open (no token, CORS `*`),
so the dashboard needs no credentials.

## What feeds each panel

| Panel | Source | Keyed by |
|---|---|---|
| Counter hero | last `context.served` | newest `at` |
| Live sessions | `session.captured` | session id (re-posts update in place) |
| Facts | `GET /api/facts` on load, then `fact.saved`; `fact.retired` → strike-through | fact id |
| Distiller | `distill.started` / `distill.finished` (engine, Droid's plan, measured duration) | session id |
| Access | `access.denied`, in red: the private-folder refusal for the demo | `at`+client+tool+folder |
| Grants | `GET /api/grants` | — |
| Header meta | `GET /health` (facts, sessions, judge, retriever) | — |

The server replays the last 100 events to every new subscriber, so every row is keyed and a
replay lands on the row it already has (`src/state.ts`, tested). The REST snapshot is re-fetched
on every reconnect. The dot in the header is `connecting` / `live` / `reconnecting` / `closed`;
the browser's EventSource retries on its own and `main.ts` reopens it when the browser gives up.

## Labels, and why (never invent numbers)

- **est. tokens** — `context.served.tokens` is `estimateTokens()` (~4 chars/token), so it is
  always shown as an estimate. Latency and distill duration are measured by the server/distiller.
- **simulated** — on a fact when `decision.judge === "fake"` (no Jev/Anthropic key), on a distill
  when the engine is `heuristic`, and in the header meta (`judge fake (simulated)`,
  `retriever keyword (stub)`). Nothing on the page pretends a stub is the real thing.
- **cost** — only when a rate is set: `?rate=<USD per 1M tokens>` (remembered; `?rate=0`
  clears). Otherwise "—" with a "set a rate" tooltip. No built-in price.
- **vs full history** — filled from the page's own origin, `GET /bench/latest.json`, which
  `scripts/serve.mjs` maps to `<repo>/bench/results/latest.json` (lane A's `npm run run -w bench`
  writes it; the Bullwark server has no bench route and owes none). 404 → "— (run bench)". The
  reader (`src/bench.ts`) understands bench's `Summary` (`baselines[]` with `mean_input_tokens`,
  falling back to `mean_tokens_injected_est`) and `Chart` (`series[]`); anything else →
  "— (bench format?)". A file with `simulated: true` renders "… (simulated)". No hard-coded ratio.

## Files

| File | What | Tested |
|---|---|---|
| `src/state.ts` | `State`, `reduce(state, event)` for every `CanonEventType`, `initFromFacts` | yes |
| `src/format.ts` | `fmtMs` `fmtTokens` `pct` `fmtCost` `relativeTime` `clientLabel` `folderTop` | yes |
| `src/config.ts` | server URL + rate from query/localStorage | yes |
| `src/bench.ts` | reader for bench's `latest.json` / `chart.json`, fetched same-origin from `/bench/` | yes |
| `src/dom.ts`, `src/render.ts`, `src/main.ts` | `h()`, keyed list sync, panels, EventSource wiring | browser only |
| `scripts/build.mjs` | esbuild bundle (esm, es2022, sourcemaps), copies HTML/CSS, `--watch`, `--serve` | — |
| `scripts/serve.mjs` | static `dist/` server, `no-store`, reads `.env` via `loadEnv()`; `/bench/<name>.json` → `bench/results/` (top-level JSON only, never `raw/`) | — |

`build.mjs` has one plugin: `@canon/shared`'s index also exports Node-only helpers
(`env.ts`, `ids.ts`), so `node:*` imports are replaced by no-op stubs in the browser bundle.
The dashboard never calls them; esbuild tree-shakes the rest.

## Sponsor integrations

None run here. The dashboard is where they become visible: the Distiller panel shows Factory
Droid's plan and engine on every run, the counter shows Moss retrieval latency
(`retrieval_ms`) and Jev's filter (`candidates → kept`, `judge_ms`), and the header says which
judge/retriever is real and which is a stub.
