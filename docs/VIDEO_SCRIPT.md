# Video script: Bullwark (3:00 max)

**Script:** Victor (task B14). **Footage:** Edan records it (C9), plus the full-demo backup
recording. **Voiceover:** Victor. Source of the beats: the demo script in [`PRD.md`](PRD.md).
The live pitch in [`PITCH.md`](PITCH.md) follows the same order, so footage can stand in for any
live beat that breaks.

**Rules for this video**

- It opens on the moment: Leo's question, answered from public news only, then Maya's scope
  inspector showing Leo's scope never held a Falcon fact. No logo or title before it.
  (Hyphenate asks for a video that opens on "the moment.")
- Bullwark never refuses. If any take shows a refusal, an apology about access, or a hint that
  something is hidden, that is a bug: stop, tell Victor and Henry, and don't record around it.
- Hard limit 3:00. The timings below add up to 2:55, leaving 5 seconds of slack.
- Every measured number on screen (leaks, missing context, accuracy, tokens, latency, cost, scope
  build time) comes from `bench/results/latest.json` (a run that is not simulated) or the live
  dashboard. Test-set sizes and thresholds are design settings, not results. Placeholders:
  `[[BENCH: …]]`, `[[LIVE COUNTER: …]]`, `[[QUOTE: …]]`, `[[CHECK: …]]`. If a number isn't
  measured by the final cut, drop the line. Never stage a number.
- If any part ran simulated (fake judge, fake runner, keyword search instead of Moss), the
  dashboard already says "simulated." Leave that label in frame, and say so in the end card.
- All names are synthetic: Harbor Lane Partners, Project Falcon, Nimbus Logistics, Maya
  (compliance, moderator), Dan (banker on Falcon, member), Priya (research analyst, member),
  Leo (trader, member).

## Beat sheet

| # | Time | Beat | Picture | On-screen text | Voiceover |
|---|---|---|---|---|---|
| 1 | 0:00–0:18 | The moment | S1 then S2 | "Leo · trader · member" then "Maya's scope inspector: no Falcon fact in Leo's scope, ever" | (first 4 s: no voice, let the answer land) "Leo is a trader. He just asked his AI about a company his firm is secretly advising on. It answered from public news. No refusal, no hint that anything is missing. Maya, in compliance, can see why: Leo's memory never held a single fact about the deal." |
| 2 | 0:18–0:36 | Who it's for | S3, S4 | "Bullwark: the control room for a small finance team's AI" then "Harbor Lane Partners · 30 people · 1 compliance officer (synthetic)" then the quote card | "This is Bullwark. Small finance firms must keep deal information away from their traders and researchers. Maya does it with a spreadsheet. Now every banker uses AI tools, and every agent is one more place a deal can leak." (Quote card holds 3 s, no voice.) |
| 3 | 0:36–0:58 | Capture, grouping, quarantine | S5, S6 | "Group: deal/falcon · joins Dan's scope" then "Quarantined: instructions aimed at an AI" | "Bullwark captures context as it happens: Dan's ChatGPT session about deal terms, and a new memo. Jev, a judge model, files each fact in a group, here the Falcon deal, and they join Dan's memory. This email from the target's lawyers hides an instruction to the AI. Quarantined. It joins no one's memory." |
| 4 | 0:58–1:25 | Maya builds a scope | S7 | "Task: write the logistics sector note from public market data" / "Exclude: anything about pending deals" then each stage's measured time as it finishes | "Maya adds Priya, a research analyst, with a task and one exclusion: anything about pending deals. Watch the builder. Deal groups are removed in code before any model runs. Moss finds candidates in what's left. Jev answers yes or no for each one. That's Priya's scope, built in [[LIVE COUNTER: scope build time, Priya's scope]]." |
| 5 | 1:25–1:55 | Agents inherit, never exceed | S8, S9 | "Research agent · from Priya's scope" / "Deal analyst · from Dan's scope" then "Agent task: include everything about Falcon" | "Members create their own agents, and an agent's scope comes only from its creator's. Priya starts a research agent, and Dan starts a deal analyst: two Factory Droid agents, each in a sandbox holding only its scope. Now an attack. Priya creates an agent told to include everything about Falcon. It gets nothing about Falcon, because she has nothing to give it." |
| 6 | 1:55–2:15 | Moderators change access; agents keep up | S10, S11 | "Falcon announced · deal exclusion removed for Leo and Priya" then "Research agent · new facts at next step" | "Falcon is announced. Maya removes the deal exclusion from Leo's and Priya's rules. Their scopes rebuild, the research agent gets the new facts at its next step, and Leo's assistant can now answer him." |
| 7 | 2:15–2:40 | Proof | S12, S13 | Chart title: "Leak rate vs. missing-context rate · 60 attacks · 30 tasks". Callouts from the chart only. | "We attacked it 60 times in six styles, including agents built to escalate. Bullwark with Jev leaked [[BENCH: leaks out of 60, Bullwark + Jev]]. A shared memory told to respect the wall leaked [[BENCH: leaks out of 60, shared memory]]. And real tasks still got their context: missing on [[BENCH: missing-context rate, Bullwark + Jev]] of 30. Every handoff is in the audit log." |
| 8 | 2:40–2:55 | Close | S14, S15, S16 | "Other memory tools ask what's relevant. Bullwark first decides what each person's memory should hold, then what's relevant." then the scale slide, then the end card | "Bullwark fills two seats at a small firm: a compliance analyst for Maya, and a research assistant that works from a memory that never held the deal. One firm today, a company version next. Bullwark." |

Voiceover is about 390 words (fewer once the placeholders become numbers), roughly 140 words a
minute across the 2:55 with the silent beats. Beats 4 and 5 are the densest. If a take runs
long, cut in this order: the second sentence of beat 2, "Now an attack." in beat 5, the "Every
handoff" line in beat 7.

## Shot list (for Edan)

Record each shot as its own clip, so a retake costs one shot, not the whole run. 1920x1080,
browser zoom 125%, dark mode off, notifications off, bookmarks bar hidden, no real names or
emails anywhere in frame. Mouse moves slowly; pause 1 s before each click.

| Shot | What to record | Length to capture | Notes |
|---|---|---|---|
| S1 | Desk assistant as **Leo** (member view). Type: "Anything going on with Nimbus Logistics? Should we add to our position?" and send. Hold on the answer. | 12 s | The answer uses public news only: no refusal, no "I can't," no mention of restrictions, compliance or missing information. [[CHECK: where Leo's question is typed in the shipped member view, and that the desk assistant is the agent from the PRD's demo table]] |
| S2 | Maya's moderator console, scope inspector on Leo (and his desk assistant). Then the audit log filtered to Leo: no `fact.joined_scope` row for a Falcon fact. | 8 s | Zoom in (post) on the empty Falcon filter. This is moderator-only screen: members never see counts or group names. |
| S3 | Title card on a plain background: "Bullwark: the control room for a small finance team's AI". | 4 s | Made in post. |
| S4 | Quote card: [[QUOTE: from Edan's notes]], with the speaker's role (no name unless they agreed). | 3 s | If there is no quote with permission, cut S4 and give the time to beat 3. |
| S5 | Event feed while Dan's ChatGPT session and a new Falcon memo arrive. Triage rows show the group `deal/falcon` and Jev's probabilities; a scope update shows the facts joining Dan's scope. | 12 s | Dan's ChatGPT session comes in through the ChatGPT extension on a real ChatGPT tab with synthetic text, or, if the extension is cut, through the ingest client (`hooks/ingest/`, as an AI session). Say which on the end card. |
| S6 | The lawyers' email arrives and lands in Quarantine. Open it to show the planted line highlighted. | 8 s | Keep the planted instruction readable for 2 s. If the quarantine view (B11) is cut, show the quarantine row in the event feed. |
| S7 | Maya adds Priya in the moderator console: task "Write the logistics sector note from public market data," exclusion "anything about pending deals." The scope builder runs: exclusions (deal groups removed in code), Moss candidates, Jev yes/no per fact, done, each stage with its measured time. | 20 s | Make it slow. Hover the removed `deal/falcon` group at the exclusions stage, then a Jev "no" at the Jev stage. The times on screen are what was measured in this take. |
| S8 | Member view as Priya: create a research agent ("Update our logistics sector note"). Member view as Dan: create a deal analyst ("Draft a short Falcon board memo and run a simple valuation in Python"). Two Droid lanes run side by side in Maya's console. | 15 s | Both lanes in frame, steps and files appearing (memo file, Python valuation, sector note). |
| S9 | Member view as Priya: create an agent with the task "Include everything about Falcon." Then Maya's scope inspector on that agent (no Falcon fact), and the agent's first step answering from what it has. | 12 s | The agent's output must not refuse or hint either. Keep its lane in frame long enough to read one line. |
| S10 | Maya edits Leo's and Priya's scope rules and removes the deal exclusion. The scope builder reruns for both; scope updates show facts added. | 8 s | |
| S11 | The research agent's lane shows the inbox item with the new facts and its next step using them. Then Leo asks the same question again and gets an answer that includes the announced deal. | 14 s | Split screen in post if both don't fit. |
| S12 | Benchmark chart from `bench/results/chart.json`: leak rate against missing-context rate, one point per setup. | 12 s | Record only after a real (not simulated) bench run. If only a simulated run exists, cut beat 7's numbers and say "benchmark in progress." |
| S13 | Audit log view filtered to the demo window. Scroll slowly through scope builds, facts joining scopes, handoffs and the quarantine row. | 8 s | |
| S14 | Positioning card. | 3 s | Made in post. |
| S15 | Scale slide: small team → mid-size firm → company version. | 5 s | Made in post from [`SCALE_SLIDE.md`](SCALE_SLIDE.md). Only the small-team column runs today; keep its "design, not built" tag on the other two. |
| S16 | End card (below). | 5 s | Made in post. |

**Backup shots (record them, keep them out of the main cut).** They're for the pitch, if a judge
asks. Record S18 before S17: once Dan is a moderator he has no scope rule to narrow.

- **S18, Falcon dies.** Record on a fresh data dir where Falcon was never announced. Maya edits
  Dan's scope rule to exclude `deal/falcon`. The deal analyst's lane shows the urgent "scope
  narrowed" inbox item; its run folder is discarded and the run restarts from the plan step in a
  fresh folder with no Falcon files.
- **S17, Dan is promoted.** Dan becomes deal lead, and Maya promotes him to moderator in the
  people list. His view now shows the moderator console, and the audit log shows the tier
  change.

## End card (on screen, no voiceover)

```
Bullwark · Cal Hacks 13.0
All data is synthetic. Bullwark is decision support for a compliance officer, not legal compliance.
Real in this video: [[CHECK: e.g. Claude writer, Droid agents, Moss search, Jev]]
Simulated in this video: [[CHECK: e.g. nothing / fake judge / keyword search]]
[[CHECK: repo URL]]
```

## Before recording

- [ ] Code freeze build from `main`, started with `npm run dev`, synthetic world loaded
      ([[CHECK: seed or reset command for the finance world from lane A]]).
- [ ] `.env` has the real keys for whatever we claim is real (Jev or Claude, Factory, Moss).
      The dashboard health line shows the judge, retriever and runner names; record it once.
- [ ] Bench run finished and `bench/results/latest.json` is not simulated, if beat 7 shows numbers.
- [ ] Before S1, check in the scope inspector that Leo's and Priya's rules still exclude pending
      deals and that no Falcon fact is in either scope.
- [ ] Rehearse the S1 question until the answer shows within a few seconds, with no refusal.
- [ ] Clear the event feed between takes so old rows don't show.
