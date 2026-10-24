# Work split: context with walls for small finance teams

**Updated Sat 10/24.** This file defines ownership and build order for `docs/PRD.md`.
`CLAUDE.md` holds the working agreement; `status/status.json` tracks progress.

## Scope

Build on capture, distillation, MCP, Moss, `judge()` and SSE. The product adds entitlements,
restricted and watch lists, permission checks before search, neutral refusals, an audit log,
wall-crossing requests, deal status, Droid dispatch, live routing and output checks.
Edan owns the frontend as well as QA and logistics.

## Stack decision

Keep the **file store + plain SSE** that is already in the repo. A database migration is
outside the current build; extend the file-backed contracts for the finance features. The dashboard can be
Next.js + shadcn/ui inside `web/` if Edan prefers, as long as it reads only the REST and SSE
contract. It never imports server code.

## Lanes

### A · Henry Lai: walls and the handoff pipeline (`server/`, `bench/`)

The security core and the largest lane. Henry has the most Claude usage.

1. **Finance contract, written with Victor in the first hour** (`shared/src/types/`):
   - `wall` label on facts (`public` or a deal id)
   - `Deal` with a status of `confidential`, `announced` or `terminated`
   - `Entitlement` (principal, deal, expiry)
   - restricted and watch lists
   - `AuditEvent`
   - the new SSE events
   - the REST shapes the dashboard needs
2. **Synthetic world, generated early:** Harbor Lane Partners, Project Falcon, Nimbus
   Logistics, Maya, Dan, Priya and Leo, two memos, a week of chat, one transcript, Dan's ChatGPT
   session, and the lawyers' email with the planted instruction. Everyone builds against it, and
   Edan reviews it for realism.
3. **Stub endpoints** that return fixtures from the synthetic world, so B and C never wait.
4. **Entitlements and the permission filter**, deny by default, running before Moss and Jev.
5. **Restricted and watch list checks** and **neutral refusals.** The requester sees the rule,
   compliance sees the full reason, and watch-list names get a blander answer with no reason.
6. **Handoff pipeline:** permission filter → Moss + keyword → Jev relevance → token budget →
   audit log. It includes the "inject nothing" check.
7. **Deal status changes:** announced lifts restrictions, terminated stops work. Both are sent
   as urgent events.
8. **Wall-crossing API:** request, Jev pre-screen on 4 levels, approve or deny with an expiry.
9. **Exit check** on agent outputs: code names and restricted companies in code, indirect
   references via Jev.
10. **Benchmark runner** over the 4 setups (no memory, shared memory, Canon + Claude filter,
    Canon + Jev). It measures leak rate, wrongly-blocked rate, task accuracy, tokens, latency and
    cost.

### B · Victor Chun: capture, triage, agents and the story (`hooks/`, `extension/`, `distiller/`, `docs/`)

1. **Capture:** an ingest client for memos, chat and notes, plus updating the existing Claude
   Code hook and ChatGPT extension for finance capture. The extension is the first capture path to cut.
2. **Jev save-time triage** in the distiller:
   - worth keeping?
   - confidential?
   - which deal (or unsure → compliance queue)?
   - instructions aimed at an AI (→ quarantine)?
   - relation to existing facts (same, replaces, adds detail, contradicts, unrelated)?
3. **Fact writer (Claude).** It sets wall labels with one rule: content can make a fact more
   restricted, never less.
4. **Droid dispatch:** a sandbox folder per agent, `droid exec` at a low permission level, an
   inbox between runs, and every step streamed as an event. This is the core of the Factory
   track.
5. **Live routing:** Jev answers "does agent *k* need this?" and "does it cancel *k*'s work?"
   Wall changes are urgent.
6. **Story:** Devpost draft by 23:59 Sat, video script, the 2-minute pitch, and the sponsor
   README lines.

### C · Edan Wong: frontend, QA and logistics (`web/`, `status/`, `bench/tasks/`)

1. **Control room dashboard:**
   - deals and who is over each wall
   - pending-requests queue with approve and deny buttons
   - live event feed
   - one lane per Droid agent
   - handoff inspector (candidates, Jev's probability for each, what was cut and why, final
     tokens)
   - live token, latency and cost counter
2. **Should ship:** the wall map and the attack box.
3. **Builds against mock SSE and REST fixtures** that follow the finance contract, and switches to
   Henry's server when the endpoints are ready.
4. **Booth answers first thing:** Droid headless runs for non-coding tasks (Factory), Jev
   access (TypeSafe), any cap on sponsor tracks.
5. **Data:** the attack set (50 attempts, 10 per style) and the task set (30 tasks with answer
   keys) in `bench/tasks/`. At least one real quote from a finance or compliance person.
6. **Ops:** QA after each sync, Notability notes, screen recording plus the recorded backup
   demo, Devpost logistics, the final submit, timekeeping.

## Order of operations

1. **First 30 minutes, Henry and Victor:** freeze the finance contract and the event and REST list Edan
   needs. This unblocks everyone.
2. **Then in parallel:**
   - Henry: synthetic world and fixture stubs, then the permission filter
   - Edan: UI on the fixtures
   - Victor: triage, then a Droid spike
3. **Gates:**
   - 09:00 Sat: Jev access confirmed, or switch to the Claude fallback behind `judge()`.
   - 11:00 Sat: Droid runs finance tasks headless, or switch to a Claude Agent SDK runner
     (this drops the Factory track).
4. **Syncs** stay at 09:00, 15:00 and 21:00 Sat: merge to `main`, run the demo end to end, then
   Edan's QA run.
5. **Cut order if behind:** wall map → attack box → quarantine view → Bitdeer → ChatGPT
   extension.

## Implementation handoffs

- A and B freeze the finance contract before consumers adopt new fields. Existing types are the
  implemented interface; the PRD does not make the new fields available automatically.
- A replaces development fixtures with the synthetic finance world as an implementation task.
  C authors benchmark tasks and attacks against that world after the schema supports them.
- C builds the frontend against the agreed mock REST and SSE responses, then switches to A's server.
- Each owner updates their task state in `status/status.json` and regenerates `STATUS.md`.
