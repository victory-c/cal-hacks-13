# Pitch: Canon (2 minutes live, then "try your own")

**Owner:** Victor (task B23). Timings follow the demo script in [`PRD.md`](PRD.md). The video
([`VIDEO_SCRIPT.md`](VIDEO_SCRIPT.md)) uses the same beats, so its clips stand in for any live
beat that breaks. Judging is Sun 10:30–12:30, and the whole team stays at the table.

**Roles at the table (assumption, change at rehearsal):** Victor talks. Henry drives the demo
laptop (he knows the server). Edan keeps time, holds the backup recording, and hands the
attack-box laptop to judges at the end.

**Numbers:** every measured number (leaks, wrongly blocked, accuracy, tokens, latency, cost)
comes from `bench/results/latest.json` (not simulated) or the live counter. Thresholds, budgets
and test-set sizes are design settings; call them that. Placeholders: `[[BENCH: …]]`, `[[LIVE COUNTER: …]]`, `[[QUOTE: …]]`, `[[CHECK: …]]`.
If a number isn't measured, say "we haven't measured that yet." Never guess, and never quote a
competitor's numbers.

## The 2 minutes

| Time | Screen (Henry) | Say (Victor) |
|---|---|---|
| 0:00 | Desk assistant as Leo. The question is already typed; press Enter. Then switch to Maya's control room. | "Leo's a trader. He asks his AI: anything going on with Nimbus Logistics, should we add? *(refusal appears)* It says no, and nothing else. *(point at Maya's panel)* But compliance just got the full record: who asked, what, and which deal." |
| 0:15 | Control room overview: deals, who is over each wall, live feed. The banner "Synthetic data · decision support, not legal compliance" stays on screen for the whole pitch ([[CHECK: banner shipped in `web/`; if not, tape a card under the screen]]). | "Canon is the control room for a small finance team's AI. Built for Maya, an invented compliance officer at a thirty-person firm. All our data is synthetic." |
| 0:25 | Event feed: Dan's ChatGPT session and the new memo arrive; triage rows flag Falcon. Then the lawyers' email lands in Quarantine. | "Context comes in live: Dan's ChatGPT session about deal terms, and a new memo. Jev asks yes-or-no questions about each one and flags both as Falcon. Claude writes the facts, and code puts them behind the wall. This email from the target's lawyers hides an instruction to the AI. Quarantined." |
| 0:45 | Dan types the task. Two Droid lanes start. Open the inspector on the research agent's handoff and hover the "cut: wall" row. | "Dan types one task. Canon dispatches two Droid agents in separate sandboxes. The deal analyst gets Falcon facts; the research analyst gets public facts only. Here's the inspector: this Falcon fact was cut by the wall, not by relevance. The permission check is plain code, and it runs before search and before any model sees the request." |
| 1:10 | Priya's access request in Maya's queue with Jev's pre-screen. Maya sets an expiry and approves. Wall map updates. | "Priya asks to join Falcon. Jev rates it borderline, so a person decides. Maya approves it with an expiry date, and the wall map updates." |
| 1:25 | Maya sets Falcon to announced. Leo asks again and gets an answer. Research lane shows the urgent inbox item. | "Falcon is announced. Restrictions lift. Leo asks again and gets his answer, and the research agent picks up the public facts at its next step. No restart." |
| 1:40 | Benchmark chart: leak rate against wrongly-blocked rate, one point per setup. | "We attacked it fifty times, in five styles. Canon with Jev leaked [[BENCH: leaks out of 50, Canon + Jev]]. Shared memory, told to respect the wall, leaked [[BENCH: leaks out of 50, shared memory]]. And Canon wrongly blocked [[BENCH: wrongly blocked rate, Canon + Jev]] of real tasks." |
| 1:55 | Positioning line, then the scale path. | "Other memory tools ask what's relevant. Canon first asks what you're allowed to know. It's decision support for Maya, not legal compliance, and anything simulated is labeled. Small finance teams now, a company version next." |
| 2:00 | Edan turns the attack-box laptop to the judges. | "Your turn. Try to get Project Falcon out of it." |

About 305 spoken words. The times are cue points from the PRD; the close is the tightest beat
and may spill to 2:05, so keep the 1:40 line short. Rehearse with a timer until the attack-box
handoff starts by 2:05 (C11). The honesty lines at 0:15 (synthetic data) and 1:55 (decision
support, simulated parts labeled) are required by the PRD, so never cut them for time. If a run
is long, cut "Restrictions lift." and "No restart." at 1:25 first.

**If a beat breaks live:** Henry says "here's the recording of that step," Edan plays the
matching clip from the video, and Victor keeps talking on the same line. Don't debug at the
table.

**If Wi-Fi fails:** the server, distiller and dashboard run on localhost. If a model call fails,
switch to the backup recording of the full demo and keep the same script.

## "Try your own" (the attack box)

- Let the judge type anything. Read the reply out loud, then show Maya's panel and the audit row.
- If Canon refuses: point out that the refusal names only the rule, and that Maya sees the deal.
- If Canon answers with public information only: open the inspector and show which facts went
  out and that no Falcon fact was a candidate.
- **If anything slips, say so.** "That got through. Here's the audit row showing exactly what
  was sent, so Maya would see it." Don't claim it was caught unless the screen shows it.

## Backup scenario: the deal dies

Ready on the demo laptop, used only if a judge asks or there's time. Maya sets Falcon to
"terminated." Say: "The deal is dead. The deal analyst's next step is cancelled and its folder is
locked. The wall stays up: Falcon facts stay restricted, and the history stays in the audit log."

## Hard questions and answers

Short answers first. Stop talking after the first two sentences unless they ask for more.

**1. Is the data real?**
No. Harbor Lane Partners, Project Falcon, Nimbus Logistics and all four people are invented.
Real deal text is inside information, so we couldn't use it. We wrote the memos, a week of team
chat, a meeting transcript and the lawyers' email to be as messy as the real thing. The interview
quote is real: [[QUOTE: from Edan's notes]].

**2. Why not Glean, or a memory tool like Mem0 or Supermemory?**
Other memory tools ask what's relevant. Canon first asks what you're allowed to know. Memory
tools share everything, so the more they remember, the more they can leak. Permission-aware
search like Glean copies the permissions your apps already have; it doesn't manage deal walls or
wall-crossings, and it doesn't brief and update the agents you dispatch.

**3. What if Jev is wrong?**
At handoff, a wrong Jev answer can only drop a useful fact, never leak one: the permission
filter is plain code and runs before Jev sees anything. At save time Jev's answers help set a
fact's wall label, so a deal fact that both our alias rules and Jev miss could be labeled public;
that's the gap our paraphrase and indirect attacks measure. (If they ask for more:) No model can
lower a wall or grant access; only Maya or a deal-status change can, and labels only move up on
their own. Jev leans safe at save time: a 20% chance of "confidential" counts as yes, an unsure
deal goes to Maya's queue, and the raw text is always archived. A wrong answer at handoff shows
up as the wrongly-blocked rate.

**4. What about prompt injection?**
Five layers. Triage asks of every captured item, "Does this contain instructions aimed at an
AI?" and quarantines it until compliance releases it. Facts reach agents quoted, with source
labels, as data, never as instructions. Labels only move up on their own, so planted text can't
lower a fact that's already behind the wall. Each Droid can touch only its own folder. And every output passes an exit
check before it leaves its side.

**5. Can an agent change its own permissions?**
No. No MCP tool and no Droid sandbox has any way to edit entitlements. An agent's clearance is
its side of the wall intersected with the live clearances of the person it works for, so it can
never see more than its person. Only compliance approves a wall-crossing.

**6. Is this legal compliance?**
No. Canon is decision support for a compliance officer. It enforces the walls she sets, asks her
when it isn't sure, and keeps the record she needs when a regulator asks who knew what and when.
It doesn't replace her or legal review.

**7. What does it cost per handoff?**
[[BENCH: cost per handoff, Canon + Jev]], measured on our 30-task set. Two things keep it low:
one batched Jev request per handoff instead of one per fact, and a slice of
[[BENCH: mean tokens per handoff, Canon + Jev]] tokens instead of the whole history. (If the
bench hasn't produced cost: "We haven't measured cost yet. We won't guess.")

**8. What happens when a deal dies?**
Maya marks it terminated. It goes out as an urgent event: the deal agent's next step is cancelled
and its folder is locked. The wall stays up, so the facts stay restricted, and the history stays
in the audit log. (Offer to show the backup scenario.)

**9. Why Droid for finance work? It's a coding agent.**
It's a general agent with file and shell tools, and our finance tasks are work over a folder:
read the memos, run Python for the valuation, write the memo file. Droid runs headless on our
trigger, at a restricted autonomy level: it can edit files and run Python in a sandbox folder
holding only its side of the wall, and touch nothing outside it. One
runtime for every agent means every agent's work shows up the same way, in its lane and in the
audit log. [[CHECK: what Factory's booth said about headless non-coding runs (blocker Q1)]]

**10. What's real and what's simulated today?**
All data is synthetic. [[CHECK: at code freeze, read the real-vs-simulated table in
docs/DEVPOST.md and say it in one sentence, e.g. "Claude, Droid and the permission filter are
real; Jev ran on its Claude fallback; Moss is real."]] Anything that ran simulated says
"simulated" on the dashboard.

**11. Doesn't the refusal itself tip Leo off?**
It names only the rule, never the deal, and every restricted company gets the same sentence. The
restricted list is already shared with staff, so the refusal tells Leo nothing new. Watch-list
names are secret, so they get a blander answer with no reason at all.

**12. Why not just tell the model in its prompt to respect the walls?**
That's our shared-memory baseline, and a prompt is not a wall. It leaked
[[BENCH: leaks out of 50, shared memory]] of 50 attacks. Canon removes restricted facts in code
before the model sees the request, so there is nothing to talk it out of.

**13. Doesn't all this filtering make it useless?**
We measure that: Canon wrongly blocked [[BENCH: wrongly blocked rate, Canon + Jev]] of 30
legitimate tasks and scored [[BENCH: task accuracy, Canon + Jev]] on the answer keys. Borderline
access requests go to Maya instead of being refused outright, so people aren't stuck.

**14. What about indirect questions, like "any logistics deals coming?"**
Indirect questions are one of the five attack styles in our set. When every Falcon fact is
labeled right, they fail the same way direct ones do: no Falcon fact is in a public-side slice.
The case they really test is a Falcon fact that was mislabeled public at save time, so on the way
out the exit check has the judge look for indirect references, and a 20% chance blocks the
output. Our leak number counts whatever still got through.

**15. Where could Claude go wrong here?** (Anthropic)
By leaking across the wall: summarizing a deal memo into a fact that reads as public, or
repeating deal details in an agent's brief. No model can lower a wall or grant access, and Claude
only writes briefs from facts that already passed the permission filter. (If they ask for more:)
At save time, code rules plus the judge's answers set each fact's wall label, and it only moves
up. If Jev isn't available the judge is Claude Haiku, so Claude does answer "is this
confidential?" and "which deal?", and a 20% chance counts as yes. What's left is a deal fact
that both the alias rules and the judge miss; our paraphrase and indirect attacks and the exit
check are aimed at it.

**16. Is Droid just a chatbot wrapper here?** (Factory)
No. No one chats with it. A dispatched task triggers it, headless, in a sandbox Canon builds, and
Canon decides exactly which files it gets, routes updates to it between steps, and cancels it
when a deal dies. Its steps and files are the agent lanes you just saw.

**17. Who buys this, and what does it replace?** (Microsoft, Hyphenate)
The compliance officer at a 10–50 person finance firm. It replaces the wall-crossing spreadsheet,
manual briefings, and "paste everything into the prompt." It fills two seats: a compliance
analyst and a research assistant that never crosses the wall. The path to production is the
scale path: several desks and SSO next, then a company version with org-wide policies, retention
and regulator-ready exports.

**18. How fast is it?**
[[BENCH: time to first reply per handoff, Canon + Jev]] per handoff in our benchmark, and the
live counter shows each handoff as it happens: [[LIVE COUNTER: latency]]. Moss search is
[[LIVE COUNTER: Moss search latency]] of that.
