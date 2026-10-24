# Bullwark — working agreement

Bullwark (formerly Canon) is the control room for a small finance team's AI. Each person and agent gets only
the context they are cleared to see and need; information barriers stay enforced as deals change.

Read `docs/PRD.md` for product scope, `docs/WORK_SPLIT.md` for ownership and build order, and
`STATUS.md` for progress. The PRD describes the target; package READMEs describe the code that
currently runs. A planned feature is not implemented until its code and validation land.

## Agent context

- Use the current documents above as the source of truth.
- `.archive/` is excluded human tracking material. Do not open, search, summarize, index,
  retrieve through Git history, or use its contents as context unless the user explicitly
  asks to review that material. Do not bypass exclusions through shell commands or scripts.
- Existing source, fixtures and tests describe the working scaffold. They do not expand the
  product scope. Preserve working behavior unless the task calls for an implementation change.

## Team and ownership

| Lane | Owner | Responsibility | Folders |
|---|---|---|---|
| A | Henry Lai | Walls, entitlements, neutral refusals, handoff pipeline, audit log, synthetic-world fixtures, benchmark runner | `server/`, `bench/`; shared contract with B |
| B | Victor Chun | Capture, triage, fact writer, Droid dispatch, live routing, story and sponsor documentation | `hooks/`, `extension/`, `distiller/`, `docs/`; shared contract with A |
| C | Edan Wong | Control room frontend, task and attack sets, QA, finance interviews, sponsor answers and submission logistics | `web/`, `status/`, `bench/tasks/` |

Work in the relevant lane. Coordinate shared interfaces with the affected owners; the user's
explicit task authorization takes precedence over routine lane boundaries.

## Decisions

- Target: small finance teams of 10–50 people. Demo: Harbor Lane Partners, Project Falcon,
  Nimbus Logistics, Maya (compliance), Dan (banker), Priya (research), Leo (trader). All data is synthetic.
- Keep the existing file store and plain SSE. A database migration is outside the current build.
- Keep packages separate over HTTP. The frontend uses REST and SSE and never imports server code.
- Guaranteed capture paths are the Claude Code hook and ingest API; ChatGPT extension is cut first
  if capture work runs late.
- Code enforces access before search or relevance. Jev flags, ranks and pre-screens; compliance
  approves wall-crossings and uncertain labels. Models never grant access.
- Facts retain their sources and history; raw sessions stay in the cold archive.
- Droid runs dispatched finance agents in separate folders containing only permitted context.
  At the 11:00 Saturday gate, use the Claude Agent SDK fallback if Droid cannot do the work.
- At the 09:00 Saturday gate, use the Claude fallback behind `judge()` if Jev access is unavailable.
- Core tracks: Hyphenate, Anthropic, Microsoft and Factory. Add-ons are in the PRD; each must
  do real work before we claim an integration.
- Cut order: wall map → attack box → quarantine view → Bitdeer → ChatGPT extension.

## Architecture and contracts

```text
capture / ingest → cold archive → triage → fact writer → facts with wall labels
request → permission filter → search → relevance → token budget → audit log → permitted slice
dispatch → permitted brief → isolated agent folder → work steps + inbox updates → exit check
REST + SSE → control room, agent lanes, handoff inspector
```

The implemented contracts live in `shared/src/types/`: facts, sessions, MCP inputs and outputs,
events, grants, judge questions and REST bodies. Keep these and their consumers consistent.
`canon_context`, `canon_search`, `canon_save` and `canon_whoami` are the four MCP tools.
`canon_save` queues a captured session for distillation; it does not write directly to hot facts.

Facts currently use markdown frontmatter plus an optional body, stored at
`data/facts/<folder>/<id>.md`; raw sessions are `data/sessions/<id>.json`. The serializer and
validator in `shared/src/fact-file.ts` define the exact format. Folder grants in the scaffold
are not deal entitlements. The wall labels, deals, expiring clearances, lists, audit events and
dashboard APIs described in the PRD must be added and tested before finance access claims are made.

Batch candidate questions into one `judge.ask()` per decision. Apply thresholds in code.
Security uncertainty means restrict or send to compliance; content cannot lower its own label.
Use neutral refusals, quarantine suspected instructions, and check outputs before they cross a wall.

## Run and verify

```bash
npm install                 # Node 22+, see .nvmrc
npm run doctor              # preflight
npm run seed -w server      # optional, existing development fixtures
npm run dev                 # server :4100, distiller, frontend :4200
npm run check               # status validation, workspace typechecks and tests
npm run build               # browser bundles
```

The status board runs on :4173 (`npm run status:board`). Without API keys, the stack uses
labelled simulated providers. Read each package README before changing it; verify provider
settings against `.env.example` and the implementation.

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

- No secrets in Git, chat logs or tracking documents. Credentials come from `.env`.
- Never invent numbers. Quote measured runs only; label estimates and simulated providers.
- The benchmark target is 50 attacks and 30 legitimate tasks across four setups defined in the
  PRD. The existing runner's three strategies do not yet establish finance barrier performance.
- Keep `main` runnable; finish required work before optional views. Keep dependencies few.
- Import shared contracts from `@canon/shared`. Relative TypeScript imports use `.ts` extensions.
- Branch per task: `a/<thing>`, `b/<thing>`, `c/<thing>`. Keep PRs small, run relevant checks,
  and include the task id in the commit. Commit status updates with the work.
- All code is written during the hackathon. Use synthetic data and state what is real in the demo.
