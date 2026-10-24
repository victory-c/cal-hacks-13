# Scale slide: Canon

**Owner:** Victor (task B13). One slide: how Canon goes from a small team to a company version,
and what of it runs today. The tiers come from the scale path in [`PRD.md`](PRD.md) ("Competitors
and positioning"). It is used at 1:55 in the live pitch ([`PITCH.md`](PITCH.md)), as shot S14 in
the video ([`VIDEO_SCRIPT.md`](VIDEO_SCRIPT.md)), and as the "scale slide" the Microsoft track
asks for. Build statuses come from [`SPONSORS.md`](SPONSORS.md); change them there first.

**Rules for this slide**

- Only the small-team column runs today, and only in part. The other two columns carry a
  "design, not built" tag on the slide itself.
- Every measured number is a placeholder until a benchmark run that is not simulated fills it
  (`bench/results/latest.json`) or the live counter shows it. If it isn't measured by the final
  cut, drop the evidence strip; never estimate one.
- The footer stays on the slide: "Synthetic data. Decision support for a compliance officer, not
  legal compliance."
- Never put a competitor's number on it.

## The slide

**Title:** One firm today. A company version next.

**Subtitle:** Same order at every size: permission filter → search → Jev → token budget → audit log.

| | Small team (what we demo) | Mid-size firm | Company version |
|---|---|---|---|
| **What it is** | One firm, its deals and walls, its people and agents, one compliance officer | Several desks and several compliance staff, single sign-on, connectors to email, chat and document storage | Org-wide policies per agent, retention rules, regulator-ready exports; set up with a forward-deployed engineer |
| **State** | Partly built, see the table below | Design, not built | Design, not built |

**Evidence strip** (bottom of the slide; drop any item that isn't measured):
leaks out of 50 attacks, Canon + Jev [[BENCH: leaks out of 50, Canon + Jev]] vs. shared memory
[[BENCH: leaks out of 50, shared memory]] · wrongly blocked [[BENCH: wrongly blocked rate, Canon + Jev]]
· tokens per handoff [[BENCH: mean tokens per handoff, Canon + Jev]]
· cost per handoff [[BENCH: cost per handoff, Canon + Jev]]

**Footer:** Synthetic data. Decision support for a compliance officer, not legal compliance.

**Say (pitch, 1:55):** "Small finance teams now, a company version next." If a judge asks for
more, use Q17 in [`PITCH.md`](PITCH.md).

## What carries over at every size

These are design rules written into the finance contract (`shared/src/types/`, draft PR #7).
They don't change as the firm grows. Most of the code that enforces them is still planned (see
the table below), so the slide states them as design:

- Deny by default: a fact reaches a person or agent only if code confirms they are cleared for
  its wall label.
- The handoff order: permission filter (code) → search (Moss plus keyword) → relevance (Jev) →
  token budget (code) → audit log (code). At handoff, restricted facts never reach search or a
  model.
- No model can lower a wall or grant access. Only compliance or a deal-status change can.
- Every judge sits behind one `judge()` interface (Jev, a Claude fallback, an offline fake), so
  swapping one is a config change.
- AI tools connect over MCP with one token per client, and every call is scoped to that client.

## What has to change to get there

From the PRD's scale path, and none of it is built:

- **Mid-size firm:** several desks and several compliance staff; single sign-on (cut from the
  hackathon build); real connectors to email, chat and document storage in place of synthetic
  data.
- **Company version:** policies per agent across the organization, retention rules,
  regulator-ready exports, and setup with a forward-deployed engineer.
- **Hosting:** today Canon runs as local processes over local files (one markdown file per fact,
  raw captures in a cold archive) and plain server-sent events. How it is hosted for more than
  one office is not designed yet; the slide doesn't claim it.

## What runs today and what is simulated (small-team column)

Last checked Sat 10/24 05:37 PDT. "Today" says where the code is; the right-hand column is filled
at code freeze (Sun 07:00) from what the demo actually ran.

| Part | Today | At code freeze |
|---|---|---|
| Data | All synthetic: Harbor Lane Partners, Project Falcon, Nimbus Logistics, Maya, Dan, Priya, Leo | Synthetic |
| Capture: Claude Code hook, ChatGPT extension | **Built** on `main` for scaffold capture; finance fields **in review** (B19, B4; PR #12) | [[CHECK: real / not shipped]] |
| Capture: ingest client (memos, chat, notes, email, AI sessions) | **In review** (B19; PR #12). Carries Dan's ChatGPT session if the extension is cut. | [[CHECK: real / not shipped]] |
| Storage and events | **Built**: local files and plain SSE, no database | Real |
| Jev triage | **In review** (B5; PR #10). With no Jev key it runs on the Claude Haiku fallback; with no keys at all, on the fake judge, labelled simulated | [[CHECK: real Jev / Claude fallback / simulated fake judge]] |
| Claude fact writer | Scaffold writer **built**; finance writer **in review** (B17; PR #11) | [[CHECK: real / simulated]] |
| Permission filter, lists, neutral refusals, audit log | Contract **in review** (draft PR #7); server **planned** (A6, A7, A11) | [[CHECK: real / not shipped]] |
| Moss search | **Planned** (A4, blocker Q2); the keyword retriever runs, labelled a stub on the dashboard | [[CHECK: real Moss / keyword fallback]] |
| Droid agents | **In review** (B2, B18; PR #9). Without Factory or Anthropic keys the fake runner runs, labelled simulated | [[CHECK: real `droid exec` / Claude fallback runner / simulated fake runner]] |
| Control room and memory browser | **Planned** (C13, C14, C18); the scaffold dashboard runs today | [[CHECK: real / not shipped]] |
| Benchmark | Scaffold runner **built** (3 baselines; it doesn't measure walls); finance runner **planned** (A8, C6) | [[CHECK: link to bench/results/latest.json from a run that is not simulated]] |

If a row is still "not shipped" at code freeze, the slide's small-team column says "partly
built" and the pitch says which parts in one sentence (Q10 in [`PITCH.md`](PITCH.md)).
