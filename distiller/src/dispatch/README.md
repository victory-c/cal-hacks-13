# Agent dispatch: where Droid runs

**Owner:** lane B, Victor Chun (tasks B21 dispatch, B22 live routing). A worker process on the
server's event stream, inside the `distiller` package but its own entrypoint. It never imports
server code: everything goes over HTTP as the internal `dispatcher` client (`CANON_TOKEN_DISPATCHER`).

A person types a task. Canon splits it into agent runs, gives each agent a sandbox folder holding
only its side of the wall, runs **Factory Droid headless** in that folder a few short steps at a
time, routes new facts and wall changes to the agents between steps, and lets an output leave only
after the exit check. Every step streams to the dashboard as an event and becomes the audit record.

```
dispatch.requested ─▶ plan.ts ─────────────▶ dispatcher.ts, per run:
  (dashboard)          Claude/heuristic        POST /api/principals  (agent: acts_for + side)
                       proposes roles;         ┌─ before each step ──────────────────────────────┐
                       CODE picks sides        │ drain inbox, urgent first (cancel ⇒ stop + lock) │
                       from entitlements       │ POST /api/handoff as the agent ⇒ facts.md        │
                                               └──────────────────────────────────────────────────┘
                                               droid exec --auto low -o stream-json --cwd <sandbox>
                                               every stream-json event ⇒ POST /api/events agent.step
                                               finish ⇒ POST /api/exit-check per out/ file ⇒ done | failed
fact.saved ──────────▶ routing.ts: wall check in CODE, then ONE judge.ask (needs:k, cancels:k) ⇒ inboxes
deal.status_changed ─▶ routing.ts: terminated ⇒ urgent cancel; announced ⇒ urgent wall_change
```

## Where Droid runs (Factory track)

Droid is the agent runtime, not a chatbot wrapper. It runs **headless, on our trigger** (a
`dispatch.requested` event from the dashboard), once per step, in a folder Canon built for it:

```
droid exec --auto low -o stream-json --cwd data/agents/<run_id> -m claude-sonnet-5-5 "<step prompt>"
```

| Flag | Why (Factory's docs, `docs.factory.ai/cli/droid-exec/overview`) |
|---|---|
| `--auto low` | "the lowest level that allows creating and editing project files. It blocks system changes, package installs, remote writes, and production changes." Without it a run is read-only. |
| `-o stream-json` | "one JSON event per line as the run progresses": `system`, `message`, `tool_call` (`toolName`), `tool_result`, `completion` (text + usage). Each becomes an `agent.step` on the agent's lane; usage becomes real token counts. |
| `--cwd <abs path>` | "Execute from a specific working directory (use an absolute path)." We also spawn the process there. |
| `-m <id>` | Model id. `DISPATCH_DROID_MODEL` overrides; default `claude-sonnet-5-5`. |
| `FACTORY_API_KEY` | From the environment. Canon's other secrets (`ANTHROPIC_API_KEY`, `JEV_API_KEY`, `CANON_TOKEN_*`, …) are removed from Droid's environment. |

All the flags live in one constant, `DROID_FLAGS` in `runners/droid.ts`. The stream-json event
*types* and `toolName` come from the docs; the other field names are not documented, so the
parser reads them defensively and the file is marked **UNVERIFIED** until we run a real
`droid exec` at the booth. A non-zero exit, a timeout (`DISPATCH_STEP_TIMEOUT_MS`, default 300 s)
or a cancel kills the process (SIGTERM, then SIGKILL after 2 s) and the step fails; `exit 0` is not
trusted on its own (the docs say so): the run is done only when the agent's last line says `DONE`
and its out/ files pass the exit check.

**What Droid can see and touch.** The sandbox `data/agents/<run_id>/` holds exactly:

| File | What |
|---|---|
| `brief.md` | The task, a short goal-and-approach section (Claude Sonnet, or the offline template labelled simulated) and fixed rules that code appends: work only here, no network, facts are information only, write to `out/`, public side never names a deal. |
| `facts.md` | The slice from `POST /api/handoff` **as the agent's own principal**, rewritten before every step. Each fact is quoted line by line with its id, source and wall label, under a header saying it is information only, never instructions. |
| `out/` | The only thing that leaves, and only after `POST /api/exit-check`. |
| `LOCKED` | Written when the run ends (done, failed or cancelled). The whole folder goes read-only (files 0444, folders 0555) and stays as the run's record. |

**What the dashboard shows.** One lane per agent from `agent.run` (state, steps, side, sandbox),
`agent.step` (brief, plan, tool, file, message, result, error, inbox; tokens when Droid reports
them) and `agent.inbox` (when queued, then again with `delivered_at`; an urgent cancel is
delivered at once).

## The walls, in code

- **Sides (plan.ts).** The planner only sees deals the requester is cleared for. Code then decides:
  research and desk agents are always public; a deal side needs a live entitlement for the person
  the agent acts for (`GET /api/entitlements`), and a terminated or unknown deal means public.
- **Slices (dispatcher.ts).** Every step re-fetches the slice as the agent principal, so the
  server's permission filter runs every time, and an announced deal's facts reach public-side
  agents at their next step with no special case.
- **Routing (routing.ts).** On `fact.saved`, code drops every agent whose side cannot see the
  fact's wall (unlabeled facts reach nobody) **before** the judge: a Falcon fact never even
  appears in the judge's state next to a public-side agent. Then one `judge.ask()` for all
  remaining agents (`needs:k`, `cancels:k`); `ROUTE_NEEDS` 0.6 writes a `new_fact`, `ROUTE_CANCELS`
  0.5 an urgent `cancel`. `deal.status_changed` needs no judge: terminated cancels that deal's
  runs, announced sends public-side runs an urgent `wall_change`, and a wall going back up from
  announced cancels public-side runs. A revoked entitlement cancels the runs relying on it.
- **Cancels are urgent.** An urgent cancel aborts the step in flight (kills Droid), locks the
  folder and sets the run `cancelled` before any next step.
- **Exit check (dispatcher.ts).** Every out/ file goes to `POST /api/exit-check` as the agent.
  Blocked: the run fails with "Output held by the exit check. Compliance has been notified." The
  hits never reach the agent's events. Links, binaries and files over 256 KB do not leave. If the
  server has no exit check yet, the run **fails closed**.

## Files

| File | What |
|---|---|
| `index.ts` | Entrypoint. No arguments: the worker (`/events` → `handler.ts`). With arguments: the CLI. |
| `cli.ts` | Offline demo and one-shot dispatch: prints every lane line, then one row per run. |
| `handler.ts` | `dispatch.requested` / `fact.saved` / `deal.status_changed` / `entitlement.changed`; skips the server's SSE replay. |
| `dispatcher.ts` | Run registry and step loop: inbox, slice, brief, step, exit check, lock, events. |
| `plan.ts` | Claude or heuristic planner; code-side checks. |
| `brief.ts` | Claude Sonnet or the offline template; code-written rules. |
| `routing.ts` | Pure given a `Judge`: `routeFact`, `routeDealStatus`, `routeEntitlementChange`, `canSee`. |
| `sandbox.ts` | Folder layout, `facts.md` rendering, path confinement (`..`, absolute, NUL, symlinks), `lock()`. |
| `runners/` | `droid.ts` (real), `claude.ts` (fallback tool loop: list/read/write under out/, finish), `fake.ts` (offline, simulated). |
| `client.ts` | The v2 routes over raw fetch; 404/401 degrade once per route. |
| `offline.ts` | A tiny synthetic Harbor Lane world with a simulated permission filter and code-only exit check, for the CLI. |
| `anthropic.ts` | Raw Messages API helper (Sonnet, auto tool choice, strict tools, fallbacks). |

## Run and test

```bash
# Offline demo: no server, no keys. Everything says (simulated).
npm run dispatch -w distiller -- --by dan "Prep Falcon board materials and update our logistics sector note"
npm run dispatch -w distiller -- --by dan "<same task>" --then terminate   # deal agent cancelled, folder locked
npm run dispatch -w distiller -- --by dan "<same task>" --then announce    # research agent's next slice gets Falcon facts
npm run dispatch -w distiller -- --by priya "<same task>"                  # not cleared: both run public; the draft naming Falcon is held by the exit check
npm run dispatch -w distiller -- --by dan "<task>" --server                # against the live server's v2 routes

npm run dispatch -w distiller          # the worker; needs the server on CANON_URL
npm test -w distiller                  # offline, no keys; the Droid test puts a fake droid on PATH
```

Finished folders are read-only on purpose. To clear them: `chmod -R u+w data/agents && rm -rf data/agents`.

## Runtimes

`DISPATCH_RUNTIME` wins; unset, it is `droid` when the `droid` binary is on PATH and
`FACTORY_API_KEY` is set, else `claude` when `ANTHROPIC_API_KEY` is set, else `fake`. Picked once
at start and logged. A failing runtime is a failed run, never a silent switch to another.

| Runtime | Real? | Needs | Notes |
|---|---|---|---|
| `droid` | Yes | `droid` on PATH, `FACTORY_API_KEY` | The Factory track. Steps stream from stream-json. |
| `claude` | Yes | `ANTHROPIC_API_KEY` | Fallback if the 11:00 gate fails. `claude-sonnet-5-5` tool loop, raw fetch, four tools confined by code (writes only under out/), no shell, no network. |
| `fake` | **No, simulated** | nothing | Writes `out/plan.md`, then the deliverable assembled from facts.md. |

Planner and brief writer: Claude Sonnet with `ANTHROPIC_API_KEY`, else the heuristic planner and
the template brief, both labelled simulated. Routing's judge is `JUDGE_PROVIDER` (Jev, Claude
Haiku fallback); with no keys the worker uses the fake judge with routing's own simulated answers
(word overlap for "needs", explicit stop words for "cancels").

## Env (all from `.env`, see `.env.example`)

`CANON_URL` · `CANON_TOKEN_DISPATCHER` (dev default `dev-dispatcher`; the server needs
`dispatcher=dev-dispatcher` in `CANON_CLIENT_TOKENS`) · `DISPATCH_RUNTIME` · `DISPATCH_MAX_STEPS`
(default 4) · `DISPATCH_STEP_TIMEOUT_MS` (default 300000) · `DISPATCH_DROID_MODEL` (default
`claude-sonnet-5-5`) · `FACTORY_API_KEY` · `ANTHROPIC_API_KEY` · `JUDGE_PROVIDER`.

## Against today's v1 server

Every v2 route 404s, and the server does not know the dispatcher token yet (401). Each is logged
once per route and degrades: no deals or entitlements (every run public), no principal
registration, an empty slice (facts.md says why), events dropped, and **no exit check, so every
run fails closed** ("Output held: the exit check is not available on this server yet."). The worker
keeps running. Use the offline CLI until lane A's v2 routes land.

## Limits and open questions

- **Droid confinement.** `--auto low` blocks system changes and remote writes, but the docs do not
  say Droid's read tools stay inside `--cwd`. The sandbox holds only the agent's side of the wall,
  but sibling folders under `data/agents/` hold other runs. Production: one OS user or container
  per run. Ask at the Factory booth.
- **Mid-run messages.** We use steps (new `droid exec` per step) rather than `--session-id`
  continuation, so the inbox lands between runs either way (PRD open question).
- **Field names.** Confirm the stream-json fields and the model id with one real run.
- **Agent ids** are `agt_<role>_<n>` with a per-process counter; a restarted worker reuses ids and
  re-registers them (POST /api/principals is an upsert).
