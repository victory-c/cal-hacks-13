# `@canon/server` — MCP + REST + SSE, fact store, cold archive, scopes, retrieval

**Owner:** lane A, Henry Lai. This README describes the implemented file-backed server and
its local fallbacks. Tiers, groups and labels, scope rules, the scope builder, living scopes and
audit records are tracked in `../docs/PRD.md` and `../STATUS.md`; the end-to-end loop on Claude
Code (one person token, MCP on scopes, persistence, the member view) is `../docs/PIPELINE-PRD.md`.
Folder grants are not scopes: a person's or agent's token holds no folders (`DEMO_GRANTS`), and
everything it reads comes from its scope.

## Run, seed, test

```bash
npm run dev -w server         # tsx watch, http://127.0.0.1:4100 (CANON_PORT)
npm run seed -w server        # optional: scaffold fixtures/ + the demo world into the data dir (CANON_DATA_DIR, default data/), skip existing
npm run reset -w server       # back to the demo world at 0:00: removes facts/, sessions/ and world/, reseeds; refuses while the server is up
npm run typecheck -w server && npm test -w server    # 139 tests in 18 suites (the glob also runs the still-untracked agent-runs, handoffs and moderator tests), 7.0 s on this run, offline, boots its own servers on port 0
```

Reads `.env` via `loadEnv()` (see `.env.example`). With no `CANON_CLIENT_TOKENS` the dev tokens from
`.env.example` are used, with a warning. Binds to 127.0.0.1 only. **A store with no facts is seeded
at start-up** (`src/index.ts`) with the scaffold `fixtures/` and the demo world's 0:00 facts (below), so a fresh clone demos without a separate seed step;
`npm run seed` is for re-seeding a store you emptied by hand. **A store with a persisted `world/` is
restored, not reseeded:** people added, rules edited, agents created and scopes built since the last
start are all still there, and the 0:00 scopes are not rebuilt (see "Persistence and restart").
The store is scanned once at boot: a file you add in Obsidian while the server runs shows up after a
restart. Start-up failures (port in use, bad `JUDGE_PROVIDER`, broken `CANON_GRANTS_FILE`) are one
`[server] ...` line, not a stack trace.

## Endpoints

"Person" below is a token whose grant names a person (`DEMO_GRANTS`: `wags`, `axe`, `ben`,
`dollar-bill`; the `CANON_PERSON_TOKEN` the Claude Code hooks send); "agent" one whose grant names an
agent; "moderator" a person with the moderator tier; "internal" `distiller` and `dispatcher`;
"operator" a capture client with no principal (`claude-code`, `chatgpt`, `ingest`).

| Method + path | Auth | Does |
|---|---|---|
| `GET /health` | – | `HealthResponse`: counts, uptime, judge and retriever names |
| `GET /events` | optional; also `?token=` | SSE of `CanonEvent`: replays the last 100, then live; heartbeat comment every 15 s. The token may ride in `?token=` because an `EventSource` cannot set a header; same authorization as the header, never logged, unknown is 401. **A person's or agent's token gets the member stream** (`memberEventView`, `src/contract.ts`): their own items as `item.captured`, `fact.saved` for facts in their scope (or their own, bound to join), their own and their agents' scope changes as `scope.build` / `scope.changed`, their agents' runs and handoffs (`handoff.served` keeps a `candidates` field, emptied to `[]`), and the `context.served` of their own client. No triage, quarantine, audit, refile or other people's events, no exclusion text, no counts. Moderators and internal clients get the whole stream; only the distiller gets extraction plans. An operator token sees facts in its read grant and its own activity; the tokenless dashboard sees the scaffold folders only (`career`, `projects`, `team`), never `private/`, `inbox` or a scope group |
| `GET /api/facts` | optional | **A person's or agent's token gets its scope in the contract's shape** (`ContractFact`: `group`, `labels`, `source`, `author`, `happened_at`, `learned_at`, `status`, plus `source_kind` / `source_title` from the archived item when it still exists), filtered inside the scope by `?group=` (prefix), `?label=` and `?q=` (statement and detail substring). A moderator gets every hot fact (`?status=cold` for the cold ones). Operators keep the folder view `?folder=&tier=` over their read grant (the distiller also reads every listed group); without a token: the scaffold folders only |
| `GET /api/grants` | – | The grants table |
| `POST /api/sessions` | bearer | Upsert a `CapturedSession` into the cold archive. `body.client` says where the text came from; the token says who. **A principal-bound token** (a person's `CANON_PERSON_TOKEN`, an agent's) may post any capture source; its sessions are authored by that principal, a body `principal` naming anyone else is a 403, and it may update only its own principal's sessions (an older session with no principal: its own client's). **A token without a principal** must match `body.client`, may update only its own client's sessions, and may name a `principal` only if it is internal or `ingest` (tools a moderator runs for the real authors); a capture token doing so is a 403, since authorship decides whose scope the facts join. **A named principal must exist** in the world (400) |
| `GET /api/sessions/:id` | moderator, internal | One archived session. A raw transcript holds more than any one scope, so everyone else gets the constant `403 { "error": "moderators only" }`, sent before the id is parsed |
| `POST /api/facts` | bearer | Distiller files decided facts (`PostFactsBody`). Needs write grants on the destination and on existing facts being overwritten or retired (403 + `access.denied`); the distiller may also write any group the server lists (`GET /api/groups`). The entire batch is authorized before writing. Each `decision` is validated (action, `supersedes` id, tier/folder equal to the fact's, probabilities in [0, 1], judge name) and rebuilt before it is broadcast; `decision.triage` rides along for moderators and is stripped from the member and tokenless streams. `supersede`/`merge` re-writes the old fact as `cold` (never deletes) and emits `fact.retired` |
| `POST\|GET\|DELETE /mcp` | bearer | MCP Streamable HTTP, stateless: fresh `McpServer` per request. **Behaviour by token class** (`../docs/PIPELINE-PRD.md` §4.2): a person's or agent's token reads its scope (`canon_context` is the self handoff, `canon_search` searches inside the scope, `canon_whoami` names the principal and task); an operator token keeps the scaffold's folder grants. Details under "MCP tools" |
| `GET /api/me` | person, agent | `MeResponse` `{ id, kind, name, tier?, creator?, task?, firm? }`; never the exclusions. An operator token is not a principal: 404 |
| `GET /api/groups` | moderator, internal; members | `GroupsResponse`, the full list with descriptions and aliases (triage reads it to file facts). **A member's token gets only the groups their scope has a fact in**, as `{ id, display }` (`display` from the world, else the id's last segment humanized by `humanize()`: `market/public` → "Public"; "Public market" is the `display` the world fixture gives that group) |
| `GET\|POST /api/principals`, `GET /api/principals/:id`, `POST /api/principals/:id/tier` | GET: moderator, internal; writes: moderator | People, tiers and agents. Adding a member takes a `rule` and builds their scope (exclusions applied in code); a failed build takes the person back out and nothing is audited or announced |
| `PUT /api/principals/:id/rule` | moderator; the creator for their own agents | The contract's rule route: `{ task, exclusions: { groups, labels, text[] } }` (`deal/*` becomes the `deal` prefix, `text` is joined with `; `). The same operation as `PUT /api/scope-rules/:id`; returns `{ build_id }`. The gate runs before any lookup: one constant 403 whether the target exists or not |
| `GET\|PUT /api/scope-rules/:principal` | GET: moderator, the creator for their own agents, internal; PUT: moderator, creator | A member never reads their own rule (the exclusions are never shown). **`PUT` builds the scope from the new rule first and stores the rule only when the build succeeds:** a judge that throws leaves the old rule and the old scope (500). Then every agent of the person is rebuilt from the creator's new scope with its own rule; an agent whose rebuild fails is trimmed in code to the creator's new scope. Accepts both rule shapes; returns the rule plus `build_id` |
| `GET /api/scopes/:principal`, `GET /api/scopes/:principal/facts` | moderator, internal | The fixed fact-id list, and the facts themselves (an agent's sandbox) |
| `GET /api/agents` | person, agent | `AgentsResponse`: the caller's own agents (a moderator: all) as `AgentSummary` rows (`shared/src/types/api.ts`) `{ id, creator, name, status, steps, files, inbox, task, fact_count, pending, finished_at, leave_out, docs, schedule, outputs }`. `fact_count` is the agent's current scope size. `status` is `ready` (the type also allows `running`, `restarting`, `done`, `failed`, `stopped`), `steps`/`files`/`inbox`/`docs`/`outputs` are empty, `pending` is `0`, `finished_at` is `null`, `leave_out` is `""` and `schedule` is `"Only when I press Run"`: the dispatcher's run reports are not folded in yet (`src/agent-runs.ts` is not imported by the router) |
| `POST /api/agents` | any person for themselves; a moderator for anyone | **Both bodies:** the scaffold's `{ created_by, name, rule }` and the contract's `{ name, task, exclusions }` (the creator is then the caller). The agent's scope is built from its creator's scope only and checked in code to be a subset; a failed build means the agent never existed. **Returns the agent (`Principal`) with `build_id`** |
| `DELETE /api/agents/:id` | the creator or a moderator | Removes the agent, its rule and its scope; audit `agent.deleted` |
| `POST /api/agents/:id/run` | the creator or a moderator | The same operation as `POST /api/dispatch`: emits `dispatch.requested`, returns `{ id }`. One constant 403 whether the agent exists or not |
| `POST /api/items` | person, agent | `{ kind, source, text, author? }` (`kind` is any `SourceKind` but `ai_session`) → one captured session (`client: "ingest"`, `title` = source, `principal` = the caller; an agent's creator) → `{ item_id }`. Only a moderator may name another `author`, who must exist. Emits `session.captured` (`item.captured` on the member stream); the distiller does the rest and the facts arrive as `fact.saved` |
| `PATCH /api/facts/:id` | person, agent; fact in scope | `{ statement }` edits the statement in place (same id, `updated` today). Emits `fact.saved` with the stored probabilities (not re-judged); audit `fact.edited`. **Outside the scope: 404 with the same bytes as a missing fact** |
| `POST /api/facts/:id/retire` | person, agent; fact in scope | Tier → `cold`, history kept. Emits `fact.retired` (`superseded_by: ""`), so it leaves every scope; audit `fact.retired`. Outside the scope: 404 |
| `GET\|POST /api/quarantine`, `POST /api/quarantine/:id/release` | GET + release moderator; POST internal | Held captures; release is 409 when already released |
| `GET /api/audit?principal=&since=` | moderator | `AuditResponse` |
| `POST /api/handoff` | internal; a person for themselves | `HandoffBody` → `HandoffResult`: candidates only ever come from inside the fixed scope (every in-scope fact when the scope holds at most `JUDGE_ALL_UP_TO` = 40, the retriever only ordering them), the needs-context check, batched relevance, budget cut, pinned profile (never the exclusions), audit row + `handoff.served`. A person's token gets its own principal's slice (a body `principal` naming anyone else is one constant 403) and no `candidates` field; a member whose scope is not built yet (Ben before 0:40) gets the profile and nothing else, not a 404. The Claude Code context hook calls it |
| `POST /api/dispatch` | the agent's creator or a moderator | `DispatchRequest` → `{ id }`, emits `dispatch.requested`; `by` must be the caller |
| `POST /api/events` | internal | Re-broadcast one `RELAYED_EVENTS` event on `/events` (the server stamps `at`) |
| `POST /api/facts/:id/file` | moderator | Refile a fact `{ group, labels? }` (INTEGRATION.md), e.g. the announced Stonewall terms to `market/public` at 1:20. A scope whose rule now excludes it loses it in code; then it joins the scopes it now fits through the living-scope checks. Emits `fact.filed`; audit `fact.filed` |

**The demo world (`src/world.ts`).** The server runs on Edan's Axe Capital / Project Stonewall world
in `../fixtures/world/` (C20): people, groups (code names become aliases), labels and scope rules
from `world.json` (`deal/*` is the `deal` prefix), and the answer key's facts from `expected.json`,
with their stable `fact_id`s (the ones `bench/tasks/finance/` cites), groups, labels, the item's
author, and one raw session per item in the cold archive. Several items can state one fact; the
first item listed is its source. `seed` holds the items loaded before the demo; `all` (the
benchmark) adds the 0:25 items; the quarantined counsel email never becomes facts. **Scopes are
never copied from a fixture:** on a fresh store the server builds the 0:00 ones (Axe, Dollar Bill, his
desk assistant) with the configured judge and retriever (`buildInitialScopes`, audited as actor
`server`); Ben's waits for Wags at 0:40 and the 1:00 agents are created live. A persisted `world/`
wins over the fixtures (below). A scope draws only from facts filed in one of the world's groups, so
the scaffold's `career/` and `projects/` notes join none. A moderator has no scope record: their
handoff draws from every hot fact. The server tests still run on the earlier Falcon world
(`../distiller/fixtures/world/`, `fixtures/falcon/`, `FALCON_TEST_GRANTS`), whose prebuilt scope
snapshot pins their expectations; `src/loop.test.ts` runs on the demo world.

**Scopes tier enforcement (A2, `src/scopes.ts`).** A token acts as a principal only when its grant
names one (`callerRoles`): an operator client whose id happens to match a person's never acts as
them. Moderator routes answer every non-moderator with one constant `403 { "error": "moderators only" }`
**before anything is looked up**, so the same bytes come back whether the target exists or not — no
refusals that reveal, no existence signals. World state (people, rules, scopes, quarantine, audit)
lives in memory per server and is written to `world/` under the data dir (`src/persist.ts`); it is
restored from there on start, else loaded from the demo world (above). Facts come from the regular store.

**Scope builder and living scopes (A4+A6, `src/scopes.ts` + `src/scope-judge.ts`).** A build is:
excluded groups (prefix) and labels removed **in code** → one retriever query for the task, result
re-filtered against the post-exclusion pool in code → one batched `judge.ask()` per Jev decision
(group-under-exclusion, then per candidate fact-under-exclusion + helps-with-task), thresholds from
`TRIAGE_THRESHOLDS` applied in code, a "maybe" on an exclusion counts as excluded → a fixed list of
fact ids. Every stage is a `scope.stage` event with its **measured** time and the build's `build_id`;
every build writes a `scope.built` audit row that keeps its own copy of the list, so a later join
never rewrites it. A member's own facts join unless an exclusion removes them; an agent's base is its
creator's scope only and the subset is re-checked right before the write (violation = loud 500). On
`fact.saved`, the fact joins each scope that clears the same checks (inbox facts join none); on
`fact.retired` it leaves every scope — both audited (`fact.joined_scope` / `fact.left_scope`). Without
credentials the keyword retriever stands in for Moss and the fake judge answers the scope questions
from keyword overlap (`simulatedScopeAnswers`); both are labelled simulated in the audit detail.
**Benchmark numbers still require the real providers before any measured barrier-performance claim.**

Auth is `Authorization: Bearer <token>`; tokens map to clients via `CANON_CLIENT_TOKENS`. A missing or
unknown token is `401 { error }` (on the three "optional" routes a *missing* token gives the public view
and an *unknown* one is still a 401). All errors are `{ error }` JSON. One log line per request:
`METHOD path status ms`. A request target Node accepts but the URL parser rejects (`GET http://x:99999/`)
is a 400. CORS is `*` (localhost-only server; the dashboard on :4200 has no token and therefore never
sees anything but the scaffold folders).

**MCP tools** (`src/mcp.ts`): `canon_context`, `canon_search`, `canon_save`, `canon_whoami`, input shapes
as in `shared/src/types/mcp.ts`. Every result has `content[0].text = JSON.stringify(output)` and
`structuredContent = output`. What a call may see depends on the token's class (`../docs/PIPELINE-PRD.md` §4.2):

- **Person or agent** (the grant names a principal). `canon_context` is the self handoff: search inside
  the scope, the needs-context check, Jev relevance at `TRIAGE_THRESHOLDS.RELEVANT`, the token budget,
  an audit row and `handoff.served`, plus `context.served` for the dashboard counter. It returns
  `facts`, `profile`, `tokens`, `latency_ms` and `enough = facts.length > 0`; never `candidates` or
  `missing` (what was considered and what the memory lacks are not theirs to know). A moderator's
  universe for `canon_context` is every hot fact (`runHandoff` → `store.listFacts({ tier: "hot" })`),
  `inbox` and the scaffold folders included; only `canon_search` limits a moderator to the world
  groups (`hotCandidates`). `canon_search` searches the scope only; `folders`
  narrow within it and a folder the scope has nothing in is simply not searched; every hit is
  re-checked against the scope's ids in code and `supersedes` is dropped (the fact it names may be
  outside). `canon_whoami` is `{ client, principal, name, tier | created_by, task }`, no `read`/`write`.
  `canon_save` queues a one-message session with `kind: "note"`, `external: false`,
  `meta.source: "canon_save"` and `principal` = the person (an agent's creator).
- **Operator** (no principal: `claude-code`, `chatgpt`). The scaffold's folder grants, unchanged:
  `canon_context` retrieves k=20 over the grant, one batched `judge.ask()` (a noul per candidate +
  "enough?"), keeps p > `THRESHOLDS.RELEVANT` = 0.7, cuts to budget and sets `enough` / `missing` /
  `candidates`; a `canon_search` folder outside the grant is dropped silently (an ordinary, possibly
  empty list, never a refusal) and moderators see the probe as `access.denied`; `canon_whoami` is
  `{ client, read, write }`.

**One live run (Sat 10/24, real Jev, Claude fact writer `claude-sonnet-5-5`, keyword retriever, demo
world).** A capture as Dollar Bill's person token → 200. The writer produced 3 drafts in 3858 ms (an
earlier run: 6342 ms); Jev triage took 243 ms (earlier 420 ms). The 3 facts, filed in
`desk/dollar-bill` with `author: dollar-bill`, joined Dollar Bill's scope and his desk assistant's.
The next prompt through the context hook ("What is our TMC position now…") got 1 fact / 22 est.
tokens; "What price are we offering for Taylor Mason…" added nothing. Claude Code's own
non-interactive run (`claude -p`) loaded the project `.mcp.json` with `CANON_PERSON_TOKEN` exported
and called `canon_whoami` (`{ client, principal, name, tier, task }`, no `read`/`write`) and
`canon_context` (3 facts, all inside his scope). The keyword retriever is a stand-in for Moss; these
are timings of one run, not a benchmark.

## Data layout (`CANON_DATA_DIR`, gitignored, opens in Obsidian)

```
facts/<folder>/<id>.md     one fact per markdown file (shared serializeFactFile / parseFactFile)
sessions/<id>.json         raw CapturedSession, the cold archive
world/*.json               the world: groups, principals, rules, scopes, quarantine (src/persist.ts)
world/audit.jsonl          the audit log, one AuditEvent per line, append-only
```

Writes are tmp + fsync + rename (`writeAtomic`, exported from `src/store.ts`). `FileStore.loadAll()`
skips unparsable files with a warning and sweeps tmp files orphaned by a crash, in `world/` too. Only
`hot` facts are indexed for retrieval; the index refreshes on every `fact.saved` / `fact.retired`.

## Persistence and restart

Everything the moderator and the pipeline decide about people, rules, scopes, agents and quarantine
lives in `<data dir>/world/` (`src/persist.ts`, `WorldPersister`; `../docs/PIPELINE-PRD.md` §4.4).
Facts and sessions keep their own files.

```
world/groups.json        { groups, firm? }
world/principals.json    { principals, firm? }     its presence means "a world was written here"
world/rules.json         { rules }
world/scopes.json        { scopes }
world/quarantine.json    { items }
world/audit.jsonl        one AuditEvent per line, appended as each row is logged, never rewritten
```

- **Writes.** A handler marks a section changed (`world.touch("scopes")`); the next `flush()` writes
  every dirty section with `writeAtomic` through **one serialized queue**, so two changes to the same
  file can never finish their renames out of order. `touch` also schedules a flush on the next
  microtask, so a living-scope join lands without a request behind it. **Every handler that changes
  the world awaits `world.flush()` before it answers:** when the response says a person was added,
  the file says so too. Audit rows go through the same queue as appends. A failed write is logged and
  the next flush rewrites the snapshot; the queue never wedges.
- **Start** (`startServer`, `src/app.ts`). If `world/principals.json` exists, the world is restored
  from `world/` (groups, principals, rules, scopes, quarantine, audit, firm) and `restored` is true;
  otherwise the demo world comes from `fixtures/world/`. `buildInitialScopes` then builds the 0:00
  scopes **only for `initial_scopes` principals that have no scope**, so a restart never rebuilds a
  persisted scope (it would drop live joins and refiles and write a second `scope.built` row). After
  a restore, `reconcileScopes`: a fact id a scope names that the store no longer has is **dropped**
  with one `fact.left_scope` audit row; a hot fact in a world group that is in no scope at all (saved
  right before a shutdown cut its living update short) is **re-offered** to the living-scope check
  once (idempotent). Then one flush writes every section. A torn last audit line is skipped with a
  warning, never fatal.
- **Close** (`close()`; `SIGINT`/`SIGTERM` in `src/index.ts`). In-flight living-scope updates finish
  first (`living.drain()`, bounded at 10 s so a hung judge cannot keep the process alive), then every
  queued world write lands (`persister.drain()`), then connections and the retriever close. Nothing
  decided before the signal is lost.
- **Reset** (`npm run reset -w server`, `src/reset.ts`). Removes `facts/`, `sessions/` and `world/`
  under the data dir and seeds the demo world again; the server builds the 0:00 scopes on its next
  start. It checks `/health` at `CANON_URL` first and **refuses while the server is up**, because the
  running process would keep writing into the directory it just emptied. For QA and the demo, never
  for a real store.

## Where each server area lives

Task ids refer to the current board in `../STATUS.md`. Some areas were built before the finance
task list was written, so an area can run today while its finance task is still open.

| Area (task) | File | Now | Next |
|---|---|---|---|
| MCP server | `src/mcp.ts`, `src/router.ts` | Real: four tools over the SDK's stateless Streamable HTTP, **by token class**: a person's or agent's token reads its scope through the self handoff (`selfHandoff`, `scopeFacts`); an operator token keeps the folder grants (`../docs/PIPELINE-PRD.md` §4.2) | — |
| Cold archive (A3) | `src/store.ts` | Real: JSON per session, atomic writes; `sessionInfo()` keeps client, principal, kind and title in memory for events and items, never the transcript | Pull-from-cold when `enough` is false |
| World persistence | `src/persist.ts` | Real: `world/` snapshots + `audit.jsonl`, one serialized write queue, flush before the response, restore on start with reconcile, drain on close, `npm run reset` | — |
| Member view (INTEGRATION.md) | `src/contract.ts` | Real: `GET /api/me`, scoped `GET /api/facts` and `GET /api/groups`, `POST /api/items`, `PATCH /api/facts/:id`, `POST /api/facts/:id/retire`, `GET`/`POST /api/agents`, `POST /api/agents/:id/run`, `PUT /api/principals/:id/rule`. Every read starts from the scope; outside it a fact is a 404 with the same bytes as a missing one | Fold the dispatcher's run reports into `AgentSummary` (lane B) |
| Member event stream | `src/contract.ts` → `memberEventView`, `src/router.ts` | Real: a person's token on `/events` (header or `?token=`) gets its own items, in-scope facts, its own and its agents' `scope.build` / `scope.changed`, its agents' runs and handoffs, its client's `context.served`; nothing moderators-only | — |
| Moss search (A4) | `src/retrieval/moss.ts` | Official SDK local hybrid index over hot facts. Folder metadata filters run before ranking, followed by canonical-ID and grant checks. Updates retire removed facts; failed indexing fails closed | Add finance group/label and scope fact-ID filters (A4). First use downloads an embedding model. Keyword is selected only without Moss credentials |
| SSE (A5) | `src/events.ts` | Real: ring buffer, replay, heartbeat, ids; a filter per subscriber drops or redacts; nested emits keep their own ids | Keep plain SSE |
| Grants → scopes (A6) | `src/auth.ts`, `src/scopes.ts` → `callerRoles` | Real: bearer → client → `Grant` (`DEMO_GRANTS`, or `CANON_GRANTS_FILE` when set). A grant's `principal` makes the token a person or agent whose every read is its scope (`wags`, `axe`, `ben`, `dollar-bill`); a token without one is an operator (folder grants) or an internal worker. Only the built-in `DEMO_GRANTS` (`shared/src/types/grants.ts`) carry a `principal`: `loadGrants()` keeps just `{ client, read, write }` from each grants-file entry, so a `CANON_GRANTS_FILE` token can never bind to a person or agent | Per-agent tokens |
| Jev filter (part of A7) | `src/mcp.ts` → `runContext`, `src/scopes.ts` → `runHandoff` | Real flow. Person tokens: `runHandoff` (needs-context check, then **one** batched relevance call, `TRIAGE_THRESHOLDS.RELEVANT`, budget, audit). Operator tokens: retrieve k=20 → **one** `judge.ask()` (a noul per candidate + "enough?") → keep p > 0.7 → `cutToBudget`. Judge comes from `createJudge()`: `fake` (simulated) without keys. A judge failure (timeout, 5xx) is not an MCP error: no fact is served, `enough` is false and, for operators, `missing` carries the reason | — |

`canon_save` never writes a hot fact: it archives a one-message session and emits `session.captured`
for the distiller. `src/seed.ts` copies `fixtures/` (sample data, see `fixtures/README.md`).

## Stub vs real, in one list

- **Simulated:** the `fake` judge (no keys; for scope builds it answers from keyword overlap, see
  `src/scope-judge.ts`), the `keyword` retriever (no Moss creds). Both are named in `GET /health`,
  in the start-up log and in the `scope.built` audit detail so the dashboard can label them.
- **Thresholds** (`TRIAGE_THRESHOLDS` in `shared/src/types/judge.ts`) are calibrated on one live
  Jev run on the demo world (A20); the measured ranges sit next to each value.
- **Real:** everything else above. Latency numbers in `context.served` (`latency_ms`, `retrieval_ms`,
  `judge_ms`) are wall-clock measurements; `tokens` is `estimateTokens()` and must be shown as "est.".

## Tests (`src/**/*.test.ts`)

Store round-trip, auth, event ring buffer, keyword scoping, `canon_context` budget cut with a
`FakeJudge` override, seed + fixtures, `scopes.test.ts` (the Falcon world: tiers, builder, living
scopes, handoff), `world.test.ts` (the demo world: 0:00 scopes, the Stonewall wall, refiling),
`api-permissions.test.ts`, `event-visibility.test.ts`, and `app.test.ts`: real HTTP on port 0
covering every route plus the MCP endpoint through the SDK `Client`.

`src/loop.test.ts` is the core loop's server side on the demo world (`../docs/PIPELINE-PRD.md`), a
real server on port 0 with the simulated scope judge and the keyword retriever, seeded at 0:00:
`GET /api/me` (never exclusions; an operator token is 404); a person's `GET /api/facts` is exactly
their scope in the contract's shape with `?group=`, `?q=`, `?label=` narrowing inside it, while the
distiller keeps the folder view; a member's `GET /api/groups` by display name; MCP by class
(`canon_whoami` names no group, `canon_context` serves only in-scope facts with no `candidates` or
`missing`, a question about the bid gets nothing and no refusal text, `canon_search` stays inside the
scope and an outside folder is simply not searched, `canon_save` is the person's own note);
`POST /api/items` and the member stream (`item.captured`, nothing moderators-only, no deal group
named, `?token=nope` is 401); `PATCH` and retire inside the scope, 404 with the same bytes outside;
agents in the contract's shape (list, create inside the creator's scope, rule edit through
`PUT /api/principals/:id/rule`, run); the four defects from the review (an audit row never changes
after it is written; nested emits keep SSE ids unique and ascending; a rule edit whose rebuild fails
changes nothing on either route; a fact saved right before shutdown still joins because `close()`
drains); the world survives a restart with nothing rebuilt and no second `scope.built` row; and
`reset` seeds the demo world again.
