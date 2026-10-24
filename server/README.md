# `@canon/server` — MCP + REST + SSE, fact store, cold archive, grants, retrieval

**Owner:** lane A, Henry Lai. This README describes the implemented file-backed server and
its local fallbacks. Tiers, groups and labels, scope rules, the scope builder, living scopes and
audit records are tracked in `../docs/PRD.md` and `../STATUS.md`. Existing folder grants are not
scopes; do not claim information barriers from this scaffold.

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
| Moss search (A4) | `src/retrieval/moss.ts` | Official SDK local hybrid index over hot facts. Folder metadata filters run before ranking, followed by canonical-ID and grant checks. Updates retire removed facts; failed indexing fails closed | Add finance group/label and scope fact-ID filters (A4). First use downloads an embedding model. Keyword is selected only without Moss credentials |
| SSE (A5) | `src/events.ts` | Real: ring buffer, replay, heartbeat, ids | Add scope and audit events; keep plain SSE |
| Grants → scopes (A6) | `src/auth.ts` | Real: bearer → client → `Grant` (`DEMO_GRANTS` or `CANON_GRANTS_FILE`) | Each token maps to one person or agent and their scope (A6) |
| Jev filter (part of A7) | `src/mcp.ts` → `runContext` | Real flow: retrieve k=20 → **one** `judge.ask()` (a noul per candidate + "enough?") → keep p > 0.7 → `cutToBudget`. Judge comes from `createJudge()`: `fake` (simulated) without keys. A judge failure (timeout, 5xx) is not an MCP error: no fact is served, `enough` is false and `missing` carries the reason | Documented Jev API is wired and live-tested; add the planned in-scope handoff and audit record (A7) |

`canon_save` never writes a hot fact: it archives a one-message session and emits `session.captured`
for the distiller. `src/seed.ts` copies `fixtures/` (sample data, see `fixtures/README.md`).

## Stub vs real, in one list

- **Simulated:** the `fake` judge (no keys), the `keyword` retriever (no Moss creds). Both are named
  in `GET /health` and in the start-up log so the dashboard can label them.
- **Real:** everything else above. Latency numbers in `context.served` (`latency_ms`, `retrieval_ms`,
  `judge_ms`) are wall-clock measurements; `tokens` is `estimateTokens()` and must be shown as "est.".

## Tests (`src/**/*.test.ts`)

Store round-trip, auth, event ring buffer, keyword scoping, `canon_context` budget cut with a
`FakeJudge` override, seed + fixtures, and `app.test.ts`: real HTTP on port 0 covering every route plus
the MCP endpoint through the SDK `Client`.
