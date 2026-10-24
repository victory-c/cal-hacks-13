# Work split: task-built scopes for small finance teams

**Updated Sat 10/24 (scopes PRD, #14).** This file defines ownership and build order for
`docs/PRD.md`. `CLAUDE.md` holds the working agreement; `status/status.json` tracks progress.

## Scope

Build on capture, distillation, MCP, Moss, `judge()` and SSE. The product adds two tiers
(moderators and members), groups and labels on every fact, scope rules (a task plus optional
exclusions), scopes built by exclusions in code → Moss → Jev and kept current, agent profiles
capped at their creator's scope, quarantine, an audit log, Droid agent runs and live routing.
Nobody is refused: what is outside a scope is simply not in that memory.

**Cut by the scopes PRD:** restricted and watch lists, neutral refusals, wall-crossing requests,
the deal-status workflow and the output exit check. A deal is a group; announcing or ending it is
a moderator editing scope rules.

## Stack decision

Keep the **file store + plain SSE** that is already in the repo. A database migration is
outside the current build; extend the file-backed contracts for the scope features. The dashboard
can be Next.js + shadcn/ui inside `web/` if Edan prefers, as long as it reads only the REST and
SSE contract. It never imports server code.

## Lanes

### A · Henry Lai: server and scopes (`server/`, `bench/`)

The security core and the largest lane. Henry has the most Claude usage.

1. **Scopes contract, with Victor** (`shared/src/types/`, PR #7): principals and tiers, groups
   (a fact's group is its `folder`) and labels, scope rules, scopes, quarantine, audit, the SSE
   events and the REST shapes the dashboard needs.
2. **Synthetic world, generated early:** Harbor Lane Partners, Project Falcon, Nimbus Logistics,
   Maya (moderator), Dan, Priya and Leo (members), two memos, a week of chat, one transcript, Dan's
   ChatGPT session, and the lawyers' email with the planted instruction. Everyone builds against
   it, and Edan reviews it for realism.
3. **Stub endpoints** that return fixtures from the synthetic world, so B and C never wait.
4. **People and tiers:** moderators add people, edit any scope rule and promote members; members
   create only their own agent profiles. No MCP tool or sandbox can change any of it.
5. **Scope builder:** exclusions removed in code → one Moss query → one batched Jev call
   (exclusion yes/no per group and per fact, "maybe" counts as excluded; relevance yes/no per
   fact) → a fixed list of fact ids. Each stage emits its measured time.
6. **Living scopes:** a member's own new facts join their scope; other facts join only if they
   pass the same checks against the original rule; `inbox` and quarantined facts join no member
   scope. A rule edit rebuilds the scope and reaches the member's agents.
7. **Agent profiles:** an agent's scope is built from its creator's scope only, checked in code
   to be a subset at build time and on every update.
8. **Handoff pipeline:** Moss inside the scope (filter by fact id) + keyword → Jev relevance →
   token budget → audit log, with the "inject nothing" check and the pinned profile. Never a
   refusal; `canon_whoami` and the profile show the task, never exclusions or counts.
9. **Moss index** with each fact's id, group and labels as metadata.
10. **Benchmark runner** over the 4 setups (no memory, shared memory, Bullwark + Claude filter,
    Bullwark + Jev). It measures leak rate, missing-context rate, task accuracy, tokens, latency,
    cost and scope build time.

### B · Victor Chun: capture, triage, agents and the story (`hooks/`, `extension/`, `distiller/`, `docs/`)

1. **Capture:** an ingest client for memos, chat and notes, plus the Claude Code hook and the
   ChatGPT extension, each carrying the author (`principal`). The extension is the first capture
   path to cut.
2. **Jev save-time triage** in the distiller, one batched request per item:
   - worth keeping?
   - which group (an existing one, a new one, or unsure → `inbox`)? plus labels where a group is
     too coarse
   - instructions aimed at an AI (→ quarantine)?
   - relation to existing facts (same, replaces, adds detail, contradicts, unrelated)?
3. **Fact writer (Claude):** short facts, one claim each, with source, author and the date it
   happened. Deal names stay verbatim so grouping can see them.
4. **Droid agent runs:** a sandbox folder per run holding only the agent's scope as markdown files,
   `droid exec` at a low permission level, a brief from the most relevant facts, every step
   streamed as an event, and the agent's new facts saved as its creator's memories. This is the
   core of the Factory track.
5. **Live routing:** a fact that joins an agent's scope reaches it at its next step when Jev says
   it needs it now. A narrowed scope discards the run folder and restarts from the plan step in a
   fresh folder.
6. **Story:** Devpost draft by 23:59 Sat, video script, the 2-minute pitch, the scale slide and
   the sponsor README lines.

### C · Edan Wong: frontend, QA and logistics (`web/`, `status/`, `bench/tasks/`)

1. **Moderator console:**
   - people and tiers
   - scope builder (task + exclusions, each stage with its measured time)
   - scope inspector (which facts each person and agent holds, and why)
   - live event feed and quarantine
   - one lane per Droid agent
   - handoff inspector (candidates, Jev's probability for each, what was cut and why, final
     tokens)
   - live token, latency and cost counter
2. **Member view:** my agents, create an agent (same form), my memory.
3. **Should ship:** the scope map and the attack box.
4. **Builds against mock SSE and REST fixtures** that follow the scopes contract, and switches to
   Henry's server when the endpoints are ready.
5. **Booth answers first thing:** Droid headless runs for non-coding tasks (Factory), Jev
   access (TypeSafe), any cap on sponsor tracks.
6. **Data:** the attack set (60 attempts, 10 per style, including agent escalation) and the task
   set (30 tasks with answer keys) in `bench/tasks/`. At least one real quote from a finance or
   compliance person.
7. **Ops:** QA after each sync, Notability notes, screen recording plus the recorded backup
   demo, Devpost logistics, the final submit, timekeeping.

## Order of operations

1. **Henry and Victor:** freeze the scopes contract (PR #7) and the event and REST list Edan
   needs. This unblocks everyone.
2. **Then in parallel:**
   - Henry: synthetic world and fixture stubs, then the scope builder
   - Edan: moderator console and member view on the fixtures
   - Victor: triage into groups, then Droid agent runs
3. **Gates:**
   - 09:00 Sat: Jev access confirmed, or switch to the Claude fallback behind `judge()`.
   - 11:00 Sat: Droid runs finance tasks headless, or switch to a Claude Agent SDK runner
     (this drops the Factory track).
4. **Syncs** stay at 09:00, 15:00 and 21:00 Sat: merge to `main`, run the demo end to end, then
   Edan's QA run.
5. **Cut order if behind:** scope map → attack box → quarantine view → Bitdeer → ChatGPT
   extension.

## Implementation handoffs

- A and B freeze the scopes contract before consumers adopt new fields. Types are not
  enforcement: no access claim is made until the server enforces scopes and it is tested.
- A replaces development fixtures with the synthetic finance world as an implementation task.
  C authors benchmark tasks and attacks against that world after the schema supports them.
- C builds the frontend against the agreed mock REST and SSE responses, then switches to A's server.
- Each owner updates their task state in `status/status.json` and regenerates `STATUS.md`.
