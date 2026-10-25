# `@canon/web` — dashboard, moderator console and member view

**Owner:** lane C, Edan Wong. The current app is HTML and TypeScript bundled by esbuild and
served by `scripts/serve.mjs`. This README documents its working event panels and counters.
The target is two views: the moderator console (people and tiers, scope builder, scope
inspector, live feed, agent lanes, handoff inspector) and the member view (my agents, create an
agent, my memory). Those are tasks C13 and C14; the demo opens on a question that doesn't leak and
the scope inspector showing why. Optional views are the scope map and attack box.

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

## Member view (`member.html`)

`http://localhost:4200/member.html` is the employee's page (task C19, with the member side of C18):
agents on top, then memory and the feed. It runs on **demo data by default**: an in-browser
stand-in for Canon (`src/member/mock.ts`) holding Ben Kim's view of the synthetic world. Add
`?data=canon&token=<member token>` (and `?server=` as above) to talk to Canon instead; the token
is remembered and removed from the address bar.

| Area | What works |
|---|---|
| Agents | Create, edit, delete; Run and Stop; a live status line (current step, or last result plus new memories waiting); the output card with each document openable; schedule; document types to make |
| Memory | Grouped list with a type tag, source line and date per memory; collapsible filters (keyword, group, source, sort by date); edit and retire; add an item |
| Feed | The member's own events: items added, new memories, agent starts, finishes and pickups, plus the member's own edits |

What the mock simulates, and says so on the page: triage (sentence splitting and a keyword group
guess), relevance (keyword overlap in place of Moss and Jev), agent runs (timed steps) and the
documents (built line by line from the agent's own facts). A pasted item containing an instruction
aimed at an AI produces no facts and no member-visible event, as quarantine should.

`src/member/fixture.ts` is a copy of only what Ben's scope holds, not an import of
`fixtures/world/expected.json`: importing the answer key would ship the Stonewall facts inside
the member bundle. `fixture.test.ts` checks the copy against `fixtures/world` and fails if any
deal or desk fact, code name or leak marker gets into it.

| File | What | Tested |
|---|---|---|
| `src/member/contract.ts` | Member-side contract types and the `MemberApi` interface | — |
| `src/member/logic.ts` | Filtering, grouping, labels, status and feed lines | yes |
| `src/member/mock.ts` | The in-browser Canon stand-in | yes |
| `src/member/canon.ts` | HTTP + SSE client for Canon | browser only |
| `src/member/fixture.ts` | Ben's view of the demo world | yes, against `fixtures/world` |
| `src/member.ts`, `member.html`, `member.css` | The page | browser only |

**Contract additions the member view needs** (proposals for Henry and Victor; the client
already calls them):

- `AgentRun` gains `task`, `leave_out`, `docs`, `schedule`, `outputs` (document content, not just
  file names), `finished_at`, `fact_count` and `pending`; statuses gain `building`, `ready` and
  `stopped`.
- `POST /api/agents` and agent edits carry `docs` and `schedule`; new `PATCH /api/agents/:id`,
  `DELETE /api/agents/:id` and `POST /api/agents/:id/stop`.
- `Fact` gains `source_kind` and `source_title` for the provenance line; `GET /api/me` gains
  `firm`; new `GET /api/groups` for display names (until then group ids are shown humanized).
- `agent.*` events carry the whole `AgentRun`.
- **Open:** how `/events` authenticates. `EventSource` cannot send an `Authorization` header, so
  the client passes the token as `?token=` for now.

The page never shows the member's own task or exclusions set by a moderator, and nothing on it
names or counts anything outside the member's memory.

## Moderator console (`moderator.html`)

`http://localhost:4200/moderator.html` is Wags's console (tasks C13 and C14, plus the moderator
side of C18). Same look and data pattern as the member view: demo data by default
(`src/moderator/mock.ts`, the whole synthetic world at the start of the demo), or
`?data=canon&token=<moderator token>` for Canon.

| Area | What works |
|---|---|
| Counter | Tokens handed over (est.), handoff count; latency and cost "—" until measured or a rate is set |
| People & scopes | People with their agents; add person; promote or demote; the selected scope as group chips and facts; **Edit rule** (task + group cards, selected = in scope) with the four build stages streaming live |
| Agents | Every agent by creator: Run, Stop, live status, output documents and file names, jump to its scope |
| Memory | All facts with type tags, sources, dates and group colours; filters; **Select** to file single facts or whole groups at once; edit, file, retire; **Add item** with a "From" picker (and the three 0:25 demo items in demo mode); **Held for review** with Release; the **Inbox** stacked on top with per-fact filing |
| New groups | One form, opened from "+ New group…" in any File-to picker or the "+ New group" card in the rule editor; the new group is picked where it was opened and reaches no one until added to a rule |
| Feed | Every event, quarantines highlighted |
| Handoffs, Audit | Each handoff's candidates with relevance, kept or cut and why, tokens; audit filtered by person or group |

Scopes behave as the Canon PRD says: a new or refiled fact joins every scope its rule fits; a
fact leaves only when its group is excluded, it is retired, or the creator's scope loses it; only a
rule edit rebuilds a scope. When an agent's scope narrows, a running agent restarts and documents
built from the old scope are withdrawn (the deal-dies backup). `mock.test.ts` walks the demo
script: the 0:00 handoff, the 0:25 quarantine and live items, the 0:40 build, the 1:20 refile, deal
dies, the inbox and new groups.

The moderator bundle contains the whole world, deal facts included; it is a separate entry point
so none of it reaches `member.js`.

| File | What | Tested |
|---|---|---|
| `src/moderator/contract.ts` | Moderator contract types and the `ModeratorApi` interface | — |
| `src/moderator/logic.ts` | Group colours, rule conversions, people order, build-stage and feed lines, audit filter | yes |
| `src/moderator/mock.ts` | The in-browser Canon stand-in, built from `fixtures/world` | yes |
| `src/moderator/canon.ts` | HTTP + SSE client for Canon | browser only |
| `src/moderator.ts`, `moderator.html`, `moderator.css` | The page (`moderator.css` extends `member.css`) | browser only |

**More contract additions the console needs** (beyond the member list above): `GET/POST
/api/groups`; a bulk form of `POST /api/facts/:id/file` (the client loops for now);
`groups_removed` on the `exclusions` stage of `scope.build`; `fact.filed` carrying `from`;
`group.created` and `item.released` events; and a defined response for `GET /api/audit`
(`{ entries: [{ at, principal, group, text }] }` here). The inbox starts with the two facts from
`fixtures/world/items/itm_voicemail.json`.

## Sponsor integrations

None run here. The dashboard is where they become visible: the Distiller panel shows Factory
Droid's plan and engine on every run, the counter shows Moss retrieval latency
(`retrieval_ms`) and Jev's filter (`candidates → kept`, `judge_ms`), and the header says which
judge/retriever is real and which is a stub.
