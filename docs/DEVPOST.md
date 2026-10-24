# Devpost draft: Canon

**Owner:** Victor (task B12). **Draft due:** Sat 10/24 23:59 PDT. **Final submit:** Sun 08:30.
Edan pastes it into Devpost and handles the logistics (C8, C10). Source of truth for the story:
[`PRD.md`](PRD.md). Video: [`VIDEO_SCRIPT.md`](VIDEO_SCRIPT.md). Pitch:
[`PITCH.md`](PITCH.md). Scale slide: [`SCALE_SLIDE.md`](SCALE_SLIDE.md). Where each sponsor runs:
[`SPONSORS.md`](SPONSORS.md).

**How to use this file**

- Each `##` heading is one Devpost field. This is a draft, not submit-ready text: paste a field
  only with its markers left in (Sat 23:59 draft) or with every marker resolved (final submit).
  Never paste a field with its markers deleted but not resolved.
- Every placeholder is filled or its sentence is deleted before the final submit. Never guess a
  number.
  - `[[BENCH: …]]` comes from `bench/results/latest.json` of a run that is **not** simulated.
  - `[[LIVE COUNTER: …]]` is read off the dashboard counter during the recorded demo.
  - `[[QUOTE: …]]` is the exact words from Edan's interview notes, with the speaker's role and
    their OK to be quoted.
  - `[[CHECK: …]]` is a build fact to confirm against `main` at code freeze (Sun 07:00).
  - `[[SHIPPED? …]]` ends a sentence, bullet or paragraph that describes a part
    [`SPONSORS.md`](SPONSORS.md) doesn't mark **built** yet. It names the rows (`Row: item`).
    At code freeze, look each one up. If every row it names is **built** (on `main` and in the
    demo), delete the marker. If not, rewrite or delete the text it covers (back to the start of
    its bullet or paragraph) so it claims only what shipped. Never delete the marker alone.
- Before submit, `grep -n "\[\[" docs/DEVPOST.md` prints nothing.
- If a feature didn't ship, delete its sentence. The Devpost text must match what the video
  and the repo show. Never quote a competitor's numbers.
- Wording about access: no model can lower a wall or grant access, but at save time the judge's
  answers (Jev, or Claude Haiku when the fallback runs) help set a fact's wall label. Never
  write that no model touches the label, or that the wall can't fail. Say what the attack set
  measures instead.

---

## Project name

Canon

## Tagline

The control room for a small finance team's AI: every person and agent gets only the context
they're cleared to see and need, and the walls stay up on their own.

Short version, if the field is tight: **Context with walls for a small finance team's AI.**

## Inspiration

Maya is the only compliance officer at a 30-person advisory firm. The firm advises companies on
confidential deals, and it also runs a small research and trading desk. Those two sides must
stay apart. When the deal team is working on a secret acquisition, the traders and researchers
down the hall must not learn about it. That separation is called an information barrier, or a
wall, and the secret details are inside information.

Maya keeps the wall with a spreadsheet of who has been "brought over the wall," her inbox, and
her memory. That worked when information only moved when people talked. Now every banker and
analyst uses two or three AI tools, and the firm is starting to hand work to AI agents. Each one
is a new place a deal code name can leak, and none of them know where the walls are.

We asked people who do this work how they handle it today:
[[QUOTE: from Edan's notes, answer to "How do you track who's over the wall today?"]]

Maya and her firm, Harbor Lane Partners, are invented for the demo. The problem is real. Big
banks solve it with whole compliance departments and control-room software that knows nothing
about AI. A 30-person firm has one Maya. We built Canon for her.

## What it does

Leo, a trader, asks the desk assistant: "Anything going on with Nimbus Logistics? Should we add
to our position?" Harbor Lane is secretly advising a client that plans to acquire Nimbus. The
deal's code name is Project Falcon. The assistant answers: "I can't help with that company right
now. It's on the restricted list. Contact compliance." That is all Leo sees. At the same moment,
Maya's control room shows the full record: who asked, what they asked, and which deal it touched.
[[SHIPPED? Hyphenate: server and control room]]

Canon is the context layer for a small finance team's people and AI agents. It runs five steps
on every piece of context:

1. **Capture.** It pulls in AI sessions (a Claude Code hook and a ChatGPT browser extension),
   deal memos, team chat, meeting notes and email as they happen. Raw text goes to an archive
   and is never lost. [[SHIPPED? Ingest client]]
2. **Triage.** Jev, a judge model, answers yes/no questions about each item. Is it worth
   remembering? Does it look confidential? Which deal is it about? Does it contain instructions
   aimed at an AI? How does it relate to what we already know? [[SHIPPED? Jev: triage]]
3. **Wall and store.** Claude turns each kept item into short facts, one claim each, linked to
   the source. Code gives each fact a wall label (a deal, or public) from fixed rules plus the
   judge's answers, and from then on the label only moves up: no model can lower a wall or
   grant access. Anything uncertain goes to Maya's review queue.
   [[SHIPPED? Anthropic: finance writer; Armadin: triage and labels]]
4. **Hand over the slice.** When a person or agent needs context, code first removes every fact
   they aren't cleared for. Only then does search run, and Jev keeps the few facts that help
   with the task, cut to a token budget. Every handoff is logged.
   [[SHIPPED? Hyphenate: server and control room; Jev: handoff and pre-screen]]
5. **Dispatch and update live.** Canon sends Factory Droid agents to do the work, each in a
   sandbox folder that holds only its side of the wall. When a deal is announced, a deal dies,
   or a new fact lands, Canon routes the change to the agents that need it and stops the ones
   that shouldn't continue. [[SHIPPED? Factory Droid]]

Maya runs it from the control room: the deals and who is over each wall, pending access
requests with approve and deny, a live event feed, one lane per agent, and a handoff inspector
that shows every candidate fact, Jev's probability for it, what was cut and why, and the final
token count. [[SHIPPED? Hyphenate: server and control room]]

Maya can also open the memory browser to view and edit facts, or retire one. A retired fact moves
to cold storage with its history kept; nothing is ever hard-deleted. [[SHIPPED? Memory browser]]

**Other memory tools ask what's relevant. Canon first asks what you're allowed to know, then
what's relevant.**

## How we built it

Every handoff runs the same pipeline, in this order:

```
capture → Jev triage → Claude writer → [permission filter] → Moss + keyword search → Jev relevance → token budget → audit log
```

[[SHIPPED? Moss; Jev: triage; Jev: handoff and pre-screen; Hyphenate: server and control room]]

- **Capture.** A Claude Code hook (`hooks/claude-code/`) posts the live transcript on every
  turn. A Chrome extension (`extension/`) captures ChatGPT web sessions while you type. An
  ingest client brings in memos, team chat, meeting notes, email and exported AI sessions. All of
  them post to one endpoint, and the raw text lands in a cold archive that nothing deletes. The
  extension is the first capture path we cut if time runs short; if it is cut, Dan's ChatGPT
  session in the demo goes in through the ingest client instead.
  [[CHECK: which path carried Dan's ChatGPT session in the demo: extension or ingest client]]
  [[SHIPPED? Ingest client]]
- **Jev triage.** The distiller worker (`distiller/`) listens on the server's event stream. For
  each captured item it sends Jev **one** batched request with every question for every draft
  fact. Code applies the thresholds, and they lean the safe way: generous on "worth keeping"
  (the archive is the safety net), cautious on security. A 20% chance that text is confidential
  counts as yes. A 30% chance that it holds instructions aimed at an AI sends the whole item to
  quarantine. A "which deal?" pick below 60% confidence goes to Maya's queue as "unsure." (All
  thresholds live in `shared/src/types/judge.ts`.) [[SHIPPED? Jev: triage]]
- **Claude writer.** Claude (`claude-sonnet-5-5`) turns kept items into one-claim facts with two
  dates (when it happened, when Canon learned it) and a link to the source. Claude writes the
  fact text; code sets the wall label from fixed rules (deal code names, aliases and company
  names, matched in code) plus the judge's answers to "does this look confidential?" and "which
  deal?". When Jev isn't available, the judge is the Claude fallback (`claude-haiku-5-5`), so
  Claude answers those two questions. Either way a 20% chance of "confidential" counts as yes,
  and the label only moves toward more restricted. No model can lower a label or grant access;
  only Maya or a deal-status change can. Old facts are replaced, never deleted, so history
  stays. [[SHIPPED? Anthropic: finance writer; Armadin: triage and labels]]
- **Permission filter, before anything else.** When a person or agent asks for context, plain
  code drops every fact whose wall they aren't cleared for. Access is deny by default. An agent's
  clearance is its side of the wall intersected with the live clearances of the person it works
  for, so it never sees more than its person. The restricted list and the secret watch list are
  checked in code on every request, and a hit gets a neutral refusal. Restricted facts never
  reach search or Jev, so they can't come back as "relevant."
  [[SHIPPED? Hyphenate: server and control room; Armadin: filter and exit check]]
- **Search.** Moss finds candidate facts by meaning, and keyword search catches exact names and
  code names, both only inside what's left after the filter. [[SHIPPED? Moss]]
- **Jev relevance.** One batched request: "Does this task need stored context at all?" (if not,
  only the ~200-token pinned profile goes out) and "Does fact *i* help with this task?" for every
  candidate. Only facts above 70% are kept. [[SHIPPED? Jev: handoff and pre-screen]]
- **Token budget and audit.** Code trims the slice to the budget (1,500 tokens by default) and
  writes an audit row with exactly which facts went to whom, for which task.
  [[SHIPPED? Hyphenate: server and control room]]
- **Droid dispatch.** A person types one task in the control room. The dispatcher splits it into
  agent runs, one per side of the wall. Each agent gets its slice through the same pipeline, as
  its own principal. Claude writes a short brief from that slice. Canon creates a sandbox folder
  per agent, outside the repo and Canon's data, holding only the allowed files, and runs Factory
  Droid headless with `droid exec --auto low`, the lowest level that lets it create and edit
  files. On macOS a sandbox profile also stops it from reading the repo, Canon's data or another
  agent's folder. When a run ends, its folder is locked and kept as the run's record.
  [[CHECK: at the Factory booth, that `--auto low` is fine for headless finance runs, whether it runs Python for the numbers at that level, and whether it can reach the network (blocker Q1)]]
  Each task runs as a few short Droid steps. Every step, file and result streams into that
  agent's lane on the dashboard and becomes its audit record.
  [[SHIPPED? Factory Droid; Anthropic: briefs and runner]]
- **Live routing.** Between steps, each agent has an inbox. When a new fact lands or a wall
  changes, Jev answers two questions per running agent: "Does agent *k* need this?" and "Does
  this cancel agent *k*'s work?" Wall changes are urgent and are applied before the next step.
  A terminated deal cancels the deal agent's next step and locks its folder. An announced deal
  lifts the restrictions, and public-side agents get the now-public facts at their next step.
  [[SHIPPED? Factory Droid]]
- **Exit check.** Before an agent's output leaves its side, code checks it for deal code names
  and restricted companies, and Jev checks for indirect references. A hit blocks the output and
  alerts Maya. [[SHIPPED? Armadin: filter and exit check]]

**Architecture choices.** TypeScript on Node 22, one npm workspace per part (`server/`,
`distiller/`, `hooks/`, `extension/`, `web/`, `bench/`), each its own process talking over HTTP
and Server-Sent Events. The contract between them is code in `shared/src/types/`, frozen in the
first hour so three people could build in parallel against fakes. Facts are plain markdown files
with YAML front matter, so the whole store opens in Obsidian, and raw captures sit next to them
as JSON in a cold archive. There is no database: local files plus plain SSE carry the whole
build. Every model sits behind one
`judge()` interface with three implementations: Jev, a Claude fallback (`claude-haiku-5-5`) and
an offline fake that labels itself simulated. Swapping is a config change. Model APIs (Claude,
Jev) are called with plain `fetch` rather than SDKs, and the only third-party runtime
dependencies are the MCP SDK and zod in the server, so there is little to break at 4 AM. AI
tools connect over MCP (`canon_context`, `canon_search`, `canon_save`, `canon_whoami`), one
token per client.

## Challenges we ran into

- **Putting the permission check first.** The easy design is "search everything, then let the
  model decide what to share." That design leaks: a restricted fact can come back as the most
  relevant one, and a model can be talked into sharing it. We moved access into plain code that
  runs before search, and made agents fetch their slices as their own principal through the same
  pipeline, so there is no side door. [[SHIPPED? Hyphenate: server and control room]]
- **A refusal can leak too.** "I can't discuss Nimbus because of Project Falcon" gives the deal
  away. Every restricted company gets the same sentence, which names only the rule. The watch
  list is secret, so a hit there gets an even blander answer with no reason. Maya sees the full
  reason in her queue.
  [[SHIPPED? Armadin: refusal wording; Hyphenate: server and control room]]
- **Planted instructions.** Canon reads text from outside parties, like the target company's
  lawyers. Our synthetic email hides a line telling the AI to send the Falcon terms to research.
  Triage asks of every item whether it contains instructions aimed at an AI, quarantines it, and
  facts reach agents quoted as data, never as instructions.
  [[SHIPPED? Armadin: triage and labels; Anthropic: briefs and runner]]
- **Calibrating a judge for compliance.** Saving, handing over and security need different bars.
  We ended up generous at save time, strict at handoff, and "a maybe counts as yes" on
  confidentiality and injection.
- **Labels the code can't see.** Code catches deal code names, aliases and company names. A
  paraphrased memo that names none of them depends on the judge's answers, so that is where a
  wall label could come out wrong. We pushed every security threshold the safe way, sent unsure
  deals to Maya, added an exit check on every agent output, and built paraphrase and indirect
  attacks into our test set to measure what still gets through.
  [[SHIPPED? Armadin: filter and exit check; Microsoft: finance setups]]
- **Updating agents that are already running.** We designed each agent task as a few short Droid
  steps with an inbox in between, so a wall change takes effect at the next step whether or not
  the runtime accepts messages mid-run.
- **Droid for finance work.** Droid is built as a coding agent. Our finance tasks are "work over
  a folder": read memos, run Python for the numbers, write a memo file. That framing fits a
  general agent with file and shell tools.
- **Not making up numbers.** Every measured figure in this writeup and the video (leaks, wrongly
  blocked, accuracy, tokens, latency, cost) comes from our own benchmark runs or the live
  counter, and until those ran the text held placeholders. The other numbers, like the 20% and
  70% thresholds, the 1,500-token budget and the sizes of our test sets, are design settings,
  not results.

## Accomplishments that we're proud of

- The permission check is plain code. A fact behind a wall the requester isn't cleared for is
  removed before search and before any model sees the request, so no prompt can talk a model
  into revealing it. What code alone can't guarantee is the label itself: a deal fact that both
  the alias rules and the judge miss at save time would read as public. The exit check and the
  paraphrase and indirect attacks in our benchmark are aimed at exactly that.
  [[SHIPPED? Hyphenate: server and control room; Armadin: filter and exit check]]
- On our 50-attempt attack set, Canon with Jev leaked [[BENCH: leaks out of 50, Canon + Jev]]
  times. A shared memory told in its prompt to respect the walls leaked
  [[BENCH: leaks out of 50, shared memory]] times.
- It still does the work. On 30 real tasks from both sides of the wall, Canon wrongly blocked
  [[BENCH: wrongly blocked rate, Canon + Jev]] and answered
  [[BENCH: task accuracy, Canon + Jev]] correctly, handing over
  [[BENCH: mean tokens per handoff, Canon + Jev]] tokens per handoff.
- Every handoff, refusal, approval, label change and quarantine is in one audit log, so Maya can
  answer "who knew what, and when?" in one view. [[SHIPPED? Hyphenate: server and control room]]
- Agents that respect the wall: two Droid agents on opposite sides of Project Falcon work on one
  request at the same time, and the handoff inspector shows which facts each one got and why.
  [[SHIPPED? Factory Droid; Hyphenate: server and control room]]
- Live walls: when Falcon is announced, the desk assistant can answer Leo and the research agent
  picks up the public facts at its next step, with no restart.
  [[SHIPPED? Factory Droid; Hyphenate: server and control room]]
- Three people, one night, one frozen contract, and every lane tested offline against fakes.

## What we learned

- **A prompt is not a wall.** Access control and relevance are different problems. Code should
  own access; a model should only make judgment calls inside what code already allows.
- **Typed questions beat free-form output.** Asking Jev yes/no and pick-one questions with
  probabilities gives Maya something she can audit, and lets us tune behavior with thresholds in
  code instead of rewriting prompts.
- **Knowing when to ask a human is a feature.** The borderline middle (an unsure deal label, a
  vague access request) goes to compliance instead of being decided by a model.
- **The refusal is part of the security surface.** What you say when you say no matters as much
  as the no.
- **Agents need less than you think.** The "inject nothing" check and the token budget keep each
  agent's context small and on task.

## What's next for Canon

| Stage | What it is |
| --- | --- |
| Small team (what we demo) | One firm, its deals and walls, its people and agents, one compliance officer |
| Mid-size firm | Several desks and several compliance staff, single sign-on, connectors to email, chat and document storage |
| Company version | Org-wide policies per agent, retention rules, regulator-ready exports, set up with a forward-deployed engineer |

Only the first row is what we built; the other two are design. Our scale slide marks which
parts of the first row are real and which ran simulated.

Next steps after the hackathon: talk to more compliance officers at small firms, run Canon on
their real (redacted) workflows, replace the synthetic connectors with real email and chat, and
flag when two teammates' notes contradict each other.

## Built with

typescript, node.js, mcp, server-sent-events, claude, claude-sonnet, claude-haiku,
chrome-extension, claude-code-hooks, esbuild, tsx, node-test, obsidian,
[[SHIPPED? Jev: client, verified against TypeSafe's docs and used in the demo, not the Claude fallback]] jev, typesafe-ai,
[[SHIPPED? Factory Droid]] factory-droid,
[[SHIPPED? Moss]] moss,
[[CHECK: anything Edan added to the `web/` dashboard beyond TypeScript and esbuild]],
[[CHECK: bitdeer-model-studio, only if it shipped]], [[CHECK: mana, only if used]]

## Sponsor tracks

Each paragraph says where the sponsor's tool does real work in the running product. File paths
and build status are in [`docs/SPONSORS.md`](SPONSORS.md).

**Hyphenate: Autonomous Systems for Finance.** Hyphenate asks, "Would you hire it?" Canon is
designed around the answer: limited access, a clean record of its work, and knowing when to ask
a person. It fills two seats at a small firm: a compliance analyst that keeps the walls and the
audit log for Maya, and a research assistant that does real work without ever crossing the wall.
The video opens on the refusal, and judges can type their own attempt to extract Falcon
information live. All data is synthetic, and we say exactly what is real and what is simulated
below. [[SHIPPED? Hyphenate: server and control room; Armadin: attack box]]

**Anthropic.** We built for a named community: one-person compliance teams at small advisory
firms, like Maya. Claude does the writing. `claude-sonnet-5-5` turns captured memos, chat and AI
sessions into short sourced facts and writes each agent's brief from its slice.
`claude-haiku-5-5` is the fallback judge behind the same `judge()` interface as Jev. The obvious
way Claude could go wrong here is leaking across the wall, by summarizing a deal memo into a
fact that reads as public or by repeating deal details in a brief. Canon limits both. No model
can lower a wall or grant access, and Claude only writes briefs from facts that already passed
the permission filter. At save time, code rules plus the judge's answers set each fact's wall
label, and it can only move up. When the Claude fallback judge runs, Claude Haiku answers the
"is this confidential?" and "which deal?" questions, and a 20% chance counts as yes. The risk
left is a deal fact that both the alias rules and the judge miss; the paraphrase and indirect
attacks in our benchmark and the exit check measure it.
[[SHIPPED? Anthropic: finance writer; Anthropic: briefs and runner; Armadin: triage and labels]]

**Microsoft: Built for the Real World.** Canon is a finance agent system built for production
habits: deny by default, an audit log of every handoff, humans approving anything uncertain, and
measured usefulness. Our benchmark compares four setups (no memory, shared memory, Canon with a
Claude filter, Canon with Jev) on leak rate, wrongly-blocked rate, task accuracy, tokens, latency
and cost. Results: [[CHECK: link to bench/results/latest.json from a run that is not simulated]].
The scale path goes from one firm to a company version, and our scale slide marks what is built
and what is design.
[[SHIPPED? Microsoft: finance setups; Hyphenate: server and control room]]

**Factory Droid SDK.** Droid runs every agent Canon dispatches. It isn't a chat wrapper: a
person's task triggers the dispatcher, which runs Droid headless (`droid exec --auto low`) in a
sandbox folder outside the repo that holds only its side of the wall, where it can create and
edit files. [[CHECK: Python at `--auto low`, from the Factory booth (blocker Q1)]] Each task runs
as a few short steps with an inbox in between. Each step, file and result streams into the agent's lane on the dashboard.
Canon controls exactly what each Droid can see and touch, and can cancel it when a deal dies.
The dispatcher is in `distiller/src/dispatch/`. [[SHIPPED? Factory Droid]]

**Moss.** Moss is the search-by-meaning step on every handoff and every routing check. It runs
after the permission filter, so it only searches facts the requester is cleared for. Its search
latency shows on the dashboard counter: [[LIVE COUNTER: Moss search latency]].
[[SHIPPED? Moss]]

**Armadin: Best Security Hack.** Canon is a security system for information. The walls are
enforced in code, refusals don't leak the deal they protect, captured text with planted
instructions is quarantined, and every agent output passes an exit check for code names,
restricted companies and indirect references before it leaves its side. Judges can attack it in
the attack box.
[[SHIPPED? Armadin: triage and labels; Armadin: refusal wording; Armadin: filter and exit check; Armadin: attack box]]

[[CHECK: keep only if it shipped]] **Bitdeer AI Model Studio.** An open model on Bitdeer's Model
Studio writes facts from high-volume team chat and meeting transcripts, where Claude would be
overkill.

[[CHECK: keep only if used, with links]] **Mana.space.** We used Mana while building. Our public
chats and pages are linked below, and Mana changed what we built here:
[[CHECK: one concrete moment, e.g. the control room prototype]].

[[CHECK: keep only if used, with links]] **Notability.** Edan kept our design notes, sketches
and decisions in Notability from Saturday on. The notes show how the idea moved from a student
memory tool to context with walls.

## What's real and what's simulated

All data is synthetic: Harbor Lane Partners, Project Falcon, Nimbus Logistics, and Maya, Dan,
Priya and Leo are invented. Canon is decision support for a compliance officer, not a replacement
for legal compliance.

| Part | State at submit |
| --- | --- |
| Capture: Claude Code hook, ChatGPT web (extension, or the ingest client if the extension is cut), memos, chat and email through the ingest client | [[CHECK: real / not shipped]] |
| Storage and events | Local files and plain SSE, no database |
| Jev triage and relevance | [[CHECK: real Jev / Claude fallback / simulated fake judge]] |
| Claude fact writer and briefs | [[CHECK: real / simulated]] |
| Permission filter, lists, neutral refusals, audit log | [[CHECK: real / not shipped]] |
| Moss search | [[CHECK: real Moss / keyword fallback]] |
| Droid agents | [[CHECK: real `droid exec` / Claude fallback runner / simulated fake runner]] |
| Memory browser (view, edit, retire) | [[CHECK: real / not shipped]] |
| Benchmark numbers | From our own runs only: [[CHECK: link to bench/results/latest.json]] |

## Links

- Repo: [[CHECK: GitHub URL]]
- Video: [[CHECK: video URL]]
- Scale slide: [[CHECK: link to the slide built from docs/SCALE_SLIDE.md]]
