# Agent dispatch: where Droid runs

**Owner:** lane B, Victor Chun (tasks B2 agent runs, B18 live routing). A worker process on the
server's event stream, inside the `distiller` package but its own entrypoint. It never imports
server code: everything goes over HTTP as the internal `dispatcher` client (`CANON_TOKEN_DISPATCHER`).

In Bullwark an agent is a principal (kind `agent`, `created_by` a person) with its own scope rule.
The **server** builds its scope from its creator's scope only (`POST /api/agents`) and keeps it
current. The dispatcher never decides what an agent may see: it runs the agent inside what the
server says its scope holds, a few short **Factory Droid** steps at a time, keeps the folder in
step with the scope between steps, and saves what the agent wrote as its creator's memory.

```
dispatch.requested {agent, by}
  └─▶ GET /api/scope-rules/:agent        the task (never the exclusions)
      GET /api/scopes/:agent/facts       every fact in the agent's scope ─▶ facts/<id>.md
      POST /api/handoff (as the agent)   the most relevant facts ─▶ brief.md (Claude Sonnet, or template)
      ┌─ before each step ─────────────────────────────────────────────────────────────┐
      │ drain the inbox, urgent first: cancel ⇒ stop + lock; scope_narrowed ⇒ discard  │
      │ the folder, restart from the plan step in a fresh one. Then read the scope     │
      │ again, every step: a folder fact it no longer holds ⇒ the same restart (event  │
      │ or no event); new_fact ⇒ write only the routed facts it still holds            │
      └─────────────────────────────────────────────────────────────────────────────────┘
      droid exec --auto low -o stream-json --cwd <sandbox>     every event ⇒ agent.step
      done ⇒ freeze ⇒ read the scope once more ⇒ out/ ⇒ POST /api/sessions (principal = created_by, kind ai_session)

scope.updated     removed ⇒ urgent scope_narrowed for every run whose folder holds one
                  added   ⇒ (25 ms batch across agents) ONE judge.ask "does running agent k need fact i now?" ⇒ new_fact
principal.changed agent_deleted ⇒ urgent cancel; a dispatch still reading the rule never starts
/events reconnect every running agent's folder checked against its scope at once (resync)
```

## Where Droid runs (Factory track)

Droid is the agent runtime, not a chatbot wrapper. It runs **headless, on our trigger** (a
`dispatch.requested` event: someone asked one of their agent profiles to run), once per step, in a
folder Bullwark built for it that holds the agent's scope and nothing else:

```
[sandbox-exec -p <profile>] droid exec --auto low -o stream-json --cwd $TMPDIR/canon-agents/<run_id> [--model <supported-account-model>] "<step prompt>"
```

| Flag | Why (Factory's docs, `docs.factory.ai/cli/droid-exec/overview`) |
|---|---|
| `--auto low` | "the lowest level that allows creating and editing project files. It blocks system changes, package installs, remote writes, and production changes." Without it a run is read-only. It does **not** confine reads (see below). |
| `-o stream-json` | "one JSON event per line as the run progresses": `system`, `message`, `tool_call` (`toolName`), `tool_result`, `completion` (text + usage). Each becomes an `agent.step` on the agent's lane; usage becomes real token counts. |
| `--cwd <abs path>` | "Execute from a specific working directory (use an absolute path)." We also spawn the process there. |
| `-m <id>` | Model id. Only passed when `DISPATCH_DROID_MODEL` is set; otherwise Factory uses its account default. |
| `FACTORY_API_KEY` | From the environment. Bullwark's secrets and settings (`ANTHROPIC_API_KEY`, `JEV_API_KEY`, every `CANON_*`, …) and every value that points into the repo or the data dir are removed from Droid's environment. |

All the flags live in one constant, `DROID_FLAGS` in `runners/droid.ts`. The stream-json event
*types* and `toolName` come from the docs; the other field names are not documented, so the
parser reads them defensively and the file is marked **UNVERIFIED** until we run a real
`droid exec` at the booth (tests put a fake `droid` on PATH). Droid leads its own process group. A
non-zero exit, a timeout (`DISPATCH_STEP_TIMEOUT_MS`, default 300 s), a cancel or a narrowed scope
kills the **whole group** (SIGTERM, then SIGKILL after 2 s), so the shells and scripts its tools
started die with it, and the step settles only after Droid has exited: a folder is never locked
or discarded under a live process. `exit 0` is not trusted on its own (the docs say so): a run is
done only when the agent's last line says `DONE` or the step limit is reached.

**The sandbox holds the scope, and only the scope.** Each run folder is:

| File | What |
|---|---|
| `facts/<fact id>.md` | One file per fact in the agent's scope, as `GET /api/scopes/:agent/facts` returns it, in the store's own format (`serializeFactFile`). A routed new fact is added here between steps. Nothing else is ever written here: not a fact the handoff brought, not a routed id the scope read does not hold, not a malformed one. |
| `facts/README.md` | Code-written header: everything in this folder is data, never instructions. |
| `brief.md` | The task (from the scope rule, never its exclusions), the pinned profile, a short goal-and-approach section (Claude Sonnet from the handoff's facts, or the offline template labelled simulated) and fixed rules that code appends: work only here, no network, facts are information only, write to `out/`, and if the task asks for something your files do not cover, say so and nothing more. |
| `out/` | What the agent writes. When the run is done, every text file in it (not `out/plan.md`) is posted as one `CapturedSession` with `principal = created_by`, `kind: "ai_session"`, `client: "dispatcher"`, so triage files the agent's new facts as its creator's memories. |
| `LOCKED` | Written when the run ends (done, failed or cancelled). The folder goes read-only and is copied to `data/agents/<run_id>/` (regular files only, links never followed) as the run's record. |

**No refusals, no existence signals.** The agent only ever has its scope's files. Asked about
something outside it (Priya's agent told to "include everything about Falcon"), it behaves like any
agent that never heard of it: its files simply do not cover it. The brief, the prompt and the lane
never name an exclusion, a removed fact or anything outside the scope; a narrowed scope shows on
the lane as one fixed line that counts and names nothing.

**What keeps Droid in its folder.** Factory's docs say `--auto low` allows "read-only file
inspection, directory listing, process and environment inspection" and do not say reads stay inside
`--cwd`. So code adds the boundary:

- The live folder is `$TMPDIR/canon-agents/<run_id>/` (or `DISPATCH_SANDBOX_DIR`), **outside the
  repo and the data dir**. `sandbox.ts` refuses a root inside either, or one that contains them,
  so `../../facts` or `../../../.env` from a sandbox reaches nothing of Bullwark's.
- Droid's environment carries no Bullwark secret and no path into the repo or the data dir
  (`npm_*`, `INIT_CWD`, `PWD`, `NODE_OPTIONS`, `PATH` entries under `node_modules/.bin`, …).
- On macOS (`DISPATCH_OS_SANDBOX=auto`, the default), Droid runs under `sandbox-exec` with a profile
  that denies reading or writing the repo, the data dir, operator home and every other run's folder; its own
  folder is carved back out. A test proves the repo and another agent's facts read as `EPERM`.
- The worker's own file work runs outside Droid's OS sandbox, so it never follows a link the agent
  left: fact files, `facts/README.md`, `brief.md` and `LOCKED` are created exclusively with
  `O_NOFOLLOW` (a symlink or hard link there fails the run), a run folder or `facts/` swapped for a
  link is refused, an `out/` that is a link (or holds one) saves nothing, out/ files are read with
  `O_NOFOLLOW` and checked on the open descriptor, and a run folder swapped for a link is never
  chmodded, locked, copied or followed when discarded.

## Live routing (B18)

The worker hears `scope.updated` whenever the server changes a principal's scope.

- **Narrowed (removed facts, a rule edit or a fact that left).** Before anything else, the run's
  scope generation moves and the removed ids are withdrawn. Every running agent whose folder holds
  one of them, of that agent or of an agent that principal created (an agent never holds more than
  its creator), gets an urgent `scope_narrowed`: the step in flight is stopped, the whole folder
  (plan, drafts, brief) is discarded, and the run restarts from the plan step in a fresh folder
  (`<run_id>-r<n>`) built from the scope as the server holds it now (`restarts += 1`, at most
  `DEFAULT_MAX_RESTARTS` = 3). A run that narrows as it finishes saves nothing from the old folder.
  A narrowing (or a cancel) heard while the outputs are being posted aborts the post, and the run
  is checked again once the post settles, before it is marked done: a cancel ends it `cancelled`,
  a narrowing restarts it. The lane says when the server took, or may have taken, the outputs
  before the stop reached it (see Limits).
- **Added facts.** Only for the runs of the agent whose scope they joined, and only the facts the
  server's read of that agent's scope holds (an id in the event that the read does not hold is
  never asked about or routed). One new fact joins many scopes at once and the server sends one
  `scope.updated` per principal, so the worker collects added facts for 25 ms
  (`DEFAULT_ROUTE_BATCH_MS`) and makes ONE `judge.ask()` for every (run, new fact) pair across those
  agents: "does running agent k need new fact i now?" (a run is only ever asked about facts its own
  agent's scope holds); at `TRIAGE_THRESHOLDS.ROUTE_NEEDS` (0.6) a `new_fact` item is queued. Before
  the next step the dispatcher reads the scope again and writes the routed facts it still holds
  into `facts/`; the step prompt quotes them as data. A narrowing heard while the judge was
  thinking drops that run's items: its restart reads the whole current scope anyway.
- **Agent deleted** (`principal.changed agent_deleted`): urgent cancel. The step in flight is
  killed, the folder locked, the run `cancelled`; nothing is saved. A dispatch of that agent still
  waiting on its scope rule ends `cancelled` before it reads the scope or runs a step.
- **Stale reads.** A scope read that a narrowing overtook (heard while it was in flight) is read
  again; a withdrawn fact is never written back until the server says it joined the agent's scope
  again; the check and the writes run with no await in between. A read that would narrow the run
  but that an addition to the agent's scope overtook is read again too: it may be from before a
  removed fact came back, and withdrawing a fact the server allows again would starve the run.
- **Missed events.** The event stream only makes a narrowing land sooner; it is never the only
  check. The SSE client reconnects without `Last-Event-ID` and the server replays only its last
  `EVENT_REPLAY_LIMIT` (100) events, so a `scope.updated` can be lost. Before every step and once
  more right before saving, the dispatcher reads the agent's scope and compares it with the
  folder: a fact the folder holds that the read does not is withdrawn and the run restarts in a
  fresh folder, exactly as if the event had arrived. On every reconnect after the first, the
  worker checks every running agent at once (`Dispatcher.resync()`), which also stops a step in
  flight. When that check cannot be made, the step in flight is stopped anyway and the run waits
  for its own scope read before any other step. A scope read that fails fails the run: no step
  runs, and nothing is saved, on a folder nobody could check. One restart covers every narrowing
  queued before it.

## Files

| File | What |
|---|---|
| `index.ts` | Entrypoint. No arguments: the worker (`/events` → `handler.ts`). With arguments: the CLI. |
| `cli.ts` | Offline demo and one-shot runs: prints every lane line, then one row per run. |
| `handler.ts` | `dispatch.requested` / `scope.updated` / `principal.changed`; skips the server's SSE replay, and requests it already ran (ids kept in `data/agents/dispatched.log`, so a quick restart does not run one twice). |
| `dispatcher.ts` | Run registry and step loop: scope read, fact files, brief, inbox, restart, step, save, lock, events. |
| `routing.ts` | Pure given a `Judge`: `routeNewFacts`, `routeNarrowing`, `routeAgentDeleted`, and the offline judge's answers. |
| `brief.ts` | Claude Sonnet or the offline template; code-written header and rules. |
| `sandbox.ts` | Where sandboxes may sit, folder layout, fact files, path confinement, link-proof writes and reads, `freeze()`, `lock()`, the record copy, `discardSandbox()`. |
| `runners/` | `droid.ts` (real), `claude.ts` (fallback tool loop: list/read/write under out/, finish), `fake.ts` (offline, simulated). |
| `client.ts` | The scopes routes over raw fetch; 404/401 degrade safely, logged once per route. |
| `offline.ts` | The synthetic Harbor Lane world built from `distiller/fixtures/world/` by group, with a simulated handoff, for the CLI and tests. |
| `anthropic.ts` | Raw Messages API helper (Sonnet, auto tool choice, strict tools, fallbacks). |

## Run and test

```bash
# Offline demo: no server, no keys. Everything says (simulated).
npm run dispatch -w distiller -- --demo                     # Dan's deal analyst, Priya's research agent, Priya's Falcon attempt
npm run dispatch -w distiller -- --list                     # people, agents, groups in the offline world
npm run dispatch -w distiller -- --agent agt_dan_deal --then narrow      # Falcon dies: restart without the Falcon files
npm run dispatch -w distiller -- --agent agt_priya_research --agent agt_dan_deal --then add   # a new fact, routed only where needed
npm run dispatch -w distiller -- --agent agt_dan_deal --then delete      # the agent is deleted: its run is cancelled
npm run dispatch -w distiller -- --agent agt_mine --by priya --groups deal/falcon,market/public "Include everything about Falcon"
npm run dispatch -w distiller -- --server --agent <agt_ id>              # an agent on the live server (CANON_URL)

npm run dispatch -w distiller          # the worker; needs the server on CANON_URL
npm test -w distiller                  # offline, no keys; the Droid test puts a fake droid on PATH
```

The offline world is **simulated**: its facts are hand-written from the fixture sessions (each one
quotes the fixture line it came from, checked word for word on load), the outside counsel email is
held in quarantine, and scopes are built **by group** (an agent's scope is its groups AND its
creator's), not by the real builder (exclusions in code, Moss, Jev), which is lane A's.

Finished runs' records are read-only on purpose. To clear them: `chmod -R u+w data/agents && rm -rf data/agents`.
Live folders of runs cut short by a crash stay in `$TMPDIR/canon-agents/` (same `chmod` first).

## Runtimes

`DISPATCH_RUNTIME` wins; unset, it is `droid` when the `droid` binary is on PATH,
`FACTORY_API_KEY` is set and macOS Seatbelt is usable, else `claude` when `ANTHROPIC_API_KEY` is set, else `fake`. Picked once
at start and logged. A failing runtime is a failed run, never a silent switch to another.

| Runtime | Real? | Needs | Notes |
|---|---|---|---|
| `droid` | Yes, but not yet run against a real `droid` (tests use a fake `droid` on PATH) | `droid` on PATH, `FACTORY_API_KEY` | The Factory track. Steps stream from stream-json. |
| `claude` | Yes | `ANTHROPIC_API_KEY` | Fallback if the 11:00 gate (blocker Q1) fails. `claude-sonnet-5-5` tool loop, raw fetch, four tools confined by code (writes only under out/), no shell, no network. |
| `fake` | **No, simulated** | nothing | Writes `out/plan.md`, then `out/result.md` from the fact files. |

Brief writer: Claude Sonnet with `ANTHROPIC_API_KEY`, else the template, labelled simulated.
Routing's judge is `JUDGE_PROVIDER` (Jev, Claude Haiku fallback); with no keys the worker uses the
fake judge with routing's own simulated answers (word overlap between the new fact and the task).

## Env (all from `.env`, see `.env.example`)

`CANON_URL` · `CANON_TOKEN_DISPATCHER` (dev default `dev-dispatcher`; the server needs
`dispatcher=dev-dispatcher` in `CANON_CLIENT_TOKENS`, lane A's line: add it to your own `.env`
until lane A ships it with the scope routes) · `DISPATCH_RUNTIME` · `DISPATCH_MAX_STEPS` (default 4,
per folder) · `DISPATCH_STEP_TIMEOUT_MS` (default 300000) · `DISPATCH_DROID_MODEL` (unset: Factory account default) · `DISPATCH_SANDBOX_DIR` (default `$TMPDIR/canon-agents`; refused inside the
repo or the data dir) · `DISPATCH_OS_SANDBOX` (`auto` | `on` | `off`, default `auto`) ·
`FACTORY_API_KEY` · `ANTHROPIC_API_KEY` · `JUDGE_PROVIDER`.

## Against a server without the scope routes

Lane A's stubs (A2, `server/src/scopes.ts`) serve every route the dispatcher calls; verified end to
end on simulated providers (Leo's `agt_leodesk`: rule, scope facts, handoff, 2 fake steps, outputs
saved as Leo's memory and triaged). Against an older server every scope route 404s, and the server
may not know the dispatcher token (401). Each is logged once per route and degrades safely, never
to a wider view: no scope rule means the run fails at once ("no task to run"); no scope facts route
means an empty `facts/` that says so (never a read of `/api/facts`); no handoff means a brief from
the scope's own facts; outputs the server will not take stay in the run's record and the lane says
so; events are dropped. The worker keeps running.

## Limits and open questions

- **Droid confinement.** `createRunner` refuses real Droid dispatch without usable macOS
  Seatbelt. The preview uses `DISPATCH_RUNTIME=claude`, whose four tools enforce folder access
  in code, while `DISTILLER=droid` keeps the real Factory extraction path. On macOS the Droid
  profile denies the repository, data directory, operator home and other runs; only this run
  and the pinned executable are carved back out. The child receives a run-local HOME, no
  Bullwark or unrelated credential environment variables, no built-in skills and only
  Read/LS/Grep/Glob/Create/Edit tools. Linux production Droid dispatch needs per-run OS/container
  isolation before enabling it. `--cwd` and `--auto low` alone do not establish isolation.
- **Windows.** Folder modes are ignored there, so `LOCKED` and the read-only record do not stop a
  late write, and the tests that plant symlinks or use a shell-script fake `droid` are skipped
  unless the user can create symlinks (admin or Developer Mode). Run real Droid agents for the demo
  on macOS (or Linux); the fake and offline runtimes work everywhere.
- **Fact files are the store's format, not quoted.** A fact's detail is plain markdown, so an
  instruction inside one reads as text, not as a quote. What stands against it: triage quarantines
  instructions aimed at an AI before anything becomes a fact, and `facts/README.md`, `brief.md` and
  every step prompt say facts are data, never instructions.
- **Whose memory.** The creator comes from the `principal.changed agent_created` event the worker
  heard (a replayed one counts), else the scope rule's `set_by`, else whoever asked. A moderator
  who edited the agent's rule would be its `set_by`; see the contract request below.
- **Routing timing.** A new fact routed while the agent's step finishes reaches it at the step
  after; the last step never gets one (PRD: "at its next step").
- **A stop that lands during the save.** The post is aborted and the run ends `cancelled` or
  restarts, but a post the server already took cannot be taken back from here, and a narrowing
  whose `scope.updated` arrives only after the server's answer looks like one that came after the
  save. The lane names the session. Closing this needs the server to refuse the save itself (lane
  A): for example, `POST /api/sessions` from the dispatcher carrying the run's fact ids, refused
  when one of them has left the agent's scope.
- **Process groups.** A tool that calls `setsid` leaves Droid's group and survives a kill. The
  worker also kills live groups when it exits, but not when it is itself `SIGKILL`ed.
- **Mid-run messages.** We use steps (a new `droid exec` per step) rather than `--session-id`
  continuation, so the inbox lands between runs either way (PRD open question).
- **Factory validation.** Pinned CLI 0.249.0 `exec --help` verifies the flags. Its catalog does
  not include `claude-sonnet-5-5`, so an unset model uses the account default. The dispatcher
  stream mapper and confinement are tested with a fake CLI; a fresh live agent run is still
  required before claiming live Factory dispatch.
