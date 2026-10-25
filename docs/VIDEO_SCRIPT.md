# Video script: Bullwark

Victor owns script and voiceover (B14); Edan owns capture, editing, upload and a full backup
recording (C9). Aim for two minutes. Start on the working moment, then follow
[BULLWARK-PRD.md](BULLWARK-PRD.md). Do not name a provider that did not run in the take.

| Time | Capture | Voiceover |
|---|---|---|
| 0:00–0:15 | Dollar Bill's desk assistant answers the Taylor Mason question from public/desk context. Wags inspects Dollar Bill's scope and handoff. | “Dollar Bill asks about Taylor Mason Capital. His assistant sees public information and his desk notes. The confidential bid was never in its memory.” |
| 0:15–0:25 | Moderator overview; synthetic-data label stays visible. | “Bullwark is the control room for a small finance team's AI. Wags runs compliance at our synthetic thirty-person fund, Axe Capital.” |
| 0:25–0:40 | Ingest Axe's exported session and memo. Paste counsel's email through Add item; show grouping and quarantine. | “Captured text becomes sourced facts. Jev judges filing and flags instructions aimed at an AI. Uncertain facts wait for Compliance; this email is quarantined.” |
| 0:40–1:00 | Build Ben Kim's public-sector research scope. Show measured stages. If Ben already exists, edit his rule. | “Wags sets Ben's task and excludes pending deals. Code removes excluded groups. Search finds candidates, Jev judges them, and the scope becomes a fixed list.” |
| 1:00–1:20 | Run Ben's research agent and Axe's deal analyst; show actual steps. Inspect a Ben-created agent asked to include Stonewall. | “Agents inherit their creator's scope. Ben cannot give an agent Stonewall facts he never had. Each run works from its own scoped folder.” |
| 1:20–1:40 | Refile only announced offer terms to public. Inspect the new scopes. Optional backup: narrow an active agent, show restart, then Stop. | “When the bid is announced, Wags makes only the announced terms public. The model and financing remain private. A narrowing interrupts a running agent and rebuilds its folder; Stop cancels it.” |
| 1:40–1:55 | Audit/handoff inspector. Show a benchmark chart only after the full measured run exists. | “The audit records what was sent and why. We have sixty attacks and thirty legitimate tasks ready; the complete benchmark is still pending, so we are not claiming a leak rate.” |
| 1:55–2:00 | Scale slide and end card. | “Small finance teams now. Bullwark.” |

If a complete measured finance run lands, replace the pending-benchmark sentence with its actual
leak and missing-context results, retaining evaluated denominators and simulation labels. Finance
output is `bench/results/finance-latest.json` and `finance-chart.json`; the legacy `latest.json`
contains a different benchmark. Do not quote it as finance-barrier performance.

## Recording instructions

Record each beat separately at a readable zoom, with provider labels visible. Hold on answers,
quarantine and scope changes long enough to read them. Keep tokens labelled est.; leave unknown
cost/latency as a dash. Use the ingest path for exported ChatGPT content and identify it as an
export, without implying the extension captured it live.

The member view does not have a general chat box. Use the desk agent's Run action for its stored
task, or type the opening question in the person-bound Claude Code/MCP client. Record the output
and the corresponding handoff in Wags's console. Do not stage a nonexistent UI control.

The moderator UI edits group exclusions. Select the deal group when that is the available control;
do not pretend the page provides a prose-exclusion field. If using a preconfigured prose rule,
say so and show its actual scope build.

Use the real runtime's name. The Docker preview uses Claude scoped agents and real Factory
extraction. Do not claim a Python valuation unless the captured runtime actually ran one.
If no consented interview quote exists, omit the quote card. Dedicated attack-box and scope-map
screens are not part of this recording.

## Before the take

1. Use live product pages and verify which identity is selected; keep the team password and
   person/internal tokens out of frame.
2. Start a separate local stack against an empty temporary data directory if an untouched world
   is needed. Never reset the shared preview's data for a recording. The server seeds an empty
   store automatically; `npm run seed -w server` is the older development seed, not a demo reset.
3. Inspect Dollar Bill's scope and the opening handoff. Confirm no Stonewall fact is included.
4. Decide whether the Ben beat is an add or a rule edit from the actual people list.
5. Prepare the exported Axe session, memo and counsel email from `fixtures/world/`.
6. Record the complete fallback run and retain per-beat clips. A local UI still needs network
   access for cloud model calls; play the recording if venue connectivity fails.

## End card

Bullwark · Cal Hacks 13.0. Synthetic finance data. Decision support, not legal compliance.
Real preview: Factory extraction, Jev judgments, Moss retrieval, Claude scoped agents.
Offline providers are labelled simulated. Complete finance benchmark pending.
Source: https://github.com/victory-c/cal-hacks-13
