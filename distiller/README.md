# `@canon/distiller` — captured session in, decided facts out

**Owner:** lane B, Victor Chun. A worker process on the server's event stream. It never imports
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
| `fixtures/session.sample.json` | A Claude Code session: ships the capture hook, decides folders, targets backend internships. |

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

| Engine | Real? | Needs | Where it plugs in |
|---|---|---|---|
| `droid` | **Pending blocker Q1.** Constructs; `distill()` throws `NotConfiguredError` until the SDK is wired (task B2). | `FACTORY_API_KEY` | `src/engines/droid.ts` |
| `claude` | Yes. `claude-sonnet-5-5`, one strict `emit_facts` tool, raw Messages API over `fetch` (no SDK dependency). | `ANTHROPIC_API_KEY` | `src/engines/claude.ts` |
| `heuristic` | **No, simulated.** Keyword sentences (built/shipped/decided/…), folder guessed by keywords, max 8. | nothing | `src/engines/heuristic.ts` |

**Factory Droid track (design, SDK wiring pending Q1).** Droid is the distiller, not a chatbot:
it runs headless on *our* trigger (every captured session), gets the session + the fact-file
format + the folder list, and may only write the fact store, through our `POST /api/facts`.
Jev still answers the save-time questions on every draft, so Droid cannot bypass them. It returns
a plan and drafts; the plan and the fact diffs go on the dashboard as the proof of work. The
intended contract is written out at the top of `src/engines/droid.ts`.

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
- How the engine's plan reaches the dashboard: `distill.finished` is a server-emitted event and
  `PostFactsBody` has no `plan`/`engine`/`duration_ms`. Proposal for A↔B: add them as optional
  fields on `PostFactsBody` so the server can emit the event. Until then the plan is in the logs.
