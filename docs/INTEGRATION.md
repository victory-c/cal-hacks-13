# Bullwark ↔ Canon integration contract

**Updated Sat 10/24.** The only interface between [Bullwark](BULLWARK-PRD.md) (the frontend) and
[Canon](CANON-PRD.md) (the agentic backend). Owned jointly by Henry (A, Canon's server side) and Edan
(C, Bullwark's client side); Victor (B) joins for agent events. Types live in `shared/src/types/`
and are imported from `@canon/shared`.

## Implementation status

The integrated server now implements principal-bound REST, MCP and SSE over the file store.
`GET /api/me`, scoped facts and groups, add/edit/retire/refile, people and rules, quarantine,
agent creation/dispatch, handoffs and audit are connected to the moderator and member clients.
People, rules, scopes, agent telemetry, quarantine and audit survive a clean restart. Missing
judge answers fail closed for scope admission and exclusions.

The shared preview login selects a **synthetic demo identity** and keeps its Canon token on the
server. The common team password permits selecting any demo identity; this is team demo access,
not individual employee authentication. Machine clients use their own person-bound bearer token.
The same `CANON_PERSON_TOKEN` serves capture, the before-prompt hook and `.mcp.json`. Sponsor keys
and internal worker tokens stay on the host.

Both new pages default to live Canon, with `?data=mock` explicitly selecting labelled fixtures.
Agents run on demand; automatic schedules, document-type preferences and metadata
editing are not implemented by the dispatcher. The live UI must not promise those controls.
The Docker preview uses the Claude dispatcher because Linux Droid execution has no configured
OS sandbox; Factory remains available for real extraction. A live provider check and an offline
regression suite measure different things; neither establishes the full 360-cell benchmark.

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
| `POST /api/principals` | moderator | Add a person `{ name, tier, rule? }`. Without a rule, the member has no scope or readable memory until Compliance sets one |
| `POST /api/principals/:id/tier` | moderator | Promote or demote `{ tier }` |
| `PUT /api/principals/:id/rule` | moderator; members for their own agents | Moderators set `{ task, exclusions }`. An agent's creator sends `{ task, preserve_exclusions: true, exclude_groups?, exclude_text? }`: `exclude_groups` is their choice among the groups they can see (others are kept as they are), `exclude_text` their leave-out sentence. After a moderator set the rule last, the creator can only add exclusions. Canon preserves hidden moderator barriers and their setter. Starts a build and returns `{ build_id }` |
| `GET /api/principals/:id/scope` | moderator; members for themselves and their agents | The scope: rule and fact ids |
| `GET /api/facts` | anyone | Facts visible to you, filterable by `group`, `label`, `q` |
| `PATCH /api/facts/:id` · `POST /api/facts/:id/retire` | anyone, inside their scope | Edit the statement, or retire to cold storage |
| `POST /api/facts/:id/layer` | a person, inside their scope | Their own memory-layer override `{ layer }`, one of `top`, `background` or `auto`; returns the fact as `GET /api/facts` shows it. Nobody else's view changes |
| `POST /api/facts/:id/file` | moderator | Refile a fact `{ group, labels }` (for example announced terms to `market/public`); affected scopes update and emit `scope.changed` |
| `POST /api/items` | anyone | Add an item `{ kind, source, text, author? }` (kind: memo, chat, email, transcript or note). `author` defaults to you; only moderators may name someone else. Returns `{ item_id }`; Canon then archives, triages and writes facts, and the results arrive as `item.captured`, `item.quarantined` and `fact.saved` events |
| `GET /api/inbox` | moderator | Unplaced facts, filed with `POST /api/facts/:id/file` |
| `GET /api/quarantine` · `POST /api/quarantine/:id/release` | moderator | Held items; release one |
| `GET /api/agents` · `POST /api/agents` | anyone (members see only their own) | List (see `AgentRun` below), or create `{ name, task, exclusions }` inside your own scope; returns `{ id, build_id }`. The member view sends every unticked group of the creator's own as an exclusion |
| `POST /api/agents/:id/run` | the creator or a moderator | Start a run `{ task }`: the agent's standing task or a one-off assignment. Either way it runs inside the agent's fixed scope |
| `POST /api/agents/:id/stop` | the creator or a moderator | Persist a cancellation generation and request Stop; returns `{ status: "stop_requested", generation }`. The lane becomes Stopped after worker cancellation telemetry. |
| `GET /api/agents/:id/control` | internal worker | Read `{ generation }`; dispatcher checks on scope reads and reconnect, so missed Stop events cannot authorize another step or save. |
| `GET /api/handoffs?principal=` · `GET /api/handoffs/:id` | moderator; members for their own agents | Handoff records |
| `GET /api/audit?principal=&group=&since=` | moderator | "Who knew what, when" |
| `GET /health` | anyone | Counts and which providers are real or simulated |

## Shapes

```ts
Principal  { id, kind: "person" | "agent", name, tier?: "moderator" | "member", creator?: id }
Item       { id, kind: "memo" | "chat" | "email" | "transcript" | "note" | "session", source, author, text, captured_at }
Fact       { id, statement, group, labels[], source, author, happened_at, learned_at, status: "hot" | "cold",
             layer: "top" | "background", layer_reason: "current" | "pinned" | "moved" | "past_date" | "idle",
             uses, last_used }   // memory layers, for the caller (server/README.md § Memory layers)
ScopeRule  { task: string, exclusions: { groups[], labels[], text[] } }   // text[] = plain-language exclusions
Scope      { principal, rule: ScopeRule, fact_ids[], built_at }
Handoff    { id, principal, request, candidates[{ fact_id, p, decision: "kept" | "cut_relevance" | "cut_background" | "cut_budget" }],
             tokens_est, timings_ms: { search, judge, total }, judge, retriever, simulated }
AgentRun   { id, creator, name, task, status: "ready" | "running" | "restarting" | "done" | "failed" | "stopped",
             steps[{ id, text, kind, file?, status, at }], files[], inbox[{ text, at }],
             run_task, started_at, finished_at, fact_count,
             memory_groups[{ id, name, included, count }],   // only groups the creator can see
             documents[{ file, title, text, at }],           // what the last run wrote (markdown)
             memories[{ file, text, at }],                   // notes it saved to the creator's memory
             refresh }                                       // a fact behind them left its scope
```

Moderator-set exclusions are visible only to moderators. A member's own `ScopeRule` comes back with
`exclusions` omitted. For an agent they created, creator-set exclusions remain visible; after a
moderator changes the rule, the creator sees the task but not the exclusions and can only edit that
task through `preserve_exclusions: true`, add group exclusions with `exclude_groups` and append a
leave-out sentence with `exclude_text`.

**Agent outputs.** A run's documents and notes come from `agent.step` events of kind `file` that carry
`content` and `fact_ids` (the fact files its folder held). `GET /api/agents` withholds any whose
`fact_ids` are no longer all in the agent's scope and sets `refresh`, naming nothing. An agent writes
notes for its creator's memory to `out/memories/`; the dispatcher posts each one after the step
that wrote it as a `note` session (`principal` = creator, at most 5 a run). Every dispatcher save
carries `meta.agent` and `meta.fact_ids`: `POST /api/sessions` answers 403 when `principal` is not the
agent's creator, and 409 `{ "error": "agent scope changed" }` when one of the ids has left the agent's
scope, checked inside the session write lock; the dispatcher then restarts the run in a fresh folder.

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
| `dispatch.stop_requested` | agent, by, generation | all | — (members refresh from authorized agent telemetry) |

Intermediate `scope.build` counts are redacted to zero for members. The `done` event reports only the
final size of the member's or owned agent's scope, so model-side candidate and exclusion decisions do
not become an existence oracle.

Stop is additive to the shared event contract. Internal worker events and output sessions carry
the run's `stop_generation`; a stale generation cannot publish a new active run or save outputs.
Cancellation telemetry remains accepted so the UI can show completion. Worker cancellation also
covers a request still loading its rule. A later Run observes the new generation and may proceed.

## Changing the contract

- Additive changes (a new optional field, a new event) need a note to the other owner and a fixture update.
- Renaming or removing anything needs both owners' agreement first, then server, fixtures and console
  change together.
- Fixtures for every route and event live with the console in `web/`, built from the synthetic world
  in `fixtures/world/`.
