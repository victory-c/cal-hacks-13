# `@canon/distiller` — captured session in, decided facts out

**Owner:** lane B, Victor Chun. This README describes the implemented worker. Triage and
grouping, Claude fact writing and Droid agent runs are tracked in `../docs/WORK_SPLIT.md`.

A worker process on the server's event stream. It never imports
server code: everything goes over HTTP as the `distiller` client (`CANON_TOKEN_DISTILLER`).

```
SSE  session.captured ─▶ GET /api/sessions/:id ─▶ engine.distill() ─▶ decideFacts() (one Jev request) ─▶ POST /api/facts
                         (cold archive)             DraftFact[] + plan      tier · folder · dedupe          hot/cold store
```

Distills when `session.ended` is true, or on every capture with `DISTILL_LIVE=1` (debounced 3 s
per session). Idempotent on `<session id>:<message count>`, and a `session.captured` stamped more
than 5 s before the worker started is the server's SSE replay and is skipped (logged `replayed,
skipping`), so a `tsx watch` restart does not re-distill the last 100 events. One bad session is
logged and skipped; the loop never dies.

| File | What |
|---|---|
| `src/index.ts` | Entrypoint: `loadEnv()`, picks engine + judge, subscribes to `/events`, clean SIGINT. |
| `src/worker.ts` | `createHandler({ client, distiller, judge, live })`: the flow above, testable with fakes. |
| `src/client.ts` | Typed fetch client: `getSession`, `listFacts`, `postFacts`. Bearer auth, 10 s timeout, errors say status + body. |
| `src/engines/` | `Distiller` interface, `createDistiller()`, the three engines (below). |
| `src/decide.ts` | Save-time Jev decisions, thresholds applied by us. Pure given a `Judge`. |
| `src/cli.ts` | Run the pipeline on a recorded session; `--post` sends the result to the server. |
| `fixtures/session.sample.json` | Existing compatibility transcript for exercising the pipeline; not the finance demo world. |

## Run and test

```bash
npm run dev -w distiller                 # the worker; needs the server on CANON_URL (npm run dev at the root runs both)
npm run distill -w distiller -- distiller/fixtures/session.sample.json            # no server needed
npm run distill -w distiller -- distiller/fixtures/session.sample.json --engine claude --post
npm run typecheck -w distiller && npm test -w distiller                            # ~0.5 s, offline, no keys
```

The CLI prints the plan, the drafts and Jev's decisions as a table and as JSON. Tokens and ms
in its output are real measurements (`usage` from the API, wall clock); nothing is estimated.

## Engines and the fallback order

`DISTILLER` wins; unset, it is `droid` when `FACTORY_API_KEY` is set, else `claude` when
`ANTHROPIC_API_KEY` is set, else `heuristic`. The console says which, and says **simulated**
when it is. The worker never switches engine on its own: a failing engine is a logged error, not
a silent downgrade.

For the finance product's Claude fact-writer path, set `DISTILLER=claude` explicitly.
`droid` is now an implemented optional scaffold extractor, not the B2/B18 scoped-agent runner.
The engine does not silently fall back after a provider failure.

| Engine | Real? | Needs | Where it plugs in |
|---|---|---|---|
| `droid` | Official SDK + pinned CLI; headless structured fact extraction. | `FACTORY_API_KEY` | `src/engines/droid.ts` |
| `claude` | Yes. `claude-sonnet-5-5`, one strict `emit_facts` tool, raw Messages API over `fetch` (no SDK dependency). | `ANTHROPIC_API_KEY` | `src/engines/claude.ts` |
| `heuristic` | **No, simulated.** Keyword sentences (built/shipped/decided/…), folder guessed by keywords, max 8. | nothing | `src/engines/heuristic.ts` |

**Factory integration:** the official SDK opens an isolated temporary directory, rejects permission
requests, disables discovered tools and built-in skills, and returns a plan and up to 12 structured
fact proposals. It closes the session and removes the directory on failure or success. Source
attribution comes from the captured session; Jev judges the proposals before the worker writes.
Successful writes report the actual extraction engine and timing over SSE. Free-form plans are
limited to the internal worker stream because they summarize raw transcripts; plans for batches
containing private facts are omitted entirely. `npm ci` installs the pinned CLI; its executable must be
complete and runnable. `FACTORY_MODEL` optionally overrides the account default.

This does not implement the finance-agent runner, scoped sandboxes with files and steps, or live
inboxes and restarts (B2 and B18). Those features stay on their existing work branches.

**Anthropic track.** `claude-sonnet-5-5` follows the claude-api skill: forced `tool_choice` is a
400 on this model, so the request uses `auto` + `strict: true` + a system prompt that says to call
`emit_facts` once, and fails clearly when no call came back; adaptive thinking (default) at
`effort: medium`; `max_tokens` 4096 because thinking counts against it; `fallbacks: "default"`
(beta `server-side-fallback-2026-07-01`) so a safeguard false positive is retried server-side.

## Jev decisions (`src/decide.ts`)

One `judge.ask()` per batch (CLAUDE.md rule): the state is the numbered drafts plus up to 40
existing hot facts (id + statement); per draft the questions are `keep:i` (noul), `folder:i`
(choice over `TOP_FOLDERS` + the suggested subfolder), `dupe:i` (new | duplicate | supersedes)
and `which:i` (existing ids + none). Thresholds from `THRESHOLDS`: `keep_p > 0.6` → hot else
cold; `folder_p < 0.5` → inbox; duplicate → `merge`, supersedes → `supersede` (both set
`supersedes` on the fact, so the server retires the old one, never deletes); `which = none` → add.
A draft that repeats an existing hot fact word for word (ignoring case, spacing and punctuation)
is a `merge` into that fact whatever the judge answered, checked against the whole hot store, not
only the 40 in the state. Missing answers mean cold + inbox, never a crash. Judge provider is `JUDGE_PROVIDER` (see
`shared/README.md`); with no keys it is the fake judge, labelled simulated.

## Env (all from `.env`, see `.env.example`)

`CANON_URL` · `CANON_TOKEN_DISTILLER` (dev default `dev-distiller`) · `DISTILLER` · `FACTORY_API_KEY`
· `ANTHROPIC_API_KEY` · `DISTILL_LIVE` · `JUDGE_PROVIDER` / `JEV_API_KEY` / `JEV_API_URL`.

## Open

- Replay skipping is time-based (events older than the worker). Proposal for A↔B: the server's
  `EventBus` honours `Last-Event-ID` (replay only ring ids above it) and `subscribeEvents` sends
  the last id it saw on reconnect; then the worker can drop the 5 s heuristic.
- `PostFactsBody.distillation` now attributes extraction completion. The dashboard gets engine,
  fact count and duration; exposing raw plans requires a future privileged console view.
