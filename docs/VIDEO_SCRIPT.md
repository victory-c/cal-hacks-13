# Video script: Bullwark (3:00 max)

**Script:** Victor (task B14). **Footage:** Edan records it (C9), plus the full-demo backup
recording. **Voiceover:** Victor. Source of the beats: the demo script in [`PRD.md`](PRD.md).
The live pitch in [`PITCH.md`](PITCH.md) follows the same order, so footage can stand in for any
live beat that breaks.

**Rules for this video**

- It opens on the moment: Leo's question and the neutral refusal. No logo or title before it.
  (Hyphenate asks for a video that opens on "the moment.")
- Hard limit 3:00. The timings below add up to 2:55, leaving 5 seconds of slack.
- Every measured number on screen (leaks, wrongly blocked, accuracy, tokens, latency, cost) comes
  from `bench/results/latest.json` (a run that is not simulated) or the live dashboard counter.
  Test-set sizes and thresholds are design settings, not results. Placeholders: `[[BENCH: …]]`,
  `[[LIVE COUNTER: …]]`, `[[QUOTE: …]]`, `[[CHECK: …]]`. If a number isn't measured by the final
  cut, drop the line.
  Never stage a number.
- If any part ran simulated (fake judge, fake runner, keyword search instead of Moss), the
  dashboard already says "simulated." Leave that label in frame, and say so in the end card.
- All names are synthetic: Harbor Lane Partners, Project Falcon, Nimbus Logistics, Maya
  (compliance), Dan (banker on Falcon), Priya (research analyst), Leo (trader).

## Beat sheet

| # | Time | Beat | Picture | On-screen text | Voiceover |
|---|---|---|---|---|---|
| 1 | 0:00–0:18 | The moment | S1 then S2 | "Leo · trader · public side" | (first 4 s: no voice, let the refusal land) "Leo is a trader. He just asked his AI about a company his firm is secretly advising on. It said no, and nothing else. But Maya in compliance sees who asked, what, and which deal it touched." |
| 2 | 0:18–0:40 | Who it's for | S3, S4 | "Bullwark: the control room for a small finance team's AI" then "Harbor Lane Partners · 30 people · 1 compliance officer (synthetic)" then the quote card | "This is Bullwark. Small finance firms must keep deal information away from their traders and researchers. Maya does it with a spreadsheet. Now every banker uses AI tools, and every agent is one more place a deal can leak." (Quote card holds 3 s, no voice.) |
| 3 | 0:40–1:05 | Capture and triage | S5, S6 | "Jev: keep? confidential? which deal? instructions to an AI?" then "Quarantined: planted instruction" | "Bullwark captures context as it happens: Dan's ChatGPT session about deal terms, a new memo. Jev, a judge model, asks yes-or-no questions about each one and flags both as Falcon. Claude writes the facts, and code puts them behind the wall. This email from the target's lawyers hides an instruction to the AI. Quarantined." |
| 4 | 1:05–1:35 | Dispatch and slices | S7, S8 | "Deal analyst · Falcon side" / "Research analyst · public side" then "Cut by: wall (before search)" | "Dan asks for Falcon board materials and an update to the logistics sector note. Bullwark dispatches two Factory Droid agents, each in its own sandbox folder. The deal analyst gets Falcon facts. The research analyst gets public facts only. The inspector shows why: this Falcon fact was cut by the wall before search ran. No model ever saw it, so none can be talked into revealing it." |
| 5 | 1:35–1:52 | Knowing when to ask | S9 | "Jev pre-screen: plausible tie, needs a human" then "Approved · expires [[CHECK: date shown]]" | "Priya in research asks to join Falcon. Jev rates the request borderline, so a person decides, not a model. Maya approves it with an expiry date, and the wall map updates." |
| 6 | 1:52–2:12 | Walls change live | S10, S11 | "Project Falcon: announced" then "Inbox · wall change · urgent" | "Now Falcon is announced. Restrictions lift. Leo asks again and gets his answer. The research agent picks up the now-public facts at its next step, with no restart. If the deal had died instead, the deal agent would stop and its folder would lock." |
| 7 | 2:12–2:37 | Proof | S12, S13 | Chart title: "Leak rate vs. wrongly blocked, 50 attacks, 30 tasks". Callouts from the chart only. | "We attacked it 50 times: direct questions, paraphrases, the code name, indirect hints and planted instructions. Bullwark with Jev leaked [[BENCH: leaks out of 50, Bullwark + Jev]]. A shared memory told to respect the wall leaked [[BENCH: leaks out of 50, shared memory]]. Bullwark wrongly blocked [[BENCH: wrongly blocked rate, Bullwark + Jev]] of real tasks. And every handoff is in the audit log." |
| 8 | 2:37–2:55 | Close | S14, S15 | "Other memory tools ask what's relevant. Bullwark first asks what you're allowed to know, then what's relevant." then the end card | "Bullwark fills two seats at a small firm: a compliance analyst for Maya, and a research assistant that never crosses the wall. One firm today, a company version next. Bullwark." |

Voiceover is about 360 words (fewer once the placeholders become numbers), roughly 140 words a
minute across the 2:55 with the silent beats. Beats 4 and 7 are the densest. If a take
runs long, cut in this order: the last sentence of beat 6, the second sentence of beat 2, the
"And every handoff" line in beat 7.

## Shot list (for Edan)

Record each shot as its own clip, so a retake costs one shot, not the whole run. 1920x1080,
browser zoom 125%, dark mode off, notifications off, bookmarks bar hidden, no real names or
emails anywhere in frame. Mouse moves slowly; pause 1 s before each click.

| Shot | What to record | Length to capture | Notes |
|---|---|---|---|
| S1 | Desk assistant chat as **Leo**. Type: "Anything going on with Nimbus Logistics? Should we add to our position?" and send. Hold on the refusal. | 12 s | The refusal text must read exactly: "I can't help with that company right now. It's on the restricted list. Contact compliance." |
| S2 | Maya's control room. The refusal row appears in the live feed and the review/audit panel lights up with who, what, which deal. | 8 s | Zoom in (post) on "deal: Project Falcon" so viewers see compliance gets the full reason and Leo didn't. |
| S3 | Title card on a plain background: "Bullwark: the control room for a small finance team's AI". | 4 s | Made in post. |
| S4 | Quote card: [[QUOTE: from Edan's notes]], with the speaker's role (no name unless they agreed). | 3 s | If there is no quote with permission, cut S4 and give the time to beat 3. |
| S5 | Event feed while Dan's ChatGPT session and a new Falcon memo arrive. Triage rows show the Falcon label and Jev's probabilities. | 12 s | Dan's ChatGPT session comes in through the ChatGPT extension on a real ChatGPT tab with synthetic text, or, if the extension is cut, through the ingest client (`hooks/ingest/`, as an AI session). Say which on the end card. |
| S6 | The lawyers' email arrives and lands in Quarantine. Open it to show the planted line highlighted. | 8 s | Keep the planted instruction readable for 2 s. |
| S7 | Dan types in the control room: "Prep Falcon board materials and update our logistics sector note." Two agent lanes start. | 12 s | Both lanes in frame, steps and files appearing (memo file, Python valuation, sector note). |
| S8 | Handoff inspector for the research agent: the candidate list, a Falcon fact with "cut: wall" and no Jev probability, kept facts with their probabilities, final tokens. | 12 s | Hover the "cut: wall" row. This is the "permission before relevance" shot; make it slow. |
| S9 | Priya requests access to Falcon. The request appears in Maya's queue with Jev's pre-screen level. Maya sets an expiry and approves. Wall map updates. | 15 s | If the wall map didn't ship, show the "who is over the wall" list updating instead. |
| S10 | Maya changes Project Falcon to "announced." The urgent event appears in the feed. | 6 s | |
| S11 | Leo asks the same question again and gets an answer. Then the research lane shows the urgent inbox item and its next step using the now-public facts. | 14 s | Split screen in post if both don't fit. |
| S12 | Benchmark chart from `bench/results/chart.json`: leak rate against wrongly-blocked rate, one point per setup. | 12 s | Record only after a real (not simulated) bench run. If only a simulated run exists, cut beat 7's numbers and say "benchmark in progress." |
| S13 | Audit log view filtered to Project Falcon. Scroll slowly through handoff, refusal, access and status rows. | 8 s | |
| S14 | Positioning card, then the scale path: small team → mid-size firm → company version. | 8 s | Made in post from [`SCALE_SLIDE.md`](SCALE_SLIDE.md). Only the small-team column runs today; keep its "design, not built" tag on the other two. |
| S15 | End card (below). | 5 s | Made in post. |

**Backup shot (record it, keep it out of the main cut):** S16, deal terminated. Maya marks
Falcon "terminated"; the deal analyst's lane shows the cancel and the locked folder. It's for
the pitch, if a judge asks what happens when a deal dies.

## End card (on screen, no voiceover)

```
Bullwark · Cal Hacks 13.0
All data is synthetic. Bullwark is decision support for a compliance officer, not legal compliance.
Real in this video: [[CHECK: e.g. Claude writer, Droid agents, Moss search, Jev]]
Simulated in this video: [[CHECK: e.g. nothing / fake judge / keyword search]]
[[CHECK: repo URL]]
```

## Before recording

- [ ] Code freeze build from `main`, started with `npm run dev`, finance world seeded
      ([[CHECK: seed command for the finance world from lane A]]).
- [ ] `.env` has the real keys for whatever we claim is real (Jev or Claude, Factory, Moss).
      The dashboard health line shows the judge, retriever and runner names; record it once.
- [ ] Bench run finished and `bench/results/latest.json` is not simulated, if beat 7 shows numbers.
- [ ] Rehearse the S1 question until the refusal shows within 2 s.
- [ ] Clear the event feed between takes so old rows don't show.
