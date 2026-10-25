# Bullwark — working agreement

Bullwark is the control room for a small finance team's AI. Moderators see everything; every other
person and agent gets a memory that holds only what their task needs. Anything else simply isn't
there: nobody is refused, and nothing hints that hidden data exists. It has two parts: **Bullwark**,
the product and its frontend, and **Canon**, the agentic backend. They meet only through the
integration contract.

Read `docs/BULLWARK-PRD.md` (product and frontend), `docs/CANON-PRD.md` (agentic backend) and
`docs/INTEGRATION.md` (the contract between them) for product scope, `docs/PIPELINE-PRD.md` for
what the end-to-end loop still needs (measured state, gaps, owners), `docs/WORK_SPLIT.md` for
ownership and build order, and `STATUS.md` for progress. The PRDs describe the target; package
READMEs describe the code that currently runs. A planned feature is not implemented until its code and validation land.

## Agent context

- Use the current documents above as the source of truth.
- `.archive/` is excluded human tracking material. Do not open, search, summarize, index,
  retrieve through Git history, or use its contents as context unless the user explicitly
  asks to review that material. Do not bypass exclusions through shell commands or scripts.
- `docs/history/` records abandoned designs for humans. It is tracked in Git, but do not read,
  search, summarize or use it as context unless the user explicitly asks to review the project's
  history. Following it would bring back cut features.
- Existing source, fixtures and tests describe the working scaffold. They do not expand the
  product scope. Preserve working behavior unless the task calls for an implementation change.

## Team and ownership

| Lane | Owner | Responsibility | Folders |
|---|---|---|---|
| A | Henry Lai | Tiers and principals, groups and scope rules, scope builder, living scopes, handoff pipeline, audit log, benchmark runner | `server/`, `bench/`; shared contract with B |
| B | Victor Chun | Capture, triage and grouping, fact writer, Droid agent runs, live routing, story and sponsor documentation | `hooks/`, `extension/`, `distiller/`, `docs/`; shared contract with A |
| C | Edan Wong | Moderator console and member view, the synthetic demo world, task and attack sets, QA, finance interviews, sponsor answers and submission logistics | `web/`, `status/`, `bench/tasks/`, `fixtures/world/` |

Work in the relevant lane. Coordinate shared interfaces with the affected owners; the user's
explicit task authorization takes precedence over routine lane boundaries.

## Decisions

- Target: small finance teams of 10–50 people. Demo: Axe Capital (a 30-person hedge fund), Project
  Stonewall (Axe Capital's bid for its rival Taylor Mason Capital), Wags (COO and compliance,
  moderator), Axe (founder, deal lead), Ben Kim (research), Dollar Bill (portfolio manager). All data is synthetic.
- Keep the existing file store and plain SSE. A database migration is outside the current build.
- Keep packages separate over HTTP. Bullwark's frontend talks to Canon only through
  `docs/INTEGRATION.md` (REST and SSE) and never imports server code.
- Guaranteed capture paths are the Claude Code hook and ingest API; ChatGPT extension is cut first
  if capture work runs late.
- Access is decided when a scope is built: exclusions remove whole groups and labels in code, then
  Moss finds candidates and Jev answers yes or no. A scope is a fixed list of fact ids; at question time
  code searches only inside it. Only moderators add people, edit scope rules or change tiers. Agents
  never exceed their creator's scope. Models never grant access. No refusals, no existence signals.
- Facts retain their sources and history; raw sessions stay in the cold archive.
- Droid runs every agent in its own folder holding only its scope's facts as markdown.
  At the 11:00 Saturday gate, use the Claude Agent SDK fallback if Droid cannot do the work.
- At the 09:00 Saturday gate, use the Claude fallback behind `judge()` if Jev access is unavailable.
- Core tracks: Hyphenate, Anthropic, Microsoft and Factory. Add-ons are in the PRD; each must
  do real work before we claim an integration.
- Cut order: scope map → attack box → quarantine view → Bitdeer → ChatGPT extension.

## Architecture and contracts

```text
capture / ingest → cold archive → triage → fact writer → facts filed into one group (+ labels)
scope rule (task + exclusions) → exclusions in code → Moss candidates → Jev yes/no → scope (fact ids)
new fact → exclusions + Moss + Jev against each member's original rule → joins scopes it fits
request → search inside the scope → Jev relevance → token budget → audit log → slice
agent profile → scope inside its creator's → sandbox folder → steps + inbox → restart on narrowing
REST + SSE → moderator console, member view, agent lanes, handoff inspector
```

The implemented contracts live in `shared/src/types/`: facts, sessions, MCP inputs and outputs,
events, grants, judge questions and REST bodies. Keep these and their consumers consistent.
`canon_context`, `canon_search`, `canon_save` and `canon_whoami` are the four MCP tools.
`canon_save` queues a captured session for distillation; it does not write directly to hot facts.

Facts currently use markdown frontmatter plus an optional body, stored at
`data/facts/<folder>/<id>.md`; raw sessions are `data/sessions/<id>.json`. The serializer and
validator in `shared/src/fact-file.ts` define the exact format. A fact's `folder` is its group
(`deal/stonewall`, `market/public`, `inbox`). The scopes contract (A1) adds `scopes.ts`
(tiers, principals, groups, scope rules, scopes, quarantine, audit), `agents.ts` (agent runs,
steps, inboxes), optional `labels`, `author` and `happened` on facts, and the scope events and
REST bodies. Folder grants in the scaffold are not scopes, and types are not enforcement: access
claims rest on the server's tested scope builder, scope filtering and audit, and the console APIs
in `docs/INTEGRATION.md` must be added and tested the same way.

The scaffold worker may include optional `distillation: { session_id, engine, plan?, duration_ms }`
in `POST /api/facts`. Only the internal `distiller` client may attribute a run; successful writes
emit `distill.finished`. Raw plans are limited to the internal worker stream; other subscribers
receive only extraction metadata. This is extraction telemetry, not the planned scoped-agent run contract.

Batch candidate questions into one `judge.ask()` per decision. Apply thresholds in code.
Security uncertainty means exclude: a "maybe" on an exclusion counts as yes, and a fact Jev can't
place goes to the moderators-only `inbox` group. Quarantine suspected instructions. Never refuse or
mention, count or name anything outside a scope; `canon_whoami` shows the task, never the exclusions.

## Run and verify

```bash
npm install                 # Node 22+, see .nvmrc
npm run doctor              # preflight
npm run seed -w server      # optional, existing development fixtures
npm run reset -w server     # back to the demo world at 0:00
npm run dev                 # server :4100, distiller, dispatcher, frontend :4200
npm run check               # status validation, workspace typechecks and tests
npm run build               # browser bundles
```

The status board runs on :4173 (`npm run status:board`). Without API keys, the stack uses
labelled simulated providers. Read each package README before changing it; verify provider
settings against `.env.example` and the implementation. A person sets `CANON_PERSON_TOKEN` in
`.env` (and exports it for the MCP header); the committed Claude Code hooks and `.mcp.json` use it
in both directions, and `npm run doctor` checks it.

## Deadlines and coordination (PDT)

| When | What |
|---|---|
| Sat 10/24 09:00, 15:00, 21:00 | Sync, merge, full demo run, Edan's QA |
| Sat 10/24 23:59 | Devpost draft |
| Sun 10/25 07:00 | Code freeze; only demo-breaking fixes afterward |
| Sun 10/25 08:30 | Target final submission |
| Sun 10/25 09:00 | Hard deadline |
| Sun 10/25 10:30–12:30 | Judging; whole team at the table |

Update your task's state and note in `status/status.json`, bump `updated`, and run
`node status/sync.mjs`. Add new tasks with the next unused id in the owner's lane. Keep completed
work recorded accurately. Do not edit generated `STATUS.md` by hand. Edan maintains blockers.

## Engineering and submission rules

- No secrets in Git, chat logs or tracking documents. Credentials come from `.env` for development or gitignored `.env.preview` for the Docker preview.
- Never invent numbers. Quote measured runs only; label estimates and simulated providers.
- The benchmark target is 60 attacks (10 per style, including agent escalation) and 30 legitimate
  tasks across four setups defined in the PRD, measuring leak and missing-context rates. The existing
  runner's three strategies do not yet establish finance barrier performance.
- Keep `main` runnable; finish required work before optional views. Keep dependencies few.
- Import shared contracts from `@canon/shared`. Relative TypeScript imports use `.ts` extensions.
- Branch per task: `a/<thing>`, `b/<thing>`, `c/<thing>`. Keep PRs small, run relevant checks,
  and include the task id in the commit. Commit status updates with the work.
- All code is written during the hackathon. Use synthetic data and state what is real in the demo.
