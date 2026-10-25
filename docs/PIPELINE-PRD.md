# Pipeline PRD: the core loop, end to end, on Claude Code

**Updated Sat 10/24, 21:00 PDT.** Owner: Henry (lane A). Victor (B) and Edan (C) own the items
marked with their lane. Terminal: Claude Code (hooks + MCP), the Canon server, the member view.
Site: the Axe Capital demo world, standing in for small finance teams.

This document says what is required for the product pipeline to work **end to end for one person
and their AI**, lists every gap found in a line-by-line review and a live run on Sat 10/24, and
fixes the scope of the next build. It sits beside [`CANON-PRD.md`](CANON-PRD.md) (the backend
target), [`BULLWARK-PRD.md`](BULLWARK-PRD.md) (the product) and [`INTEGRATION.md`](INTEGRATION.md)
(the frontend contract). Where this document and the package READMEs disagree, the READMEs
describe what runs today and this document describes what must run next.

Connectors: **Claude Code is the one connector perfected in this build, on both the read and the
write side.** The claude.ai and ChatGPT connectors are pull-only (the model decides when to call a
tool), so they cannot put memory in front of every message; they are defined in §6 and deferred.

## 1. Purpose

### The loop that has to work

A moderator adds a person with a task and, optionally, plain-language exclusions. The server builds
that person's scope: exclusions remove whole groups and labels in code, search finds candidates,
Jev answers yes or no per fact, and the yes answers become a fixed list of fact ids. From then on:

1. **Write.** Whatever the person works on in Claude Code is captured, distilled into facts by the
   Claude fact writer, triaged into a group by Jev, and filed with the person as author. Their own
   facts join their scope at once (an exclusion still removes them); other people's facts join only
   if they pass the same checks as the original build.
2. **Read.** Before every prompt, Claude Code receives the slice of that scope the prompt needs:
   search inside the scope, Jev relevance, token budget, audit row. The same slice is available on
   demand through the MCP tools. Nothing outside the scope is ever named, counted or refused.
3. **Survive.** Everything the moderator and the pipeline decided is still there after the server
   restarts.

### Definition of done

- A person needs exactly **one value** on their machine, `CANON_PERSON_TOKEN`, for both directions.
- The write path (capture → distill → triage → file → join scope) and the read path (hook before
  every prompt; `canon_context`, `canon_search`, `canon_whoami`, `canon_save` over MCP) both run
  from the person's scope, never from the scaffold's folder grants.
- People, rules, agents, scopes, quarantine and the audit log persist in the file store and reload
  on restart; the demo world seeds only an empty store.
- An automated end-to-end test in `npm run check` proves the loop on the offline providers, and
  one live run on Jev plus the Claude writer is recorded with measured numbers.
- The member view's read routes in `INTEGRATION.md` exist on the server with the contract's shapes.

### Current state, measured

Everything below was checked in code on `main` (`fad2db9`) and, where marked *live*, run on Sat
10/24 between 20:40 and 20:55 PDT against real Jev and the Claude fact writer, on a fresh data
dir seeded with the demo world.

| Stage | State | Evidence |
|---|---|---|
| Moderator adds a person with task and exclusions | **Works** | `POST /api/principals` builds the scope at once; `server/src/scopes.test.ts` |
| Scope build: exclusions in code → candidates → Jev yes/no | **Works on live Jev** (since A20) | *live*: Dollar Bill 11 facts, 0 deal; Axe 18; desk assistant 4 |
| Capture: Claude Code `Stop`/`SessionEnd` hook → `POST /api/sessions` | **Works** | *live*: `ses_8a72e604`, 4 messages as `dollar-bill` → 200 |
| Distill: Claude writer → Jev triage → `POST /api/facts` | **Works** | *live*: 3 drafts in 6342 ms (the writer dropped an unsourced rumor on its own); triage 420 ms; 3 facts in `desk/dollar-bill`, `author: dollar-bill`, labels `tmc`, `taylor-mason` |
| Living scopes: new facts join the scopes they fit | **Works** | *live*: all 3 joined Dollar Bill (own facts) and his desk assistant (through its creator); 1 joined Axe for his task |
| Read before every prompt: `UserPromptSubmit` hook → self handoff | **Works** | *live*: "What is our TMC position now…" → 4 facts, 83 est. tokens |
| Read on demand: MCP tools for a person's token | **Gap** | *live*: `canon_whoami` → `{client, read: [], write: []}`; `canon_context` → `facts: []`, `missing: "No stored fact covers: …"` (a hint, forbidden) |
| `GET /api/facts` for a person's token | **Gap** | `{ facts: [] }` for members **and** moderators: the route reads folder grants |
| `GET /api/me`, `POST /api/items`, `/events?token=`, member-filtered SSE | **Gap** | Edan's member view (`c/frontend`, `web/src/member/canon.ts`) calls all of them |
| Persistence of people, rules, agents, scopes, quarantine, audit | **Gap** | In memory only (`ScopeState`); a restart rebuilds the 0:00 world from fixtures and loses everything else |
| One token per person | **Gap** | Capture needs `CANON_TOKEN_CLAUDE_CODE` + `CANON_PRINCIPAL`; reading needs `CANON_PERSON_TOKEN`; a person token cannot capture at all (`body.client` must equal the token's client → 403) |
| Authorship on the capture path | **Security gap** | The `claude-code` token has no principal, so `CANON_PRINCIPAL` is taken on trust all the way to `Fact.author` (`api.ts:67-73`, `triage.ts:237`); any machine can file facts as anyone, and an "own" fact skips the relevance question when it joins |
| `canon_save` sessions | **Gap** | No `kind` and no `external`, so triage reads them as unknown origin; a save from Claude Code has no author unless the token names a principal |
| Capture hook origin flag | **Gap** | The hook never sends `external: false`, so the offline judge treats every Claude Code session as possibly outside the firm and quarantines "send … to" phrasing |
| `fact.saved` carries triage | **Defect** | `parseDecision` rebuilds the decision without `triage`, so moderators never see why a fact was filed where it was |
| Offline triage judge on the demo world | **Gap (B)** | `financeFakeJudge` files by Falcon-world ids (`research/logistics`, `desk/trading`); in the Stonewall world desk and research lines go to `inbox` and join no scope without a Jev or Claude key |
| Supersession of a person's own stale fact | **Gap (B)** | *live*: "now long 200,000 TMC" was saved and "long 180,000 TMC" was not retired; both are served |
| Re-authoring on a paraphrased merge | **Gap (B)** | A non-exact `merge`/`supersede` takes the new session's author (`triage.ts:491`), so a paraphrase can turn someone else's fact into the new author's "own" fact |
| Live-mode churn | **Gap (B)** | With `DISTILL_LIVE=1` every re-distill re-proposes earlier drafts; a repeat becomes a `merge` with a **new id**, retiring the old fact and re-judging every scope |
| Sessions ended while the worker is down | **Gap (B)** | The worker skips replayed events older than 5 s and never rescans the archive, so a `SessionEnd` posted while it was down is never distilled |
| Audit history | **Defect** | `scope.built` rows share their `fact_ids` array with the live scope, so later joins rewrite past rows |
| SSE frame ids | **Defect** | A nested emit (a living-scope join inside `fact.saved`) gives two frames the same id, out of order |
| Rule edit whose rebuild fails | **Defect** | `PUT /api/scope-rules` stores the new rule before the build; a failed build keeps the rule with the old scope and writes no audit row |
| Fact saved just before shutdown | **Defect** | The living-scope update is fire-and-forget; a shutdown during the judge call loses the join for good |

## 2. Design references

Three facts about the surrounding platforms decide the shape of this build.

- **Connectors are pull-only.** On claude.ai, Claude Desktop and ChatGPT a connector is an MCP
  server the model *may* call; nothing can be inserted before every message. Claude Code is the one
  surface with a `UserPromptSubmit` hook that adds context to every prompt (`code.claude.com/docs/en/hooks`).
  So the hook is the automatic path, the MCP tools are the on-demand path, and both call the same
  server handoff so the two can never disagree.
- **Hook context does not re-enter the memory.** Claude Code stores injected context as a separate
  `attachment` record (`hook_additional_context`, rendered as role `system`), not inside the user
  message. The capture hook keeps only `user` and `assistant` records, so a person's memory is never
  captured back as a new fact. Checked in a real transcript on Sat 10/24; pinned by a fixture.
- **Prompt caching is the client's.** Claude Code handles caching; an MCP server cannot mark a tool
  result cacheable. Our lever is a slice that is small and stable for the same scope and prompt.

Memory products such as Mem0 and Zep extract facts, dedupe and supersede. Bullwark's differentiator
is scoping, not extraction; supersession quality is lane B's triage (the relation question) and is
tracked, not redesigned, here.

## 3. Product solution

### The loop, with one token

```text
                 CANON_PERSON_TOKEN (one per person, maps to one principal on the server)
                                │
   Claude Code ─ Stop/SessionEnd ─▶ POST /api/sessions ─▶ cold archive ─▶ distiller ─▶ Claude writer
        ▲                                                                       │
        │                                                               Jev triage → group + labels
        │                                                                       │
        │                                                        POST /api/facts (author = principal)
        │                                                                       │
        │                                              living scopes: exclusions in code → Jev → joins
        │                                                                       │
   UserPromptSubmit hook ◀── POST /api/handoff (self) ◀── scope (fixed fact ids) ◀─┘
   canon_context / canon_search / canon_whoami / canon_save ◀── same handoff, same scope, over /mcp
```

### Rules

1. **One token, one principal.** A per-person token is bound to one principal by its grant. Every
   call it makes acts as that principal: captures are authored by them, reads come from their scope.
   A body field that names anyone else is one constant 403 whether the target exists or not.
2. **Auth is the token; the capture source is a label.** `CapturedSession.client` says where the
   text came from (`claude-code`, `chatgpt`, `ingest`). A per-person token may post any capture
   source and its sessions are authored by its principal. A token without a principal may post only
   its own source and **may not name a principal** unless it is an internal client or `ingest`
   (tools a moderator runs, which file items for their real authors); any other named principal is
   a 403 that says to set `CANON_PERSON_TOKEN`. Ownership of an existing session is checked by
   principal for person tokens, by client otherwise.
3. **The scope is the universe.** For a person or agent, every read (hook, MCP, REST) starts from
   the fixed list of fact ids in their scope. The scaffold's folder grants apply only to operator
   and internal tokens.
4. **No refusals, no existence signals.** A prompt that needs nothing, or asks for something outside
   the scope, gets an ordinary (possibly empty) slice: no error, no "missing", no count of what was
   considered. `canon_whoami` returns who you are and your task, never exclusions, group lists or
   counts.
5. **Moderators see everything** (a handoff over every hot fact); agents are capped by their
   creator's scope, checked in code before every write.
6. **Decisions persist.** Every change to people, rules, scopes, agents, quarantine or audit is
   written to the data dir before the response is sent, and reloaded on start. Fixtures seed only
   an empty store.
7. **History is immutable.** An audit row never changes after it is written; an event carries a
   copy, never a live reference.
8. **A failed build changes nothing.** A rule edit whose rebuild throws leaves the old rule and the
   old scope in place and returns the error.
9. **Nothing is lost at shutdown.** The server drains in-flight living-scope updates before it
   closes.
10. **The hook never blocks a session.** Exit 0 always, hard timeouts, stdout only when there is
    context to add.

### Phases

| Phase | What | Owner | In this build |
|---|---|---|---|
| **P0** | One token for both hooks; MCP tools on scopes; `.mcp.json`; persistence; the four defects; e2e test; live run | A | Yes |
| **P1** | Server side of the member view: `GET /api/me`, contract-shaped `GET /api/facts`, `GET /api/groups` for members, `/events?token=`, member SSE filter and contract event names, `POST /api/items`, `PATCH /api/facts/:id`, `POST /api/facts/:id/retire`, `GET/POST /api/agents` in the contract shape, `POST /api/agents/:id/run` | A (contract with C) | Yes, except where marked B |
| **P2** | claude.ai / Desktop custom connector (public URL + OAuth), Moss credentials in `.env`, measured benchmark run on live providers, supersession tuning, agent `stop`/`PATCH`, ChatGPT extension | A / B / C per §6 | No |

## 4. Functional design

### 4.1 One person token (`hooks/claude-code/`, `server/src/api.ts`)

- `CANON_PERSON_TOKEN` (process env, then the repo `.env`) is the only value a person sets. When
  set, **both** hooks use it: `canon-capture.mjs` posts the session with it, and `canon-context.mjs`
  asks for memory with it. `CANON_TOKEN_CLAUDE_CODE` + `CANON_PRINCIPAL` keep working for operator
  captures without a person (an unattended machine, the bench), and are what the hook uses when
  `CANON_PERSON_TOKEN` is unset.
- The capture hook keeps `client: "claude-code"` as the capture source and sends
  `external: false` (a Claude Code session is the firm's own text). `POST /api/sessions`
  (`postSession`) accepts any `client` value from a token whose grant names a principal, sets
  `principal` to that grant's principal (a body `principal` naming anyone else is a 403), and checks
  ownership of an existing session by principal. Tokens without a principal keep today's rules for
  `client` and ownership, and a body `principal` from them is a 403 unless the client is internal
  or `ingest`. `CANON_PRINCIPAL` therefore only has an effect together with `CANON_TOKEN_INGEST`;
  the hook's debug line prints the server's error text so a misconfigured machine says why.
- `parseSession` checks that a named `principal` exists in the world (404 otherwise), so a fact can
  never be authored by nobody-in-particular.
- Hook commands in the committed `.claude/settings.json` and in `install.mjs` use the
  `${CLAUDE_PROJECT_DIR}` placeholder, which Claude Code expands in both Git Bash and PowerShell;
  the bare `$CLAUDE_PROJECT_DIR` form resolves to nothing under PowerShell.
- `SessionEnd` hooks get a 1.5 s budget unless they declare a timeout; ours declare 15 s. The
  capture hook's own limits (3 s POST, 10 s watchdog) stay.
- The transcript fixture gains one `attachment` record carrying injected memory; the parser test
  asserts it is dropped, so a change in the parser that started capturing hook context would fail.

### 4.2 MCP tools on scopes (`server/src/mcp.ts`, `shared/src/types/mcp.ts`)

`McpDeps` gains `world` and `grants` (it already has `store`, `bus`, `judge`, `retriever`). The
token's class decides the behaviour; the class comes from `callerRoles` plus the grant's `principal`.

| Token class | Example | `canon_context` | `canon_search` | `canon_whoami` | `canon_save` |
|---|---|---|---|---|---|
| **Person** (grant names a person) | `dollar-bill`, `wags` | The self handoff: `runHandoff` for the token's principal. Returns `facts`, `profile`, `tokens`, `latency_ms`, `enough = facts.length > 0`. No `missing`, no `candidates`. A moderator's universe is every hot fact. | Search inside the scope only (facts by id); optional `folders` narrow within the scope and are otherwise ignored silently. Returns the `Fact` records without `jev_keep` and `supersedes`. | `{ client, principal, name, tier, task }`; no `read`/`write`. A moderator has no task. | As today: a one-message session, `kind: "note"`, `principal` from the grant, `client` = the token's client, source hint in `meta.folder_hint`. |
| **Agent** (grant names an agent) | future per-agent tokens | Same as person, over the agent's scope | Same | `{ client, principal, name, created_by, task }` | Principal = the agent's creator (the agent's outputs are its creator's memory) |
| **Internal** | `distiller`, `dispatcher` | Not for MCP; keeps the folder-grant path | folder grants | folder grants | as today |
| **Operator** (no principal) | `claude-code`, `chatgpt` | Unchanged: folder grants, `enough`/`missing`/`candidates` as today | Unchanged (ungranted folder dropped silently, `access.denied` for moderators) | Unchanged `{ client, read, write }` | as today |

- Person-class `canon_context` emits `handoff.served` (from `runHandoff`) **and** `context.served`
  with `client` = the token's client and `task` = the request, so the dashboard counter keeps its
  feed. `context.served` for a person never carries `candidates` beyond the kept count.
- The tool descriptions stop mentioning folders ("Search the facts in your memory…").
- `canon_save` sessions carry `kind: "note"` and `external: false`, so triage reads them as the
  firm's own text, and `meta.source: "canon_save"`.
- `POST /api/facts` keeps `decision.triage` (moderators-only content) on the stored decision and in
  `fact.saved`; the member and tokenless SSE views strip it.
- `runHandoff` is exported; its `HttpError`s become MCP `isError` results carrying the message, but
  a person can only ever trigger the 400s (bad `task`, bad `budget_tokens`): the principal is theirs
  by construction and a missing scope (a member before 0:40) returns an empty slice with the profile,
  not a 404.
- Thresholds: `canon_context` for persons uses the handoff's `TRIAGE_THRESHOLDS.RELEVANT` (0.6,
  calibrated on live Jev, A20); the operator path keeps `THRESHOLDS.RELEVANT` and its tests.
- `shared/src/types/mcp.ts`: `ContextOutput.candidates` and `missing` become optional (absent for
  persons), `profile?: string` is added, `WhoamiOutput` gains `created_by?`. The dashboard, bench
  baseline and Edan's console read only fields that stay.

### 4.3 Claude Code connector files

- **`.mcp.json`** at the repo root, committed:
  ```json
  { "mcpServers": { "bullwark": { "type": "http", "url": "${CANON_URL:-http://127.0.0.1:4100}/mcp",
      "headers": { "Authorization": "Bearer ${CANON_PERSON_TOKEN:-dev-claude-code}" } } } }
  ```
  Claude Code expands `${VAR:-default}` in `url` and `headers`. With no token exported, the server
  sees the dev operator token and serves the scaffold folders; with a person's token, the tools
  serve their scope. Claude Code asks once per clone whether to use the project's MCP servers; a
  server that is down shows as "Failed to connect" and nothing else breaks.
- **`hooks/claude-code/install.mjs --mcp`** prints the `claude mcp add --transport http …` command
  for the user scope, for anyone who prefers not to use the project file.
- **`.env.example`** documents `CANON_PERSON_TOKEN`, that the MCP header reads it from the shell
  environment (export it, or start Claude Code from a shell that sourced `.env`), and the two
  verification commands: `claude mcp list` (connected) and `node scripts/doctor.mjs`.
- **`npm run doctor`** checks that `CANON_PERSON_TOKEN`, when set, is one of `CANON_CLIENT_TOKENS`
  and maps to a client with a principal in the grants, that `.mcp.json` parses, and that the
  committed hooks are wired.

### 4.4 Persistence (`server/src/store.ts`, `server/src/scopes.ts`, `server/src/app.ts`)

Layout under the data dir, next to `facts/` and `sessions/`:

```text
world/principals.json   { principals: Principal[] }
world/rules.json        { rules: ScopeRule[] }
world/scopes.json       { scopes: Scope[] }
world/quarantine.json   { items: QuarantineItem[] }
world/groups.json       { groups: Group[] }
world/audit.jsonl       one AuditEvent per line, append-only
```

- **Writes** go through one serialized queue per server (the pattern `MossRetriever.exclusive`
  uses), each file written atomically (tmp + rename, the store's `writeAtomic`, now exported) and
  awaited **before the HTTP response**. Audit rows are appended, never rewritten. The tmp sweep at
  start covers `world/`.
- **Load order at start:** if `world/principals.json` exists, the world is restored from `world/`
  (groups, principals, rules, scopes, quarantine; audit is loaded for `GET /api/audit`). Otherwise
  the demo world is loaded from `fixtures/world/`, the 0:00 scopes are built with the real pipeline,
  and the result is written. `buildInitialScopes` runs only for principals in `initial_scopes` that
  have no persisted scope, so a restart never overwrites live joins or refiles and never duplicates
  `scope.built` rows.
- **Reconcile on load:** fact ids in a restored scope that are no longer in the store are dropped
  with one `fact.left_scope` audit row each; a hot fact in a world group whose `fact.saved` was
  never processed (saved less than a minute before the last shutdown, see 4.5) is re-offered to
  the living-scope check once.
- **Reset:** `npm run reset -w server` deletes `facts/`, `sessions/` and `world/` under the data dir
  and reseeds the demo world, for QA and the demo. It refuses to run while the server is up (health
  check) and prints what it removed.
- `WorldFixtures` keeps its shape; `loadWorldFixtures(dir)` (the Falcon test world) is untouched,
  so the server tests keep running on it.

### 4.5 The four defects

1. **Audit aliasing.** `logAudit` deep-copies `fact_ids`; `buildScope` writes the scope from a
   copy; every `scope.updated` and `principal.changed` payload carries a copy. Test: a join after a
   build leaves the build's audit row unchanged.
2. **SSE ids.** `EventBus.emit` stamps the id when the event is created and the frame writer uses
   that id, so nested emits are monotonic and unique. Test: a `fact.retired` that triggers
   `audit.logged` and `scope.updated` yields three frames with three ascending ids.
3. **Rule-before-build.** `PUT /api/scope-rules` and `addPerson` build first and store the rule only
   when the build succeeds; on failure the previous rule and scope stand and the error is returned.
   Test: a judge that throws leaves `GET /api/scope-rules/:p` unchanged.
4. **Fire-and-forget join.** `attachLivingScopes` tracks in-flight updates; `RunningServer.close()`
   drains them (bounded by 10 s) before the listener closes. Test: close during a slow judge still
   writes the join.

### 4.6 Member view routes (P1, `INTEGRATION.md`)

Per-person tokens get the contract's shapes; operator, internal and tokenless callers keep the
scaffold's, so the dashboard, the distiller and the bench are unchanged.

| Route | Who | Behaviour |
|---|---|---|
| `GET /api/me` | any person or agent token | `{ id, kind, name, tier?, creator?, task?, firm }` (`WhoamiOutput` plus `firm` from the world). Never exclusions. Operator tokens: 404 (they are not a principal). |
| `GET /api/facts` | person | Facts in the caller's scope (every hot fact for a moderator) in the contract shape: `{ id, statement, group, labels, source, author, happened_at, learned_at, status, source_kind?, source_title? }`; `?group=`, `?label=`, `?q=` filter inside the scope. `source_kind`/`source_title` come from the archived session when it exists. |
| `GET /api/groups` | person | Only the groups present in the caller's scope, as `{ id, display }` (display from the world; the id humanized when absent). Moderators and internal clients keep the full list with descriptions and aliases. |
| `GET /events?token=` | any | The token may ride in the query string because `EventSource` cannot set headers. Same authorization as the header; a person's stream carries only events about their own scope and agents. The token is never logged. |
| `POST /api/items` | person | `{ kind, source, text, author? }` → one captured session (`client: "ingest"`, `kind`, `principal` = caller; only a moderator may set `author`) → `{ item_id }` = the session id. Emits `item.captured`. The distiller does the rest; results arrive as `fact.saved`. |
| `PATCH /api/facts/:id` | person, fact in scope | `{ statement }` edits the statement in place (same id, `updated` today), emits `fact.saved`. Outside the scope: 404, same bytes as a missing fact. |
| `POST /api/facts/:id/retire` | person, fact in scope | Tier → cold, emits `fact.retired`, leaves every scope. Outside the scope: 404. |
| `GET /api/agents` | person | The caller's own agents (moderators: all) as `{ agents: AgentRun[] }` with `id, creator, name, status, steps, files, inbox, task`; `status` is `ready` until the dispatcher reports a run. |
| `POST /api/agents` | person | Accepts the contract body `{ name, task, exclusions: { groups, labels, text[] } }` as well as today's `{ created_by, name, rule }`; returns `{ id, build_id }`. |
| `POST /api/agents/:id/run` | creator or moderator | Alias of `POST /api/dispatch`: emits `dispatch.requested`, returns `{ id }`. |
| `PUT /api/principals/:id/rule` | moderator; creator for own agents | Alias of `PUT /api/scope-rules/:id` accepting `exclusions` (text as `string[]`, joined with `; `) and returning `{ build_id }`. |

Events for a person's stream, in addition to the existing names (which the dispatcher keeps using):
`scope.build` (alias of `scope.stage` with `build_id`, `stage` mapped `exclusions → exclusions`,
`moss → candidates`, `jev → judged`, `done → done`, counts within the caller's view),
`scope.changed` (alias of `scope.updated`: `principal, added, removed`), `item.captured`
(alias of `session.captured` for ingest/`POST /api/items` sessions, with `item_id, kind, source,
author`), `fact.saved` only when the fact is in the caller's scope. `agent.*` events pass when the
agent is the caller's.

Not in this build (lane B's dispatcher): `POST /api/agents/:id/stop`, `PATCH /api/agents/:id`
(name, docs, schedule), the `docs`/`schedule`/`outputs` fields. The contract above is what Edan's
`web/src/member/canon.ts` sends today; the server accepts it, and the `PROPOSED` fields it reads are
returned as empty values.

### 4.7 Tests

- **Unit** (existing suites extended): hooks (one token, `external: false`, attachment record
  dropped, the server's error text in the debug line), server (`postSession` source and principal
  rules including the 403 for a capture token naming a principal, MCP per token class,
  `canon_save` kind, `decision.triage` kept for moderators and stripped for members, persistence
  round trip, the four defects, each contract route and the member SSE filter), shared (type
  changes), distiller (nothing changes in lane B's code; its 243 tests must still pass).
- **End to end** (new `e2e/` workspace, in `npm run check`): the real server on port 0 with a fresh
  data dir and the offline providers, the real distiller handler against it over HTTP, the real
  hook scripts as child processes with a Claude-Code-shaped transcript. It asserts: Dollar Bill's
  session becomes facts with `author: dollar-bill` in a world group; they join his scope and his
  desk assistant's; a line about the bid filed under `deal/` by triage never joins his scope; the
  context hook's next prompt carries the new fact; `canon_save` over MCP with his token lands as his
  fact; `canon_whoami` names no group; a restart keeps a moderator-added person, a live-built scope
  and the audit; a prompt that needs nothing adds nothing.
- **Live** (recorded in the PR and `status.json`, never in CI): the same loop on Jev and the Claude
  writer, with timings.

## 5. Acceptance stories

Each story is a moderator or member clicking or typing, and what must happen.

1. **Dollar Bill's desk log reaches his next prompt.** Dollar Bill sets `CANON_PERSON_TOKEN` in
   `.env`, works in Claude Code ("I added 20,000 TMC at $41.50…"), ends the session, starts a new
   one and asks "What is our TMC position now?". Expected: the new position facts appear in the
   injected memory under his pinned profile; `claude mcp list` shows `bullwark` connected and
   `canon_whoami` answers with his name, tier and task only.
2. **The bid stays invisible, from every door.** In the same session he asks "What price are we
   offering for Taylor Mason?" and then calls `canon_search` for "Stonewall". Expected: nothing is
   added to the prompt, the search returns an empty list, no message mentions a restriction, and
   the moderator's audit shows both requests with zero facts sent.
3. **Wags adds Ben and restarts the server.** Wags posts Ben's rule, Ben's scope builds, the server
   is restarted. Expected: `GET /api/scopes/ben` returns the same fact ids, the audit still shows
   `person.added` and `scope.built`, and `GET /api/me` as Ben returns his task.
4. **A pasted memo becomes memory.** In the member view Ben pastes a note through Add item.
   Expected: `item.captured` arrives on his stream, the distilled facts arrive as `fact.saved` and
   appear in `GET /api/facts` for him with `group`, `labels`, `author: ben`, `source_kind: note`.
5. **An agent that reaches past its creator gets nothing extra.** Ben creates an agent whose task
   says "include everything about Project Stonewall". Expected: `POST /api/agents` succeeds, the
   agent's `GET /api/me` shows the task, and its scope holds no `deal/stonewall` fact because Ben's
   holds none.

## 6. Out of scope here, with owners

| Item | Owner | Why not now |
|---|---|---|
| claude.ai / Claude Desktop custom connector | A | Needs a public URL (Victor's preview deployment) and OAuth on `/mcp`; the pull model cannot inject before every message anyway |
| Supersession of a person's stale own fact ("long 180,000" vs "long 200,000") | B | Triage's relation question and its 0.5 bar; measured today, not yet tuned on live Jev |
| Re-authoring on a paraphrased merge; live-mode churn (merge → new id); sessions ended while the worker is down; duplicate `quarantine.flagged` relay | B | Triage and worker internals (`triage.ts:491`, `worker.ts:174`, `worker.ts:471`); the e2e test uses `SessionEnd` and `canon_save`, which avoid the churn |
| Offline judge's group table (`financeFakeJudge` TOPICS) reads the Falcon ids | B (A may patch) | Should derive from the group list it is given (id words + description), so the offline demo files desk and research lines; the e2e test injects a demo-world judge into the worker meanwhile |
| The writer naming people by id ("Dollar-bill added…"), and restating facts Claude got from injected memory as new facts | B | The writer sees the principal id and has no rule about facts the assistant repeats from provided memory; pass the display name from `GET /api/principals` and add the rule to the prompt |
| `POST /api/agents/:id/stop`, `PATCH /api/agents/:id`, `docs`/`schedule`/`outputs` | B (dispatcher) with C | Agent runtime fields the dispatcher does not have yet |
| Moss credentials, live retrieval check | B / A | `.env` has no `MOSS_PROJECT_ID`/`KEY`; the keyword stub runs, labelled simulated |
| Measured benchmark run (60 attacks, 30 tasks) on live providers | A | Runs once this build lands; numbers go to Devpost |
| Member console UI | C | Builds against the P1 routes above |
| ChatGPT extension read connector | B | First on the cut list |

## Appendix A: live run, Sat 10/24 20:40–20:55 PDT

Fresh data dir, demo world, `JUDGE_PROVIDER` unset (Jev), `ANTHROPIC_API_KEY` set (writer
`claude-sonnet-5-5`), keyword retriever (no Moss key), `DISTILL_LIVE=1`.

| Step | Measured |
|---|---|
| Initial scopes | axe 18 facts / 271 ms; dollar-bill 11 / 174 ms; desk-assistant 4 / 102 ms |
| Capture (SessionEnd, 4 messages) | 200 in under a second |
| Claude writer | 3 drafts in 6342 ms; plan: "Kept the desk's TMC trade, position and trim plan; dropped the vague rumor, assistant arithmetic and the sizing check" |
| Jev triage | 3 drafts against 38 facts and 5 groups in 420 ms; inject 0.20; all 3 → `desk/dollar-bill` |
| Living scopes | 3 joined dollar-bill, 3 joined desk-assistant, 1 joined axe |
| Context hook, next prompt | 4 facts, 83 est. tokens; "What price are we offering…" and a haiku → nothing |
| MCP as dollar-bill | `canon_whoami` `{client, read: [], write: []}`; `canon_context` `facts: []` with a `missing` hint (the gap this PRD closes) |

## Appendix B: open questions for the team

1. **SSE token in the query string** (`/events?token=`): accepted for the demo (localhost, dev
   tokens). Before any public deployment, replace with a short-lived cookie set by `GET /api/me` or
   the preview gateway's signed cookie.
2. **Agent `stop`:** does the dispatcher expose a cancel? If not, `POST /api/agents/:id/stop` returns
   501 with the contract body until it does.
3. **`GET /api/grants` and `GET /health` counts** are open to anyone. Keep for the dashboard in the
   demo; moderator-only after.
