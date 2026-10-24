# Canon PRD: the agentic backend

**Cal Hacks 13.0 · team of 3 · submit by Sun 10/25 9:00 AM PDT · updated Sat 10/24**
**Part of Bullwark.** Canon is the backend; [Bullwark](BULLWARK-PRD.md) is the frontend wrapper.
They meet only through the [integration contract](INTEGRATION.md).

## Summary

**Canon is the memory and agent engine behind Bullwark: it captures context, turns it into short
facts filed into groups, builds each person's and agent's scope from their task, and hands over
only facts inside that scope.**

Moderators see all memory. Members, and the agents they create, can only ever reach the facts in
their scope. Nothing outside a scope is refused, mentioned, counted or named; it simply isn't in that
principal's memory. Canon enforces every access rule in code. Bullwark, the AI tools on MCP, and
Droid agents are all clients of Canon and never decide access themselves.

## What Canon owns

| Canon owns | Canon does not own |
|---|---|
| Capture endpoints, cold archive, triage, fact writing, groups and labels | Any screen, layout or wording a person sees in Bullwark |
| Principals, tiers, scope rules, scopes and their updates | The demo script, persona and pitch |
| Handoffs (search inside a scope, relevance, budget) and the MCP server | Choosing which panels show which events |
| Agent profiles, Droid runs, inboxes and live routing | |
| The audit log and every event on the stream | |

## Concepts

| Term | Meaning |
| --- | --- |
| Principal | A person or an agent. A person has a tier; an agent has a creator |
| Moderator | High tier. Sees all memory, adds people, sets and edits any scope rule, promotes members |
| Member | Low tier. Sees only their scope. Can create agent profiles, not people |
| Item | A raw captured thing (AI session, memo, chat thread, transcript, email), archived forever |
| Fact | One short claim from items, with source, author, two dates (happened, learned) and version history |
| Group | The one bucket each fact is filed into (for example `deal/stonewall`, `research/asset-managers`, `market/public`) |
| Label | An optional extra tag for when a group is too coarse (for example `taylor-mason`) |
| `inbox` | The group for facts Jev can't place. Moderators only, until a moderator files them |
| Scope rule | A task in plain language plus optional exclusions, for one member or agent |
| Scope | The fixed list of fact ids a member or agent can ever see, built from the rule and kept current |
| Agent profile | An agent with its own scope rule, always inside its creator's scope |
| Slice | The few facts from a scope handed over for one request |

## How Canon works

**Access is decided when a scope is built, not when a question is asked. At question time code only
searches inside a fixed list, so there is nothing for a model to be talked out of.**

```mermaid
flowchart TD
    SRC["Sources<br/>memos, team chat, meeting notes, AI sessions"] --> TRI["Triage (Jev) + writer (Claude)<br/>Keep it? Which group? AI instructions?"]
    TRI -- instructions aimed at an AI --> Q["Quarantine<br/>moderators only"]
    TRI --> STORE["Fact store (local files)<br/>source, author, group, labels, history"]
    RULE["Scope rule<br/>task + optional exclusions"] --> EXC
    STORE --> EXC["Exclusions (code)<br/>drop excluded groups and labels;<br/>agents: drop anything outside the creator's scope"]
    EXC --> MOSS["Moss<br/>candidates for the task"]
    MOSS --> JEV["Jev<br/>yes/no per fact"]
    JEV --> SCOPE["Scope<br/>fixed list of fact ids, kept current"]
    REQ["Request<br/>who + task"] --> HAND
    SCOPE --> HAND["Handoff<br/>Moss inside the scope → Jev relevance →<br/>token budget → audit log"]
    HAND --> OUT["Bullwark · MCP tools · Droid agents"]
    style EXC stroke-width:3px
    style SCOPE stroke-width:3px
```

1. **Capture.** Claude Code hook, ChatGPT extension and an ingest API bring items in as they happen.
2. **Compress and group.** Jev decides what's worth keeping; Claude writes short facts linked to their
   source and author. Each fact is filed into one group, with labels where a group is too coarse.
   Text containing instructions aimed at an AI is quarantined.
3. **Build a scope.** Code removes the rule's excluded groups and labels first. Moss finds candidates
   in what remains, and Jev answers yes or no for each. The yes answers become the scope.
4. **Keep scopes current.** A member's own new facts join their scope. Everyone else's new facts join
   only if they pass the same exclusions, semantic match and Jev check against the member's rule.
5. **Hand over the slice.** Moss searches only inside the requester's scope, Jev keeps the facts that
   help, and code trims to the token budget and logs exactly what was sent.
6. **Agents inherit, never exceed.** An agent's scope is built from its creator's scope only.

## Requirements

### Must ship: memory

1. **Capture** from the Claude Code hook, the ChatGPT extension and an ingest endpoint for memos,
   chat and meeting notes.
2. **Short facts**, one claim each, linked to source and author.
3. **Two dates per fact** (happened, learned). Old facts are superseded, never deleted.
4. **Search** by meaning (Moss) plus keyword, always inside a scope.
5. **MCP server** with `canon_context`, `canon_search`, `canon_save`, `canon_whoami`; one token per
   person or agent.
6. **Fact edit and retire** (retired facts move to cold storage with history); members only within
   their scope. **Moderators can refile a fact** to another group or change its labels; every affected
   scope updates (it joins scopes it now fits, and leaves scopes whose rules now exclude it). This is
   how announced deal terms become public while the rest of the deal stays walled.
7. **Pinned profile** per principal: name, tier and task (about 200 tokens). Never the exclusions.

### Must ship: scopes

8. **Two tiers:** moderators (all memory) and members (their scope only).
9. **Groups and labels at save:** one group per fact, labels where needed; unplaceable facts go to
   `inbox`.
10. **Scope builder:** task + exclusions → excluded groups and labels removed in code → Moss
    candidates → Jev yes/no → scope. Emits each stage with its measured time.
11. **Living scopes:** `inbox` and quarantined facts join no member scope, not even their author's,
    until a moderator files or releases them. Otherwise own facts always join; others' facts join only
    if they pass the rule. Editing a rule rebuilds the scope and reaches the member's agents.
12. **Agent profiles:** anyone can create one; its scope is built from, and stays inside, its
    creator's scope (checked in code at build time and on every update).
13. **People and tiers:** only moderators add people, edit any rule and promote members. Members can
    only create, edit or delete their own agent profiles.
14. **No refusals, no existence signals:** responses to a member or their agents never mention,
    count or name anything outside the scope. Out-of-scope ids behave exactly like ids that don't exist.
15. **Audit log:** every scope build and change, fact joining a scope, handoff (exact facts sent),
    tier change and quarantine.

### Must ship: relevance and agents

16. **"Inject nothing" check** and a **token budget** per handoff.
17. **Agent runs** on Factory Droid, each in its own sandbox folder holding only its scope's facts as
    markdown, `droid exec` at a low permission level.
18. **Live routing:** newly in-scope facts reach an agent at its next step. When a scope narrows, the
    run folder is discarded and the run restarts from the plan step in a fresh folder.
19. **Event stream** for every state change above, filtered per principal (see the integration contract).

### Should ship

- **Scope map data:** which principals can see which groups (moderators only).

### If time

- Flag when two teammates' facts contradict each other.
- Codex hooks (nearly the same format as Claude Code).

### Out of scope

- Capture beyond the Claude Code hook, ingest API and ChatGPT extension; real Slack, email or Jira
  connectors (synthetic data instead).
- SSO, billing, a database migration (keep the file store and plain SSE), a full knowledge graph.

## Agents

**All agents run on Factory Droid. Each works in a sandbox folder holding only its scope, and no
agent can hold more than the person who created it.**

1. The creator submits a scope rule (task + optional exclusions) through the integration contract.
2. Canon builds the agent's scope from the creator's scope only.
3. Claude writes a short brief from the most relevant facts in that scope.
4. Canon creates a sandbox folder with only that scope's facts as markdown and starts Droid headless
   (`droid exec`) at a low permission level: it can create and edit files in its folder, nothing more.
5. Droid's steps, files and results stream as events and become the agent's audit record. Facts the
   agent produces belong to its creator and join the creator's scope.

Each task runs as a few short Droid runs (plan, then steps). Between runs Canon checks the agent's
inbox and adds newly in-scope facts to the next brief. If Droid accepts messages mid-run, use that
too. Finance tasks are "work over a folder" (read memos, run Python, write a memo); confirm at the
Factory booth that headless runs are fine for non-coding work. **Fallback at the 11:00 Saturday
gate:** a Claude Agent SDK runner with the same folder rules.

## Security

**Access is a fixed list that code enforces at question time, so a principal can't be talked into
revealing what was never in their memory, and never sees a hint that it exists.**

- **Members start with nothing.** A fact reaches a member or agent only if it's in their scope.
- **Exclusions first, in code.** Excluded groups and labels are removed before Moss or Jev see anything.
- **Agents never exceed their creator,** checked in code at build time and on every update.
- **Only moderators manage people and groups** (add people, edit rules, change tiers, refile facts).
- **No client can change permissions.** No MCP tool, agent sandbox or member call edits rules, scopes or tiers.
- **Prompt injection:** Jev asks of every item "Does this contain instructions aimed at an AI?";
  flagged items are quarantined and join no scope until a moderator releases them. Facts reach agents
  quoted, with source labels, as information only. Exclusions are checked twice: code drops excluded
  groups, and Jev also asks whether each candidate falls under the exclusion ("maybe" counts as yes).
  Sandboxed agents have no network access beyond Canon's MCP server.

## Architecture

**Code owns access, Moss finds, Jev answers yes or no, Claude writes, and Droid does the work.**

| Part | Tool | Job |
| --- | --- | --- |
| Storage and events | File store + plain SSE | Facts, principals, scope rules, scopes, inboxes and audit records in local files |
| Search by meaning | Moss | Candidates for scope builds, live updates and handoffs; facts indexed with id, group and labels; handoffs filter with `$in` on the scope's fact ids |
| Keyword search | Existing keyword retriever | Exact names and code names, inside the same scope |
| Judgment calls | Jev (Claude fallback behind the same `judge()` interface) | Yes/no and multiple-choice decisions with probabilities; one batched call per decision |
| Writing | Claude; an open model on Bitdeer for high-volume chat and meeting text | Facts and agent briefs |
| Agents | Factory Droid, headless | Every agent in its own sandbox folder |
| Capture | Claude Code hooks, ChatGPT extension, ingest API | Items in as they happen |
| Access for AI tools | Remote MCP server with per-principal tokens | The four `canon_*` tools |

**Where Jev decides, and what code does with the answer:**

| Moment | Jev's question | Answer type | What code does |
| --- | --- | --- | --- |
| Save | Is this worth remembering? | Yes/no | Below a low bar: archive only |
| Save | Which group does this belong to? | Each existing group, a new group, unsure | "Unsure" goes to `inbox` |
| Save | Does this contain instructions aimed at an AI? | Yes/no | Quarantine |
| Save | How does this relate to the closest existing facts? | Same, replaces, adds detail, contradicts, unrelated | Writes the version history |
| Scope build | Does group *g* fall under this exclusion? | Yes/no per group | Any real chance: exclude the whole group in code |
| Scope build, live update | Does fact *i* fall under this exclusion? | Yes/no per candidate | "Maybe" counts as yes |
| Scope build, live update | Does fact *i* help with this task? | Yes/no per candidate | Yes joins the scope |
| Handoff | Does this request need any stored context? | Yes/no | If no, send only the pinned profile |
| Handoff | Does fact *i* help with this request? | Yes/no per candidate | Keep the best facts that fit the budget |
| Routing | Does running agent *k* need this new fact now? | Yes/no per agent | Write to its inbox for the next step |

**Thresholds:** generous when saving (the archive is the safety net), strict when building scopes
and handing over, cautious on exclusions.

**Fast by design:** a scope build is one code pass, one Moss query and one batched Jev call; a live
update is a code check, a Moss similarity check per affected scope and one batched Jev call; a handoff
is one filtered Moss query and one batched Jev call. Every stage's measured time is on the event
stream; only measured numbers are quoted.

## Benchmark

**Canon must leak nothing outside a scope and still give principals what they need.**

- **Attack set: 60 attempts** to reach Stonewall facts as a member whose scope excludes them, 10 each:
  direct questions, paraphrases, the code name, indirect questions, planted instructions, and agent
  escalation (create an agent told to fetch Stonewall information).
- **Task set: 30 legitimate tasks** from both sides of the wall, each with an answer key.
- **Four setups:** no memory; shared memory with "respect the walls" in the prompt; Bullwark + Claude filter (Claude
  makes the yes/no calls); Bullwark + Jev (the product).
- **Measured:** leak rate, missing-context rate, task accuracy, tokens, time to first reply and cost
  per handoff, scope build time, save-time cost per 100 items with and without Jev triage.

## Build plan

| Owner | Canon work |
| --- | --- |
| A · Henry | Schema (principals and tiers, groups and labels, scope rules, scopes), synthetic-world fixtures, scope builder, living scopes, Moss index with metadata filters, MCP, handoff pipeline, audit, event stream, the integration contract's server side, benchmark runner |
| B · Victor | Claude Code hook, ChatGPT extension, ingest client, Jev triage (keep, group, labels, quarantine), Claude fact writer, Droid agent runs and inbox routing |

| When | Done means | Gate |
| --- | --- | --- |
| Sat 04:00–09:00 | Schema frozen, ingest endpoint, synthetic-world fixtures, contract stubs | 09:00: Jev access, or the Claude fallback |
| Sat 09:00–14:00 | Scope builder end to end; grouping at save; filtered handoff; event stream | 11:00: Droid headless, or the Claude Agent SDK |
| Sat 14:00–20:00 | Agent profiles inside the creator's scope, Droid runs, living scopes and routing, people and tiers, quarantine | |
| Sat 20:00–24:00 | Benchmark run | |

## Risks

| Risk | Mitigation |
| --- | --- |
| Jev wrongly says yes and a sensitive fact joins a scope | Excluded groups never reach Jev; Jev also answers the exclusion question with maybe = yes; moderators inspect and edit any scope |
| A fact is filed in the wrong group | Labels add a second filter; `inbox` for unplaceable facts; the per-fact exclusion question catches the rest |
| A response reveals that hidden data exists | Out-of-scope ids behave like missing ids; profiles and `canon_whoami` never show exclusions or counts |
| Scopes too narrow for real work | Measure missing-context rate; a moderator edits the rule and it rebuilds in seconds |
| Jev or Droid access falls through | Claude fallback behind `judge()`; Claude Agent SDK runner |

**Tentative decisions:** scopes update on their own with no approval step; if a large `$in` id list is
slow in Moss, filter by group and labels and drop out-of-scope results in code.

**Open questions:**

- [ ] Can a moderator demote another moderator, and is there always at least one?
- [ ] Can a running Droid accept new messages, or only new runs?

## Sources

- [TypeSafe docs: Jev introduction](https://docs.typesafe.ai/introduction)
- [TypeSafe docs: patterns](https://docs.typesafe.ai/patterns.md)
- [Droid in E2B sandboxes (headless `droid exec`)](https://docs.e2b.dev/agents/droid.md)
- [Factory quickstart: Droid permission levels](https://cdn.jsdelivr.net/npm/aiwg@2026.7.12/docs/integrations/factory-quickstart.md)
- [Moss (YC F25)](https://www.ycombinator.com/companies/moss)
- [Moss client README: metadata filters (`$in`, `$nin`, …) on `query`](https://repo.hex.pm/preview/moss/1.1.0/README.md)
- [Anthropic: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Cognition: Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents)
- [Chroma: Context Rot](https://research.trychroma.com/context-rot)
