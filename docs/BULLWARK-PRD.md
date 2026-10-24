# Bullwark PRD: the product and its frontend

**Cal Hacks 13.0 · team of 3 · submit by Sun 10/25 9:00 AM PDT · judging 10:30–12:30 · updated Sat 10/24**
**Bullwark is the product people use.** It runs on [Canon](CANON-PRD.md), the agentic backend, and
talks to it only through the [integration contract](INTEGRATION.md).

## Summary

**Bullwark is the control room for a small fund's AI: moderators see everything, and every other
person and agent gets a memory that holds only what their task needs. Anything else simply isn't
there.**

Finance firms are legally required to keep certain information apart. When a fund's deal team is
preparing a secret takeover bid, the traders and researchers down the hall must not learn about it. This
separation is an **information barrier** (or "wall"), and the secret details are **inside
information** (regulators call it MNPI, material non-public information). Today a small compliance
team tracks who knows what with spreadsheets, emails and memory.

AI makes this harder: context now lives in AI chats, agent sessions, memos and team chat, and every
new agent is one more place inside information can leak. Bullwark gives the compliance officer one
place to decide what each person's and agent's AI memory holds, watch it work, and prove it later.
Canon does the capturing, scoping and enforcing; Bullwark is everything a person sees and touches.

## Problem and who it's for

**Small finance teams can't keep inside information walled off once AI agents are in the loop, and
they don't have a big-bank compliance department to do it by hand.**

**Market:** small finance teams of 10–50 people where one group handles confidential deals and
another must stay clean. Examples: hedge funds with a deal or special-situations team, small
investment firms with private and public sides, boutique investment banks.

**Demo persona (named for the Anthropic track):** Wags, the COO who doubles as the one-person
compliance function at Axe Capital, a 30-person hedge fund. The fund runs a private-side deal team
alongside research analysts and a trading desk. Wags tracks who has been "brought over the wall" in a
spreadsheet and his inbox. Now every analyst and trader also uses two or three AI tools and agents.

**What goes wrong today:**

1. **Context leaks across the wall.** A shared AI tool or a carelessly briefed agent surfaces a deal
   code name or terms to someone on the public side.
2. **Agents get too much or too little.** Given everything, they're distracted and dangerous. Given
   nothing, they ask people to re-explain, or they guess.
3. **Nobody can prove what each agent knew.** When a regulator asks who saw what and when, the answer
   is spread across chat logs.
4. **Walls change and nobody updates the agents.** When a deal is announced, more people may know.
   When it dies, the work should stop. Running agents keep acting on stale context.

**What Bullwark replaces:** the compliance spreadsheet, manual briefings, and "paste everything into
the prompt" setups.

**Evidence to collect at the venue:** at least one quote from a finance or compliance person. Ask:
"How do you track who's over the wall today?" and "What happens when someone asks about a restricted name?"

## Users and journeys

| User | Tier | Journey in Bullwark |
| --- | --- | --- |
| Wags (COO and compliance) | Moderator | Adds people, describes each person's task, excludes what they must not know, watches scopes build, inspects any scope or handoff, moves announced facts to public, releases quarantined items, and answers "who knew what, when?" from the audit view |
| Axe (founder, leads Project Stonewall) | Member | Creates a deal analyst agent from his scope, watches it work, browses his own memory |
| Ben Kim (research analyst) | Member | Creates a research agent for his asset management sector note; never sees anything about Stonewall |
| Dollar Bill (portfolio manager) | Member | Uses his desk assistant over MCP; gets public answers with no hint that anything is hidden |

## Requirements

### Must ship: moderator console

1. **People and tiers:** list of people and agents with their tier and creator; add a person; promote
   a member to moderator.
2. **Scope builder:** a form with the task in plain language plus optional exclusions. As Canon builds
   the scope, the screen shows each stage live: groups removed in code, Moss candidates, Jev's yes/no,
   the final scope, and each stage's measured time.
3. **Scope inspector:** for any person or agent, the facts in their scope grouped by group, with the
   rule that produced them; edit the rule and watch it rebuild.
4. **Live event feed:** captures, grouping, quarantines, scope builds and changes, facts joining
   scopes, tier changes and agent activity, newest first.
5. **Agent lanes:** one lane per running agent: its creator, its steps, the files it wrote, its inbox,
   and a restart marker when its scope narrows.
6. **Handoff inspector:** for any handoff, the candidates searched inside the scope, Jev's probability
   for each, what was kept and what was cut (not relevant, over budget), and final tokens.
7. **Live counter:** tokens handed over (labelled est.), latency per stage and cost ("—" until a rate is set).
8. **Inbox and quarantine:** facts Jev couldn't place, and items held for planted instructions, with
   file and release actions. The same "file" action moves any fact to another group, which is how a
   moderator makes announced deal terms public.
9. **Audit view:** "who knew what, when" for a person, an agent or a group, from Canon's audit log.

### Must ship: member view

10. **My agents:** the member's own agents and their lanes.
11. **Create an agent:** the same form the moderator uses (task + exclusions), always inside the
    member's own scope.
12. **My memory:** browse, edit and retire facts in the member's own scope.

### Must ship: presentation rules

13. **No existence signals on member screens:** never show the people list, other scopes, exclusions,
    counts of hidden facts, group names outside the member's scope, or the audit view.
14. **Honest numbers:** token counts say "est.", simulated providers say "simulated", and anything not
    measured shows "—". Only measured numbers appear on screen or in the pitch.
15. **Finance words:** groups such as `deal/stonewall` display as "Project Stonewall"; the moderator
    tier is shown as "Compliance".
16. **Works from mock data:** every screen runs against fixtures that follow the integration contract,
    then switches to Canon with one setting.

### Should ship

- **Scope map:** a graph of which people and agents can see which groups.
- **Attack box:** judges type their own attempt to extract deal information as a member, or by
  creating an agent, and watch Bullwark handle it.

### Out of scope

- SSO, billing, mobile apps, real Slack, email or Jira connectors.

## Demo script

**The demo opens on a question that should leak and doesn't, then shows how a scope is built, then
lets judges attack it.** Hyphenate asks for a video that opens with "the moment" and a live demo where
they may try their own scenario.

**Synthetic world (all invented, after the TV series Billions):**

- **Firm:** Axe Capital, a 30-person hedge fund: a private-side deal team, research analysts and a
  trading desk.
- **Deal:** Project Stonewall. Axe Capital is quietly preparing a takeover bid for its rival Taylor
  Mason Capital (a fake public asset manager). Until the bid is announced, research and the trading
  desk must not learn about it, and the desk must not trade on it.
- **People:** Wags (Mike Wagner, COO and compliance, moderator), Axe (Bobby Axelrod, founder, leads
  Stonewall, member), Ben Kim (research analyst, member), Dollar Bill (Bill Stearn, portfolio manager,
  member).
- **Groups:** `deal/stonewall` (the bid), `research/asset-managers` (sector research),
  `market/public` (public news and filings), `desk/dollar-bill` (his own trading notes); label
  `taylor-mason` on anything about the target.
- **Content:** two Stonewall memos (bid terms; the valuation model), a week of team chat, one deal
  team meeting transcript, Axe's ChatGPT session about bid financing, Taylor Mason Capital's public Q3
  letter, and an email from Taylor Mason Capital's outside counsel about a standstill agreement that
  contains a planted instruction.

**Agents in the demo:**

| Agent | Created by | Scope rule | Gets |
| --- | --- | --- | --- |
| Deal analyst | Axe | "Draft the Stonewall bid memo and run a simple valuation in Python" | Stonewall facts, firm templates and public market data, all from Axe's scope |
| Research analyst | Ben Kim | "Update our asset management sector note" | Public sector and market facts from Ben's scope |
| Desk assistant | Dollar Bill | "Answer my questions about our positions and public news" | Public market facts and Dollar Bill's own desk notes |

**Script (2 minutes, live; the video opens with step 1):**

| Time | What happens | What it shows |
| --- | --- | --- |
| 0:00 | Dollar Bill asks his desk assistant: "Anything going on with Taylor Mason Capital? Should we add to our position?" It answers from Taylor Mason's public Q3 letter only. No refusal, no hint. Wags's scope inspector shows Dollar Bill's scope never held a Stonewall fact. | The moment: there is nothing to break into |
| 0:15 | One line: "Bullwark is the control room for a small fund's AI." Introduce Wags. | Who it's for |
| 0:25 | Axe's ChatGPT session (through the ingest API if the ChatGPT extension is cut) and a new memo arrive. They're grouped as `deal/stonewall` live and join Axe's scope. Counsel's email is quarantined for its planted instruction. | Capture, grouping, injection resistance |
| 0:40 | Wags adds Ben Kim: "Write the asset management sector note from public market data", excluding "anything about pending deals". The builder runs on screen: deal groups removed in code, Moss candidates, Jev's yes/no, the final scope and each stage's measured time. | The scope builder, fast |
| 1:00 | Ben creates a research agent from his scope and Axe creates a deal analyst from his. Two Droid lanes run side by side. A judge-style attempt: Ben creates an agent told to "include everything about Stonewall" and it gets nothing, because his scope has none. | Agents inherit, never exceed |
| 1:20 | Axe Capital announces its bid. Wags moves the announced terms (the offer price and timing) from `deal/stonewall` to `market/public`; the valuation model and financing stay walled. Ben's and Dollar Bill's scopes pick up the public facts live, the research agent gets them at its next step, and Dollar Bill's desk assistant can now answer him. | Moderators move the wall; agents keep up |
| 1:40 | Benchmark chart: leak attempts against Bullwark vs. a shared-memory baseline, plus missing-context rate and tokens. Then: "Try your own." | Proof it works |
| 1:55 | Close: small finance teams now, a company version later. | Path to production |

**Backup:** a recorded run of the full demo, in case venue Wi-Fi fails. Two more scenarios ready:
Wags promotes Axe to moderator so the founder can approve scopes while Wags is out, and Stonewall dies,
so Wags excludes `deal/stonewall` from the deal analyst's rule and it loses the Stonewall files before
its next step.

**Pitch chart:** leak rate against missing-context rate, one point per benchmark setup (Canon PRD,
Benchmark). The expected story is that shared memory leaks because a prompt is not a wall, and Bullwark
holds at zero leaks without starving real work. The chart shows whatever we actually measure.

**Honesty line for judges:** all data is synthetic, and Bullwark is decision support for a compliance
officer, not a replacement for legal compliance.

## Sponsor tracks

**Four core tracks plus five low-effort add-ons; every sponsor tool does one real job in the product,
which the README states in one line each.**

| Tier | Track | Prize | Why Bullwark fits | Must show |
| --- | --- | --- | --- | --- |
| Core | Hyphenate: Autonomous Systems for Finance | $8,000 / $5,000 / $3,000 + interviews | "Would you hire it?" asks for limited access and a clean record of its work. Every agent has a scope no bigger than its creator's and a full audit trail. | Video opening on the question that doesn't leak; a live scenario judges choose; one line on the seats it fills (compliance analyst, research assistant); what's real vs. simulated |
| Core | Anthropic | $5,000 credits + 1 yr Max 20x + office hours | Named community (Wags at a small hedge fund), a real problem, one thing done well. Claude writes facts and briefs. | Persona, a real interview quote, where Claude could go wrong (leaking across the wall) and how Bullwark prevents it |
| Core | Microsoft: Built for the Real World + Customer Impact | Surface per member + FDE mentorship | Production-minded finance agent with measured usefulness and a path to production | Benchmark chart, audit view, scale slide |
| Core | Factory Droid SDK | $2,000 + credits | Droid runs every agent, with a scope-limited sandbox, and its work is visible | Agent lanes with steps and files; README "Where Droid runs" |
| Add | Moss | AirPods Max / Pro | Moss is the search layer for every scope build, live update and handoff | Search latency on the console; a social post of the demo |
| Add | Armadin: Best Security Hack | Apple headphones | Scopes enforced in code, no refusal to probe, agents capped at their creator's scope, prompt-injection quarantine | Attack box; criteria still "coming soon" |
| Add | Mana.space | $5,000 | Use Mana while building | Public Mana chats or pages, and one moment where Mana changed what we built (e.g. console prototype) |
| Add | Bitdeer AI Model Studio | $500 credits + mice | An open model on Model Studio writes facts from high-volume chat and meeting text | Which step uses it, in the README and the demo |
| Add | Notability | 1 yr Pro + merch | Edan keeps design notes, sketches and decisions there from Saturday on | Notes showing how the design took shape |
| Auto | Cal Hacks general | Overall, Most Technically Complex, Best People-First, Hacker's Choice | Every project is entered | Nothing extra |

**Check on Devpost Saturday:** whether there is a cap on sponsor tracks per project, and Armadin's posted criteria.

## Competitors and positioning

**Memory tools share everything, and permission-aware search copies the permissions apps already
have; Bullwark builds each person's and agent's memory from their task and keeps everything else out of it.**

| Product | What it does | Where Bullwark differs |
| --- | --- | --- |
| [Glean](https://www.glean.com/product/enterprise-graph) | Enterprise search and agents across 275+ apps, showing each user only what source apps already allow | Copies existing permissions; doesn't build per-task scopes, cap agents at their creator's access, or update running agents. Reported 100-seat minimum. |
| [Supermemory](https://supermemory.ai/research), [Mem0](https://mem0.ai/blog/zep-vs-mem0-which-ai-memory-layer-should-you-choose), Zep | Memory engines for developers: store facts, retrieve them | No notion of who may see what; the more they remember, the more they can leak |
| [Memory Store](https://www.ycombinator.com/companies/memory-store), [Compendium](https://www.producthunt.com/products/compendium-2/makers) | Shared "company brain" for small teams and their agents | Built to share everything; Bullwark's job is to share the minimum |
| Built-in memory (ChatGPT, Claude) | Memory inside one vendor's app | Locked to one app, no scopes, no audit trail |
| Control-room compliance software | Restricted lists and wall-crossing records for large banks | Not connected to AI context or agents; priced and staffed for big institutions |

**Positioning in one line:** "Other memory tools ask what's relevant. Bullwark first decides what each
person's memory should hold, then what's relevant."

**Scale path:**

| Tier | What it is |
| --- | --- |
| Small team (what we demo) | One firm, two tiers, its people and agents, one compliance officer as moderator |
| Mid-size firm | Several desks, several moderators, SSO, connectors to email, chat and document storage |
| Company version | Org-wide policies per agent, retention rules, regulator-ready exports; set up with a forward-deployed engineer |

## Build plan

| Owner | Bullwark work |
| --- | --- |
| C · Edan | Moderator console and member view against mock fixtures, then Canon; attack and task sets; finance interviews, sponsor answers, QA after each sync, Notability notes, recording, Devpost logistics, submission and timekeeping |
| B · Victor | Devpost text, README sponsor lines, video script and the two-minute pitch |

| When | Done means |
| --- | --- |
| Sat 04:00–09:00 | Console shell on mock fixtures; sponsor answers (Jev, Droid, Moss, track cap) |
| Sat 09:00–14:00 | Scope builder, scope inspector and feed on mock data; switch to Canon as endpoints land |
| Sat 14:00–20:00 | Agent lanes, handoff inspector, member view; attack and task sets finished |
| Sat 20:00–24:00 | Benchmark chart on screen; Devpost draft by midnight; first video cut |
| Sun 00:00–07:00 | Scope map, attack box, recorded backup demo; rehearse the pitch |
| Sun 07:00–09:00 | Code freeze 07:00; submit by 08:30; deadline 09:00; judging 10:30–12:30 |

**Syncs:** 09:00, 15:00 and 21:00 Saturday: merge, run the demo end to end, then Edan's QA run.
**Cut order if behind:** scope map → attack box → quarantine view → Bitdeer → ChatGPT extension.

## Risks and open questions

| Risk | Mitigation |
| --- | --- |
| A judge gets deal information outside their scope | Canon enforces scopes in code; rehearse the full attack set; the audit view shows exactly what each scope held |
| A screen hints that hidden data exists | Presentation rules 13–15; QA checks every member screen after each sync |
| Scopes are so narrow that work suffers | Show the missing-context rate; Wags edits the rule and the scope rebuilds in seconds |
| No real finance quote | Edan asks at the Hyphenate and other finance sponsor booths; fallback is published regulator guidance |
| Synthetic data looks fake (Hyphenate asks "is it real enough?") | Henry generates the world; Edan reviews it against how a hedge fund actually works (a bidder's own desk is restricted on the target; announced terms become public, models and financing don't) and writes the task and attack sets |
| Venue Wi-Fi fails | Local stack plus a recorded run of the full demo |

**Open questions:**

- [ ] Confirm the demo persona (Wags, COO and compliance at a 30-person hedge fund) while the market stays "small finance teams."
- [ ] Are Billions character names fine in a public video, or should we use lookalike names?
- [ ] Is there a cap on how many sponsor tracks one project can enter?
- [ ] Does the deal-dies scenario go in the main demo or stay as backup?

## Sources

- Cal Hacks 13.0 Hacker Guide (PDF from the organizers): prizes, sponsor track criteria, judging rules
- [Glean Enterprise Graph](https://www.glean.com/product/enterprise-graph)
- [Supermemory research](https://supermemory.ai/research)
- [Mem0 vs Zep](https://mem0.ai/blog/zep-vs-mem0-which-ai-memory-layer-should-you-choose)
- [Memory Store (YC)](https://www.ycombinator.com/companies/memory-store)
- [Compendium on Product Hunt](https://www.producthunt.com/products/compendium-2/makers)
- [Cal Hacks 12.0 project gallery](https://cal-hacks-12-0.devpost.com/project-gallery)
