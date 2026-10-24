# Work split: task-built scopes for small finance teams

**Updated Sat 10/24.** This file defines ownership and build order for `docs/BULLWARK-PRD.md` (the
product and frontend, lane C plus B's story), `docs/CANON-PRD.md` (the agentic backend, lanes A and B)
and `docs/INTEGRATION.md` (the contract between them, A and C). `CLAUDE.md` holds the working
agreement; `status/status.json` tracks progress.

## Scope

Build on capture, distillation, MCP, Moss, `judge()` and SSE. The product adds two tiers
(moderators and members), groups and labels on facts, scope rules, the scope builder (exclusions in
code → Moss candidates → Jev yes/no), living scopes, agent profiles that never exceed their creator,
handoffs that search only inside a scope, an audit log, Droid agent runs and live routing. Nobody is
refused. Edan owns the frontend as well as QA and logistics.

## Stack decision

Keep the **file store + plain SSE** that is already in the repo. A database migration is outside
the current build; extend the file-backed contracts for principals, groups, scope rules and scopes.
The dashboard can be Next.js + shadcn/ui inside `web/` if Edan prefers, as long as it reads only the
REST and SSE contract. It never imports server code.

## Lanes

### A · Henry Lai: server and scopes (`server/`, `bench/`)

The security core and the largest lane. Henry has the most Claude usage.

1. **Contract, written with Victor in the first hour** (`shared/src/types/`):
   - principals (person or agent) with a tier, and each agent's creator
   - one `group` and optional `labels` on every fact; the moderators-only `inbox` group
   - `ScopeRule` (task in plain language + exclusions) and `Scope` (fixed list of fact ids)
   - `AuditEvent`, and the REST routes and SSE events in `docs/INTEGRATION.md`
2. **Stub endpoints** that return data from Edan's synthetic world (`fixtures/world/`), so B and C
   never wait. Seed Canon's store from its items.
3. **Scope builder:** excluded groups and labels removed in code, then Moss candidates, then one
   batched Jev yes/no call. Shows each stage and its measured time.
4. **Living scopes:** a member's own facts always join their scope; others' facts join only if they
   clear the exclusions, the semantic match and Jev against the member's original rule. `inbox` and
   quarantined facts join no member scope. Editing a rule rebuilds the scope and reaches the
   member's agents.
5. **People and tiers:** moderators add people, edit any scope rule and promote members; members can
   only create agent profiles. Agent scopes are checked in code to be a subset of the creator's, at
   build time and on every update.
6. **Moss index with metadata filters:** facts indexed with id, group and labels; handoffs filter
   with `$in` on the scope's fact ids.
7. **Handoff pipeline:** search inside the scope (Moss + keyword) → Jev relevance → token budget →
   audit log, with the "inject nothing" check and the pinned profile (name, tier, task; never the
   exclusions).
8. **Audit log:** every scope build and change, fact joining a scope, handoff, tier change and quarantine.
9. **Benchmark runner** over the 4 setups (no memory, shared memory, Bullwark + Claude filter,
    Bullwark + Jev). It measures leak rate, missing-context rate, task accuracy, tokens, latency,
    cost and scope build time.

### B · Victor Chun: capture, triage, agents and the story (`hooks/`, `extension/`, `distiller/`, `docs/`)

1. **Capture:** an ingest client for memos, chat and notes, plus the existing Claude Code hook and
   ChatGPT extension. The extension is the first capture path to cut.
2. **Jev save-time triage** in the distiller:
   - worth keeping?
   - which group (each existing group, a new group, or unsure → `inbox`)?
   - labels where the group is too coarse
   - instructions aimed at an AI (→ quarantine)?
   - relation to existing facts (same, replaces, adds detail, contradicts, unrelated)?
3. **Fact writer (Claude):** one claim per fact, linked to its source and author.
4. **Droid agent runs:** a sandbox folder per agent holding only its scope's facts as markdown,
   `droid exec` at a low permission level, an inbox between runs, and every step streamed as an
   event. This is the core of the Factory track.
5. **Live routing:** newly in-scope facts reach an agent at its next step. When a scope narrows, the
   agent's run folder is discarded and the run restarts from the plan step in a fresh folder.
6. **Story:** Devpost draft by 23:59 Sat, video script, the 2-minute pitch, and the sponsor README lines.

### C · Edan Wong: frontend, QA and logistics (`web/`, `status/`, `bench/tasks/`, `fixtures/world/`)

1. **Moderator console:**
   - people and tiers
   - scope builder (task + exclusions, each stage with its measured time)
   - scope inspector (which facts each person and agent holds, and why)
   - live event feed and quarantine
   - one lane per Droid agent
   - handoff inspector (candidates, Jev's probability for each, what was kept and cut, final tokens)
   - live token, latency and cost counter
3. **Member view:** my agents, create an agent (same form, inside my scope), my memory.
4. **Should ship:** the scope map and the attack box.
5. **Builds against mock fixtures** that follow `docs/INTEGRATION.md`, and switches to Henry's
   server when the endpoints are ready.
6. **Booth answers first thing:** Droid headless runs for non-coding tasks (Factory), Jev access
   (TypeSafe), any cap on sponsor tracks.
7. **Data:** the attack set (60 attempts, 10 per style including agent escalation) and the task set
   (30 tasks with answer keys) in `bench/tasks/`. At least one real quote from a finance or
   compliance person.
8. **Ops:** QA after each sync (nothing outside a scope is ever mentioned, counted or named),
   Notability notes, screen recording plus the recorded backup demo, Devpost logistics, the final
   submit, timekeeping.

## Order of operations

1. **First 30 minutes, Henry and Victor:** freeze the contract (tiers, groups, scope rules, scopes)
   and the event and REST list Edan needs. This unblocks everyone.
2. **Then in parallel:**
   - Henry: stub endpoints on the synthetic world, then the scope builder
   - Edan: synthetic world, then the console on fixtures built from it
   - Victor: triage and grouping, then a Droid spike
3. **Gates:**
   - 09:00 Sat: Jev access confirmed, or switch to the Claude fallback behind `judge()`.
   - 11:00 Sat: Droid runs finance tasks headless, or switch to a Claude Agent SDK runner
     (this drops the Factory track).
4. **Syncs** stay at 09:00, 15:00 and 21:00 Sat: merge to `main`, run the demo end to end, then
   Edan's QA run.
5. **Cut order if behind:** scope map → attack box → quarantine view → Bitdeer → ChatGPT extension.

## Implementation handoffs

- A and B freeze the contract before consumers adopt new fields. Existing types are the implemented
  interface; the PRD does not make the new fields available automatically.
- C owns the synthetic world in `fixtures/world/`; A seeds Canon from it and retires the old
  development fixtures. C authors benchmark tasks and attacks against that world after the schema
  supports them.
- C builds the frontend against the agreed mock REST and SSE responses, then switches to A's server.
- Each owner updates their task state in `status/status.json` and regenerates `STATUS.md`.
