# Bullwark ↔ Canon integration contract

**Updated Sat 10/24.** The only interface between [Bullwark](BULLWARK-PRD.md) (the frontend) and
[Canon](CANON-PRD.md) (the agentic backend). Owned jointly by Henry (A, Canon's server side) and Edan
(C, Bullwark's client side); Victor (B) joins for agent events. Types live in `shared/src/types/`
and are imported from `@canon/shared`.

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
| `GET /api/inbox` | moderator | Unplaced facts, filed with `POST /api/facts/:id/file` |
| `GET /api/quarantine` · `POST /api/quarantine/:id/release` | moderator | Held items; release one |
| `GET /api/agents` · `POST /api/agents` | anyone (members see only their own) | List, or create `{ name, task, exclusions }` inside your own scope; returns `{ id, build_id }` |
| `POST /api/agents/:id/run` | the creator or a moderator | Start a run `{ task }` |
| `GET /api/handoffs?principal=` · `GET /api/handoffs/:id` | moderator; members for their own agents | Handoff records |
| `GET /api/audit?principal=&group=&since=` | moderator | "Who knew what, when" |
| `GET /health` | anyone | Counts and which providers are real or simulated |

## Shapes

```ts
Principal  { id, kind: "person" | "agent", name, tier?: "moderator" | "member", creator?: id }
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

## Changing the contract

- Additive changes (a new optional field, a new event) need a note to the other owner and a fixture update.
- Renaming or removing anything needs both owners' agreement first, then server, fixtures and console
  change together.
- Fixtures for every route and event live with the console in `web/`, built from the synthetic world.
