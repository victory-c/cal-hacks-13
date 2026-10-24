# `@canon/server` — MCP + REST + SSE, fact store, cold archive, grants, retrieval

**Owner:** lane A, Henry Lai. This README describes the implemented file-backed server and
its local fallbacks. The finance permission pipeline, expiring deal entitlements, lists,
wall-crossing API and audit records are tracked in `../docs/PRD.md` and `../STATUS.md`.
Existing folder grants are not deal clearances; do not claim finance barriers from this scaffold.

## Run, seed, test

```bash
npm run dev -w server         # tsx watch, http://127.0.0.1:4100 (CANON_PORT)
npm run seed -w server        # optional: copy fixtures/ into the data dir (CANON_DATA_DIR, default data/), skip existing
npm run typecheck -w server && npm test -w server    # ~0.5 s, offline, boots its own server on port 0
```

Reads `.env` via `loadEnv()` (see `.env.example`). With no `CANON_CLIENT_TOKENS` the dev tokens from
`.env.example` are used, with a warning. Binds to 127.0.0.1 only. **A store with no facts is seeded
from `fixtures/` at start-up** (`src/index.ts`), so a fresh clone demos without a separate seed step;
`npm run seed` is for re-seeding a store you emptied by hand. The store is scanned once at boot: a
file you add in Obsidian while the server runs shows up after a restart. Start-up failures (port in
use, bad `JUDGE_PROVIDER`, broken `CANON_GRANTS_FILE`) are one `[server] ...` line, not a stack trace.

## Endpoints

| Method + path | Auth | Does |
|---|---|---|
| `GET /health` | – | `HealthResponse`: counts, uptime, judge and retriever names |
| `GET /events` | optional | SSE of `CanonEvent`: replays the last 100, then live; heartbeat comment every 15 s. **Without a token, `fact.saved` events for `private/` facts are dropped**; with one, the stream is complete |
| `GET /api/facts?folder=&tier=` | optional | Facts (folder is prefix-per-segment, like grants). **Without a token: every folder but `private/`** (the dashboard). With one: the client's read grant |
| `GET /api/grants` | – | The grants table |
| `POST /api/sessions` | bearer | Upsert a `CapturedSession` into the cold archive. `body.client` must match the token (403) |
| `GET /api/sessions/:id` | bearer | One archived session. **Only the client that captured it and the internal `distiller` may read it** (403 otherwise): raw transcripts have no folder scoping |
| `POST /api/facts` | bearer | Distiller files decided facts (`PostFactsBody`). Needs write grant on the folder (403 + `access.denied`). Each `decision` is validated (action, `supersedes` id, tier/folder equal to the fact's, probabilities in [0, 1], judge name) and rebuilt before it is broadcast. `supersede`/`merge` re-writes the old fact as `cold` (never deletes) and emits `fact.retired` |
| `POST\|GET\|DELETE /mcp` | bearer | MCP Streamable HTTP, stateless: fresh `McpServer` per request, scoped to the token's grant |
| `GET /api/groups` | moderator, internal | `GroupsResponse` (triage reads it to file facts) |
| `GET\|POST /api/principals`, `POST /api/principals/:id/tier` | moderator | People, tiers and agents. Adding a member takes a `rule` and builds their scope (exclusions applied in code) |
| `GET\|PUT /api/scope-rules/:principal` | moderator; the creator for their own agents | A member never reads their own rule (the exclusions are never shown). `PUT` rebuilds the scope through the full pipeline and cascades to the member's agents |
| `GET /api/scopes/:principal`, `GET /api/scopes/:principal/facts` | moderator, internal | The fixed fact-id list, and the facts themselves (an agent's sandbox) |
| `POST /api/agents`, `DELETE /api/agents/:id` | any person for themselves; delete also moderator | The agent's scope is built from its creator's scope only and checked in code to be a subset |
| `GET\|POST /api/quarantine`, `POST /api/quarantine/:id/release` | GET + release moderator; POST internal | Held captures; release is 409 when already released |
| `GET /api/audit?principal=&since=` | moderator | `AuditResponse` |
| `POST /api/handoff` | internal | `HandoffBody` → `HandoffResult`: candidates only ever come from inside the fixed scope, budget cut, pinned profile (never the exclusions), audit row + `handoff.served`. **Stub relevance: keyword overlap, not Moss + Jev** |
| `POST /api/dispatch` | the agent's creator or a moderator | `DispatchRequest` → `{ id }`, emits `dispatch.requested`; `by` must be the caller |
| `POST /api/events` | internal | Re-broadcast one `RELAYED_EVENTS` event on `/events` (the server stamps `at`) |

**Scopes tier enforcement (A2, `src/scopes.ts`).** The caller's principal is its grant's `principal`
or the client id itself (`maya=dev-maya` → `maya`). Moderator routes answer every non-moderator with
one constant `403 { "error": "moderators only" }` **before anything is looked up**, so the same bytes
come back whether the target exists or not — no refusals that reveal, no existence signals. World
state (people, rules, scopes, quarantine, audit) loads from `../distiller/fixtures/world/` into
memory per server; facts come from the regular store.

**Scope builder and living scopes (A4+A6, `src/scopes.ts` + `src/scope-judge.ts`).** A build is:
excluded groups (prefix) and labels removed **in code** → one retriever query for the task, result
re-filtered against the post-exclusion pool in code → one batched `judge.ask()` per Jev decision
(group-under-exclusion, then per candidate fact-under-exclusion + helps-with-task), thresholds from
`TRIAGE_THRESHOLDS` applied in code, a "maybe" on an exclusion counts as excluded → a fixed list of
fact ids. Every stage is a `scope.stage` event with its **measured** time; every build writes a
`scope.built` audit row. A member's own facts join unless an exclusion removes them; an agent's base
is its creator's scope only and the subset is re-checked right before the write (violation = loud
500). On `fact.saved`, the fact joins each scope that clears the same checks (inbox facts join
none); on `fact.retired` it leaves every scope — both audited (`fact.joined_scope` /
`fact.left_scope`). Without credentials the keyword retriever stands in for Moss and the fake judge
answers the scope questions from keyword overlap (`simulatedScopeAnswers`); both are labelled
simulated in the audit detail. **Benchmark numbers still require the real providers before any
measured barrier-performance claim.**

Auth is `Authorization: Bearer <token>`; tokens map to clients via `CANON_CLIENT_TOKENS`. A missing or
unknown token is `401 { error }` (on the two "optional" routes a *missing* token gives the public view
and an *unknown* one is still a 401). All errors are `{ error }` JSON. One log line per request:
`METHOD path status ms`. A request target Node accepts but the URL parser rejects (`GET http://x:99999/`)
is a 400. CORS is `*` (localhost-only server; the dashboard on :4200 has no token and therefore never
sees `private/`).

**MCP tools** (`src/mcp.ts`): `canon_context`, `canon_search`, `canon_save`, `canon_whoami`, input shapes
as in `shared/src/types/mcp.ts`. Every result has `content[0].text = JSON.stringify(output)` and
`structuredContent = output`. A folder outside the grant is an `isError` result:
`refused: <client> cannot read <folder>. Call canon_whoami to see your folders.`

## Data layout (`CANON_DATA_DIR`, gitignored, opens in Obsidian)

```
facts/<folder>/<id>.md     one fact per markdown file (shared serializeFactFile / parseFactFile)
sessions/<id>.json         raw CapturedSession, the cold archive
```

Writes are tmp + rename. `FileStore.loadAll()` skips unparsable files with a warning. Only `hot`
facts are indexed for retrieval; the index refreshes on every `fact.saved` / `fact.retired`.

## Where each server area lives

Task ids refer to the current board in `../STATUS.md`. Some areas were built before the finance
task list was written, so an area can run today while its finance task is still open.

| Area (task) | File | Now | Next |
|---|---|---|---|
| MCP server | `src/mcp.ts`, `src/router.ts` | Real: four tools over the SDK's stateless Streamable HTTP | — |
| Cold archive (A3) | `src/store.ts` | Real: JSON per session, atomic writes | Pull-from-cold when `enough` is false |
| Moss search (A4) | `src/retrieval/moss.ts` | **Stub.** Constructor throws without `MOSS_PROJECT_ID`/`MOSS_PROJECT_KEY`; methods throw "not implemented". `KeywordRetriever` (`retrieval/keyword.ts`) stands in and is labelled a stub | Implement `index`/`search`; `createRetriever()` already picks Moss when the env is set |
| SSE (A5) | `src/events.ts` | Real: ring buffer, replay, heartbeat, ids | Extend the agreed finance events; keep plain SSE |
| Grants → deal entitlements (A6) | `src/auth.ts` | Real: bearer → client → `Grant` (`DEMO_GRANTS` or `CANON_GRANTS_FILE`) | Deal entitlements and permission filter (A6) |
| Jev filter (part of A7) | `src/mcp.ts` → `runContext` | Real flow: retrieve k=20 → **one** `judge.ask()` (a noul per candidate + "enough?") → keep p > 0.7 → `cutToBudget`. Judge comes from `createJudge()`: `fake` (simulated) without keys. A judge failure (timeout, 5xx) is not an MCP error: no fact is served, `enough` is false and `missing` carries the reason | Nothing here changes when Jev's real API lands; fix `shared/src/judge/jev.ts` |

`canon_save` never writes a hot fact: it archives a one-message session and emits `session.captured`
for the distiller. `src/seed.ts` copies `fixtures/` (sample data, see `fixtures/README.md`).

## Stub vs real, in one list

- **Simulated:** the `fake` judge (no keys; for scope builds it answers from keyword overlap, see
  `src/scope-judge.ts`), the `keyword` retriever (no Moss creds). Both are named in `GET /health`,
  in the start-up log and in the `scope.built` audit detail so the dashboard can label them.
- **Stub:** handoff relevance (`POST /api/handoff`) is keyword overlap inside the fixed scope, not
  Moss + Jev yet (task A7).
- **Real:** everything else above. Latency numbers in `context.served` (`latency_ms`, `retrieval_ms`,
  `judge_ms`) are wall-clock measurements; `tokens` is `estimateTokens()` and must be shown as "est.".

## Tests (`src/**/*.test.ts`)

Store round-trip, auth, event ring buffer, keyword scoping, `canon_context` budget cut with a
`FakeJudge` override, seed + fixtures, and `app.test.ts`: real HTTP on port 0 covering every route plus
the MCP endpoint through the SDK `Client`.
