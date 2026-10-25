# Bullwark ↔ Canon integration contract

**Updated Sat 10/24.** The only interface between [Bullwark](BULLWARK-PRD.md) (the frontend) and
[Canon](CANON-PRD.md) (the agentic backend). Owned jointly by Henry (A, Canon's server side) and Edan
(C, Bullwark's client side); Victor (B) joins for agent events. Types live in `shared/src/types/`
and are imported from `@canon/shared`.

## Implementation status

**Sat 10/24, branch `a/claude-code-loop`.** The server answers this contract for person and agent
tokens. The routes and the member stream are in `server/src/contract.ts`; the operations they alias
(scope rules, agents, dispatch) are in `server/src/scopes.ts`; the shapes are in
`shared/src/types/api.ts` and `events.ts`. A token is a person or an agent when its grant names a
principal. Only the default `DEMO_GRANTS` (`shared/src/types/grants.ts`) bind tokens to principals
(`wags`, `axe`, `ben`, `dollar-bill`); with `CANON_GRANTS_FILE` set, `loadGrants()`
(`server/src/auth.ts`) drops `principal` from every entry. Operator tokens (the distiller, the
dispatcher, a capture token with no principal) and tokenless callers keep the scaffold's folder
routes and shapes, so the dashboard, the distiller and the bench are unchanged. The preview team
login protects the deployment; it does not establish a principal. Tested in
`server/src/loop.test.ts`, `scopes.test.ts` and `event-visibility.test.ts`.

### Implemented for person and agent tokens

| Contract | Server today |
| --- | --- |
| `GET /api/me` | `{ id, kind, name, tier?, creator?, task?, firm? }`: `tier` for a person, `creator` for an agent, `task` from the scope rule, `firm` from the world. Never the exclusions. An operator token gets `404 { "error": "this token is not a person or agent" }`. |
| `GET /api/facts` | The caller's scope (a moderator: every hot fact; an agent token: the agent's scope) in the `Fact` shape, plus `detail`, `source_kind` and `source_title` when the archived item still has them. `?group=` matches by prefix (`deal` covers `deal/stonewall`), `?label=` one label, `?q=` a case-insensitive substring of the statement or detail. A moderator may add `?status=cold`. |
| `GET /api/groups` | Members and agents: `{ groups: [{ id, display }] }` for the groups their scope has a fact in; `display` from the world, else the id's last segment humanized (`market/public` → `Public`). Moderators and internal clients get the full `GroupsResponse` with descriptions and aliases. |
| `POST /api/items` | `{ kind, source, text, author? }`; `kind` is memo, chat, email, transcript or note. Becomes one captured session (`client: "ingest"`, `principal` = the caller; an agent's item belongs to its creator). Any person or agent token may set `author` to its own principal (an agent's creator). Naming anyone else needs a moderator (403 otherwise); an unknown author is 404. Returns `{ item_id }` (the session id) and emits `item.captured`; the distiller triages it and the facts arrive as `fact.saved`. Person and agent tokens only: an operator token gets 404 (no route). |
| `PATCH /api/facts/:id` | `{ statement }`; same id, `learned_at` today. Returns the fact in the contract shape, emits `fact.saved`, writes audit `fact.edited`. Outside the scope: 404 with the same bytes as a missing fact. |
| `POST /api/facts/:id/retire` | Status → cold, history kept. Returns `{ ok: true }`, emits `fact.retired` with `superseded_by: ""`, writes audit `fact.retired`; the living-scope listener takes the fact out of every scope. Outside the scope: 404. |
| `GET /api/agents` | `{ agents: [{ id, creator, name, status, steps, files, inbox, task, fact_count, pending, finished_at, leave_out, docs, schedule, outputs }] }` (`AgentSummary` in `shared/src/types/api.ts`, written by `listAgents` in `server/src/contract.ts`): the caller's own agents, every agent for a moderator. Only `fact_count` is live (the length of the agent's scope). The rest are static placeholders until the dispatcher reports a run: `status` is `"ready"`, `steps`, `files`, `inbox`, `docs` and `outputs` are empty, `pending` is `0`, `finished_at` is `null`, `leave_out` is `""` and `schedule` is `"Only when I press Run"`. |
| `POST /api/agents` | Accepts the contract body `{ name, task, exclusions }` and the scaffold's `{ created_by, name, rule }`. The creator is the caller; a member creating for anyone else, or an agent token, gets one constant 403. The reply is the agent's `Principal` plus `build_id`, so `id` and `build_id` are both in it. A failed build leaves no agent. |
| `POST /api/agents/:id/run` | The creator or a moderator; anyone else gets one constant 403 whether the agent exists or not. Emits `dispatch.requested` and returns `{ id }` (the dispatch id). The body is not read: the agent runs the task in its own rule. Same operation as the server's `POST /api/dispatch`. |
| `PUT /api/principals/:id/rule` | A moderator, or the creator for their own agent; anyone else gets `403 { "error": "moderators only" }` before any lookup. `exclusions.groups` may end in `/*`; `exclusions.text[]` is joined with `; ` into the server's one `exclude.text`. The scope is rebuilt first and the rule stored only when the build succeeds; a person's agents are then rebuilt from the new scope. Returns `{ build_id }`. Same operation as the server's `PUT /api/scope-rules/:id`, which returns the rule plus `build_id`. |
| `GET /events?token=` | The token may ride in the query string because `EventSource` cannot set headers; same authorization as the header, and the query string is never logged. A moderator's token gets the whole stream minus the distiller's raw extraction plans; a member's or agent's token gets the member stream below. The last 100 events replay; a heartbeat comment every 15 s. |

### The member stream

`memberEventView` in `server/src/contract.ts` writes a person's or agent's stream from the server's
own events. `server.started` always passes. Nothing else does: no triage, quarantine, audit or refile
events, no exclusion text, no count of anything hidden.

| Member receives | When | Written from |
| --- | --- | --- |
| `item.captured` `{ item_id, kind, source, author }` | the session's principal is the caller: a capture, a pasted item or a `canon_save` | `session.captured` |
| `fact.saved` `{ fact, decision }` | the fact is in the caller's scope, or it is the caller's own hot fact in a world group that no code-level exclusion removes (with a plain-language exclusion the stream waits for the join). `supersedes` stays only when the previous fact is in scope; the triage behind the decision is dropped | `fact.saved` |
| `fact.retired` `{ id, superseded_by }` | the caller authored the fact, or the successor is in their scope. `superseded_by` is `""` when a person retired it | `fact.retired` |
| `scope.build` `{ build_id, principal, stage, ms, counts: { remaining } }` | the caller or one of their agents is being built; `stage` is `exclusions` · `candidates` · `judged` · `done`; `remaining` counts inside the caller's view | `scope.stage` |
| `scope.changed` `{ principal, added, removed }` | the caller's scope or one of their agents' changed | `scope.updated` |
| `distill.started` · `distill.finished` (no `plan`) | the caller's own session | same names |
| `principal.changed` `{ principal, change, by }` | the caller or one of their agents | same name |
| `dispatch.requested` · `agent.run` · `agent.step` · `agent.inbox` | the agent is the caller's; `agent.step` and `agent.inbox` pass once the run's `agent.run` was seen on this stream | `dispatch.requested`: the server itself (`requestDispatch` in `server/src/scopes.ts`) on `POST /api/dispatch` and `POST /api/agents/:id/run`; it is not in `RELAYED_EVENTS`, and `POST /api/events` answers 400 for it. The three `agent.*` events: the dispatcher, relayed through `POST /api/events` |
| `handoff.served` with `candidates: []` | one of the caller's agents was served (what was considered is moderators-only; the field is kept and emptied) | same name |
| `context.served` | the serving client is the caller's own token | same name |

### Not implemented, and who owns it

| Contract item | Status |
| --- | --- |
| `POST /api/agents/:id/stop` · `PATCH /api/agents/:id` · the `docs`, `schedule` and `outputs` fields | Lane B's dispatcher. `stop` and `PATCH` are not routed: `router.ts`, `scopes.ts`, `contract.ts` and `app.ts` import none of the untracked `moderator.ts`, `agent-runs.ts` and `handoffs.ts`. `docs`, `schedule` and `outputs` are on every `GET /api/agents` row today as static values (`docs: []`, `schedule: "Only when I press Run"`, `outputs: []`), together with `fact_count`, `pending`, `finished_at` and `leave_out`; nothing fills them yet. Open: if the dispatcher has no cancel, `stop` returns 501 with the contract body until it does ([PIPELINE-PRD](PIPELINE-PRD.md) Appendix B). |
| `agent.started` · `agent.restarted` · `agent.finished` | Not emitted under these names. The dispatcher relays `agent.run` (with the run's `state`), `agent.step` and `agent.inbox`; the server adds `dispatch.requested` when a run is asked for. |
| `GET /api/inbox` | Not implemented. Inbox facts are `GET /api/facts?group=inbox` as a moderator. `POST /api/facts/:id/file` is implemented (moderator): it emits `fact.filed` to moderators and `scope.changed` to the members whose scopes change. |
| `item.quarantined` | The server's name is `quarantine.flagged` `{ session_id, quarantine_id, p, excerpt }`, moderators and internal clients only. `GET /api/quarantine` → `{ items }` and `POST /api/quarantine/:id/release` are implemented; release is 409 when already released. |
| `principal.added` · `principal.tier` | The server's name is `principal.changed` `{ principal, change, by }`, `change` = `added` · `tier_changed` · `agent_created` · `agent_deleted`. Members also receive it for themselves and their own agents. |
| `GET /api/handoffs?principal=` · `GET /api/handoffs/:id` | Not implemented (lane A). Moderators read `GET /api/audit?principal=&since=` and the `handoff.served` event. A person's own slice is `POST /api/handoff` with their token, without `candidates`; it is `HandoffResult` (`facts, profile, tokens, latency_ms, inject_nothing, audit_id`), not the `Handoff` record above. |
| `GET /api/principals/:id/scope` | Not under this path. `GET /api/scopes/:id` and `GET /api/scopes/:id/facts` exist for moderators and internal clients; a member cannot read their own fact-id list yet (lane A). |
| `POST /api/principals` `{ name, tier }` | Implemented, moderator-only, but the body is `{ id, name, tier, rule? }`: the server needs the person's id (lowercase first name) and a member needs a `rule`. `POST /api/principals/:id/tier` matches the contract. |
| `GET /api/audit?group=` | `principal` and `since` filter; `group` does not (lane A). |

### Open question: the token in the query string

`/events?token=` is accepted for the demo only: localhost and dev tokens. Before any public
deployment, replace it with a short-lived cookie set by `GET /api/me` or the preview gateway's
signed cookie ([PIPELINE-PRD](PIPELINE-PRD.md) Appendix B).

### Measured, Sat 10/24

Live run on the demo world: real Jev, Claude fact writer (`claude-sonnet-5-5`), keyword retriever
standing in for Moss (no Moss key; the server labels it). Capture as the person token → 200. The
writer produced 3 drafts in 3858 ms (an earlier run: 6342 ms); Jev triage took 243 ms (earlier
420 ms). The 3 facts, filed in `desk/dollar-bill` with author `dollar-bill`, joined Dollar Bill's
scope and his desk assistant's. The next prompt through the context hook ("What is our TMC position
now…") got 1 fact, 22 estimated tokens; "What price are we offering for Taylor Mason…" added
nothing. Claude Code's own non-interactive run (`claude -p`) loaded the project `.mcp.json` with
`CANON_PERSON_TOKEN` exported, called `canon_whoami` (`{ client, principal, name, tier, task }`, no
`read` or `write`) and `canon_context` (3 facts, all inside his scope).

## Five rules

1. **Canon decides, Bullwark shows.** Canon owns all state and every access decision. Bullwark never
   filters data for security, only for layout.
2. **Two channels.** REST for reads and commands, server-sent events (SSE) for anything live. Bullwark
   never imports Canon code. (AI tools use Canon's MCP server; Bullwark does not.)
3. **Your token is who you are.** Every call carries `Authorization: Bearer <token>`, and each token
   maps to exactly one principal. Canon answers as that principal sees the world: a moderator's token
   sees everything, a member's token sees only their scope and their own agents.
4. **Outside a scope means it doesn't exist.** For a member, an out-of-scope fact, group or agent
   returns `404` exactly like a missing one. No response or event mentions, counts or names anything
   outside the caller's scope.
5. **Same shapes for mocks.** Bullwark's fixtures follow this contract exactly, so switching from mock
   data to Canon is one setting.

## REST

All routes are on Canon (`http://localhost:4100` in development). Errors are `{ "error": string }`.
`401` = missing or unknown token. `403` = a member calling a moderator-only action (it reveals
nothing, because the action itself is public knowledge). `404` = not found or not in your scope.

| Route | Who | Does |
| --- | --- | --- |
| `GET /api/me` | anyone | Your principal: id, name, tier, and your task (never your exclusions) |
| `GET /api/principals` | moderator | People and agents with tier or creator |
| `POST /api/principals` | moderator | Add a person `{ name, tier }` |
| `POST /api/principals/:id/tier` | moderator | Promote or demote `{ tier }` |
| `PUT /api/principals/:id/rule` | moderator; members for their own agents | Set a scope rule `{ task, exclusions }`; starts a build and returns `{ build_id }` |
| `GET /api/principals/:id/scope` | moderator; members for themselves and their agents | The scope: rule and fact ids |
| `GET /api/facts` | anyone | Facts visible to you, filterable by `group`, `label`, `q` |
| `PATCH /api/facts/:id` · `POST /api/facts/:id/retire` | anyone, inside their scope | Edit the statement, or retire to cold storage |
| `POST /api/facts/:id/file` | moderator | Refile a fact `{ group, labels }` (for example announced terms to `market/public`); affected scopes update and emit `scope.changed` |
| `POST /api/items` | anyone | Add an item `{ kind, source, text, author? }` (kind: memo, chat, email, transcript or note). `author` defaults to you; only moderators may name someone else. Returns `{ item_id }`; Canon then archives, triages and writes facts, and the results arrive as `item.captured`, `item.quarantined` and `fact.saved` events |
| `GET /api/inbox` | moderator | Unplaced facts, filed with `POST /api/facts/:id/file` |
| `GET /api/quarantine` · `POST /api/quarantine/:id/release` | moderator | Held items; release one |
| `GET /api/agents` · `POST /api/agents` | anyone (members see only their own) | List, or create `{ name, task, exclusions }` inside your own scope; returns `{ id, build_id }` |
| `POST /api/agents/:id/run` | the creator or a moderator | Start a run `{ task }` |
| `GET /api/handoffs?principal=` · `GET /api/handoffs/:id` | moderator; members for their own agents | Handoff records |
| `GET /api/audit?principal=&group=&since=` | moderator | "Who knew what, when" |
| `GET /health` | anyone | Counts and which providers are real or simulated |

The [Implementation status](#implementation-status) section says which rows the server answers today
for person and agent tokens, under which path, and what the reply adds beyond the shapes below:
`GET /api/facts` also returns `detail`, `source_kind` and `source_title` when it has them;
`POST /api/agents` returns the agent's `Principal` with `build_id`; `POST /api/agents/:id/run`
returns `{ id }` and does not read the body.

## Shapes

```ts
Principal  { id, kind: "person" | "agent", name, tier?: "moderator" | "member", creator?: id }
Item       { id, kind: "memo" | "chat" | "email" | "transcript" | "note" | "session", source, author, text, captured_at }
Fact       { id, statement, group, labels[], source, author, happened_at, learned_at, status: "hot" | "cold" }
ScopeRule  { task: string, exclusions: { groups[], labels[], text[] } }   // text[] = plain-language exclusions
Scope      { principal, rule: ScopeRule, fact_ids[], built_at }
Handoff    { id, principal, request, candidates[{ fact_id, p, decision: "kept" | "cut_relevance" | "cut_budget" }],
             tokens_est, timings_ms: { search, judge, total }, judge, retriever, simulated }
AgentRun   { id, creator, name, status: "running" | "restarting" | "done" | "failed",
             steps[{ id, text, status, at }], files[], inbox[{ text, at }] }
```

Moderator-set exclusions are visible only to moderators. A member's own `ScopeRule` comes back with
`exclusions` omitted; for agents they create, they see only the exclusions they added themselves.

## Events (SSE on `GET /events`)

Each event is `event: <type>` plus JSON with `type`, `at` and the fields below. Canon replays the last
100 events to a new subscriber and sends a heartbeat every 15 s.

| Event | Fields | Moderators | Members |
| --- | --- | --- | --- |
| `item.captured` | item id, source, author | all | own items |
| `item.quarantined` | item id, source, reason | all | — |
| `fact.saved` | fact (full) | all | only if it joins their scope |
| `fact.filed` | fact id, group, labels | all | — |
| `scope.build` | build id, principal, stage (`exclusions` · `candidates` · `judged` · `done`), stage ms, counts | all | own agents' builds |
| `scope.changed` | principal, added fact ids, removed fact ids | all | self and own agents |
| `principal.added` · `principal.tier` | principal | all | — |
| `agent.started` · `agent.step` · `agent.inbox` · `agent.restarted` · `agent.finished` | agent id, run fields | all | own agents |
| `context.served` | handoff id, principal, kept count, tokens_est, timings | all | own agents |

Counts in `scope.build` are counts *within the requester's view*: for a member's agent, candidates come
from the member's own scope, so no count reveals anything outside it.

The server writes these names into a person's or agent's stream only. Moderators and internal
clients receive its own names (`scope.stage`, `scope.updated`, `session.captured`,
`principal.changed`, `quarantine.flagged`, `agent.run`); the mapping, and the names not emitted yet,
are under [Implementation status](#implementation-status).

## Changing the contract

- Additive changes (a new optional field, a new event) need a note to the other owner and a fixture update.
- Renaming or removing anything needs both owners' agreement first, then server, fixtures and console
  change together.
- Fixtures for every route and event live with the console in `web/`, built from the synthetic world
  in `fixtures/world/`.
