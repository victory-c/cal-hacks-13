# Scale slide: Bullwark

**Owner:** Victor (task B13). One slide: how Bullwark goes from a small team to a company version,
and what of it runs today. The tiers come from the scale path in [`PRD.md`](PRD.md) ("Competitors
and positioning"). It is used at 1:55 in the live pitch ([`PITCH.md`](PITCH.md)), as shot S15 in
the video ([`VIDEO_SCRIPT.md`](VIDEO_SCRIPT.md)), and as the "scale slide" the Microsoft track
asks for. Build statuses come from [`SPONSORS.md`](SPONSORS.md); change them there first.

**Rules for this slide**

- Only the small-team column runs today, and only in part. The other two columns carry a
  "design, not built" tag on the slide itself.
- Every measured number is a placeholder until a benchmark run that is not simulated fills it
  (`bench/results/latest.json`) or the dashboard shows it. If it isn't measured by the final
  cut, drop that item from the evidence strip; never estimate one.
- The footer stays on the slide: "Synthetic data. Decision support for a compliance officer, not
  legal compliance."
- Never put a competitor's number on it.

## The slide

**Title:** One firm today. A company version next.

**Subtitle:** Same order at every size: exclusions in code → Moss → Jev → a fixed scope; then
search inside the scope → Jev → token budget → audit log.

| | Small team (what we demo) | Mid-size firm | Company version |
|---|---|---|---|
| **What it is** | One firm, two tiers, its people and agents, one compliance officer as moderator | Several desks, several moderators, single sign-on, connectors to email, chat and document storage | Org-wide policies per agent, retention rules, regulator-ready exports; set up with a forward-deployed engineer |
| **State** | Partly built, see the table below | Design, not built | Design, not built |

**Evidence strip** (bottom of the slide; drop any item that isn't measured):
leaks out of 60 attacks, Bullwark + Jev [[BENCH: leaks out of 60, Bullwark + Jev]] vs. shared memory
[[BENCH: leaks out of 60, shared memory]] · missing context [[BENCH: missing-context rate, Bullwark + Jev]]
· tokens per handoff [[BENCH: mean tokens per handoff, Bullwark + Jev]]
· scope build time [[BENCH: mean scope build time, Bullwark + Jev]]
· cost per handoff [[BENCH: cost per handoff, Bullwark + Jev]]

**Footer:** Synthetic data. Decision support for a compliance officer, not legal compliance.

**Say (pitch, 1:55):** "Small finance teams now, a company version next." If a judge asks for
more, use Q19 in [`PITCH.md`](PITCH.md).

## What carries over at every size

These are design rules written into the scopes contract (`shared/src/types/`, draft PR #7).
They don't change as the firm grows. Most of the code that enforces them is still planned (see
the table below), so the slide states them as design:

- Two tiers. Moderators see all memory and manage people, tiers and scope rules. Members see
  only their scope and create their own agents.
- Members start with nothing: a fact reaches a person or agent only if it is in their scope.
- A scope is built in a fixed order: excluded groups and labels removed in code → Moss
  candidates → Jev yes/no per fact → a fixed list of fact ids, kept current as facts arrive and
  rules change. At question time, code only searches inside that list.
- An agent's scope is built from its creator's and checked in code to be a subset, so no agent
  ever holds more than the person who made it.
- No refusals and no existence signals: nothing outside a scope is named, counted or hinted at.
- Every judge sits behind one `judge()` interface (Jev, a Claude fallback, an offline fake), so
  swapping one is a config change.
- AI tools connect over MCP with one token per client, and every call is scoped to that client.

## What has to change to get there

From the PRD's scale path, and none of it is built:

- **Mid-size firm:** several desks and several moderators; single sign-on (cut from the
  hackathon build); real connectors to email, chat and document storage in place of synthetic
  data; a scope map so moderators can see who can see which groups.
- **Company version:** policies per agent across the organization, retention rules,
  regulator-ready exports, and setup with a forward-deployed engineer.
- **Hosting:** today Bullwark runs as local processes over local files (one markdown file per fact,
  filed by group, raw captures in a cold archive) and plain server-sent events. How it is hosted
  for more than one office is not designed yet; the slide doesn't claim it.

## What runs today and what is simulated (small-team column)

Last checked Sat 10/24 07:30 PDT. "Today" says where the code is; the right-hand column is filled
at code freeze (Sun 07:00) from what the demo actually ran.

| Part | Today | At code freeze |
|---|---|---|
| Data | All synthetic: Harbor Lane Partners, Project Falcon, Nimbus Logistics, Maya, Dan, Priya, Leo | Synthetic |
| Capture: Claude Code hook, ChatGPT extension | **Built** on `main` for scaffold capture; author fields, scopes version, **in review** (B4; PR #12) | [[CHECK: real / not shipped]] |
| Capture: ingest client (memos, chat, notes, email, AI sessions) | Scopes version **in review** (B19; PR #12). Carries Dan's ChatGPT session if the extension is cut. Today's server drops the author until lane A keeps it. | [[CHECK: real / not shipped]] |
| Storage and events | **Built**: local files and plain SSE, no database | Real |
| Jev triage (keep, group, AI instructions, relation) and quarantine | Scopes version **in review** (B5; PR #10); every fact goes to `inbox` until lane A's groups route ships. With no Jev key it runs on the Claude Haiku fallback; with no keys at all, on the fake judge, labelled simulated | [[CHECK: real Jev / Claude fallback / simulated fake judge]] |
| Claude fact writer | Scaffold writer **built**; finance writer, with group and label suggestions, **in review** (B17, on draft PR #7) | [[CHECK: real / simulated]] |
| Scope builder, living scopes, tiers, agent profiles, handoff, audit log | Contract **in review** (draft PR #7); server **planned** (lane A) | [[CHECK: real / not shipped]] |
| Moss search | **Planned** (A4, blocker Q2); the keyword retriever runs, labelled a stub on the dashboard | [[CHECK: real Moss / keyword fallback]] |
| Droid agents and live routing | Scopes version **in review** (B2, B18; PR #9), not yet run against a real `droid`. Without Factory or Anthropic keys the fake runner runs, labelled simulated | [[CHECK: real `droid exec` / Claude fallback runner / simulated fake runner]] |
| Moderator console, member view, memory browser | **Planned** (C13, C14, C18); the scaffold dashboard runs today | [[CHECK: real / not shipped]] |
| Benchmark | Scaffold runner **built** (3 baselines; it doesn't measure scopes); finance runner **planned** (A8, C6) | [[CHECK: link to bench/results/latest.json from a run that is not simulated]] |

If a row is still "not shipped" at code freeze, the slide's small-team column says "partly
built" and the pitch says which parts in one sentence (Q15 in [`PITCH.md`](PITCH.md)).
