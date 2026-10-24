# Devpost draft: Bullwark

**Owner:** Victor (task B12). **Draft due:** Sat 10/24 23:59 PDT. **Final submit:** Sun 08:30.
Edan pastes it into Devpost and handles the logistics (C8, C10). Source of truth for the story:
[`PRD.md`](PRD.md) (two tiers and task-built scopes). Video: [`VIDEO_SCRIPT.md`](VIDEO_SCRIPT.md).
Pitch: [`PITCH.md`](PITCH.md). Scale slide: [`SCALE_SLIDE.md`](SCALE_SLIDE.md). Where each
sponsor runs: [`SPONSORS.md`](SPONSORS.md).

**How to use this file**

- Each `##` heading is one Devpost field. This is a draft, not submit-ready text: paste a field
  only with its markers left in (Sat 23:59 draft) or with every marker resolved (final submit).
  Never paste a field with its markers deleted but not resolved.
- Every placeholder is filled or its sentence is deleted before the final submit. Never guess a
  number.
  - `[[BENCH: …]]` comes from `bench/results/latest.json` of a run that is **not** simulated.
  - `[[LIVE COUNTER: …]]` is read off the dashboard during the recorded demo (the live counter,
    or the scope builder's measured stage times).
  - `[[QUOTE: …]]` is the exact words from Edan's interview notes, with the speaker's role and
    their OK to be quoted.
  - `[[CHECK: …]]` is a build fact to confirm against `main` at code freeze (Sun 07:00).
  - `[[SHIPPED? …]]` ends a sentence, bullet or paragraph that describes a part
    [`SPONSORS.md`](SPONSORS.md) doesn't mark **built** yet. It names the rows (`Row: item`).
    At code freeze, look each one up. If every row it names is **built** (on `main` and in the
    demo), delete the marker. If not, rewrite or delete the text it covers (back to the start of
    its bullet or paragraph) so it claims only what shipped. Never delete the marker alone.
- Before submit, this prints nothing. It checks only the Devpost fields (from `## Project name`
  on), so the marker examples in these instructions don't count:
  `awk '/^## Project name/{f=1} f && /\[\[/{print NR": "$0}' docs/DEVPOST.md`
- If a feature didn't ship, delete its sentence. The Devpost text must match what the video
  and the repo show. Never quote a competitor's numbers.
- Wording about access: excluded groups and labels are removed in code before any model sees a
  fact, and at question time code searches only inside a scope's fixed list of fact ids. But
  the judge's answers (Jev, or Claude Haiku when the fallback runs) still help decide what joins
  a scope: which group a fact is filed in at save time, which groups a plain-language exclusion
  covers, and which remaining candidates join. Never write that no model touches access, that a
  scope can't be wrong, or that Bullwark can't leak. Say what the attack set measures instead.
- Bullwark never refuses. Never describe a refusal, a restricted list, a wall-crossing request, a
  deal-status workflow, an exit check or a compliance queue: the PRD cut all of them.

---

## Project name

Bullwark

## Tagline

The control room for a small finance team's AI: moderators see everything, and every other
person and agent gets a memory that holds only what their task needs.

Short version, if the field is tight: **Every AI on the team remembers only what its task needs.**

## Inspiration

Maya is the only compliance officer at a 30-person advisory firm. The firm advises companies on
confidential deals, and it also runs a small research and trading desk. Those two sides must
stay apart. When the deal team is working on a secret acquisition, the traders and researchers
down the hall must not learn about it. That separation is called an information barrier, or a
wall, and the secret details are inside information.

Maya keeps the wall with a spreadsheet of who has been "brought over the wall," her inbox, and
her memory. That worked when information only moved when people talked. Now every banker and
analyst uses two or three AI tools, and the firm is starting to hand work to AI agents. Each one
is a new place a deal code name can leak.

We asked people who do this work how they handle it today:
[[QUOTE: from Edan's notes, answer to "How do you track who's over the wall today?"]]

The obvious fix is an AI that says "I can't discuss that company." But that sentence is itself
a leak: it tells a trader there is something to discuss. So we built the opposite. In Bullwark,
the information was never in that person's memory, so there is nothing to refuse and nothing to
argue past.

Maya and her firm, Harbor Lane Partners, are invented for the demo. The problem is real. Big
banks solve it with whole compliance departments and control-room software that knows nothing
about AI. A 30-person firm has one Maya. We built Bullwark for her.

## What it does

Leo, a trader, asks his desk assistant: "Anything going on with Nimbus Logistics? Should we add
to our position?" Harbor Lane is secretly advising a client that plans to acquire Nimbus. The
deal's code name is Project Falcon. The assistant answers from public news only. It doesn't
refuse, and it doesn't hint that anything is missing, because from its side nothing is: Leo's
memory never held a Falcon fact. Maya opens the scope inspector and sees exactly that: the facts
in Leo's scope, and no Falcon fact ever among them.
[[SHIPPED? Hyphenate: scope builder; Hyphenate: handoff and audit; Hyphenate: moderator console; Factory Droid: agent runs]]

Bullwark is the memory layer for a small finance team's people and AI agents, with access
decided when a memory is built rather than when a question is asked:

1. **Capture.** It pulls in AI sessions (a Claude Code hook and a ChatGPT browser extension),
   deal memos, team chat and meeting notes as they happen. Raw text goes to an archive and is
   never lost. [[SHIPPED? Ingest client]]
2. **Compress and group.** Jev, a judge model, decides what's worth keeping, and Claude writes
   short facts, one claim each, linked to their source and author. Each fact is filed into one
   **group** (`deal/falcon`, `research/logistics`, `market/public`), with optional **labels**
   when a group is too coarse. A fact Jev can't place goes to an `inbox` only moderators see.
   Text with instructions aimed at an AI is quarantined.
   [[SHIPPED? Jev: triage; Anthropic: finance writer; Armadin: quarantine]]
3. **Build a scope.** A moderator describes a member's task in plain language, plus optional
   exclusions. Code removes the excluded groups first. Moss finds candidate facts in what
   remains, and Jev answers yes or no for each one. The yes answers become the member's scope: a
   fixed list of fact ids. The builder shows every stage as it runs, with its measured time.
   [[SHIPPED? Hyphenate: scope builder; Moss: search; Jev: scope and handoff questions]]
4. **Keep scopes current.** A member's own new facts join their scope. Everyone else's new facts
   join only if they pass the same checks against that member's rule. When a moderator edits a
   rule, the scope rebuilds and the change reaches that member's agents.
   [[SHIPPED? Hyphenate: living scopes]]
5. **Hand over the slice.** When a person or agent needs context, Moss searches only inside
   their scope, Jev keeps the facts that help with the request, and code trims to a token budget
   and logs exactly what was sent. [[SHIPPED? Hyphenate: handoff and audit; Moss: search]]
6. **Agents inherit, never exceed.** Anyone can create an agent with the same form: a task, plus
   optional exclusions. Its scope is built from its creator's scope only, so an agent can never
   know more than the person who made it. Agents run on Factory Droid, each in a sandbox folder
   holding only its scope's facts.
   [[SHIPPED? Hyphenate: tiers and agent profiles; Factory Droid: agent runs]]

There are two tiers. **Moderators** like Maya see all memory, add people, set and edit anyone's
scope rule, and promote members. **Members** like Dan, Priya and Leo see only their scope and
create their own agents. Nobody is ever refused, and nothing outside a scope is named, counted or
hinted at: an agent's profile and `canon_whoami` show its task, never its exclusions.
[[SHIPPED? Hyphenate: tiers and agent profiles; Hyphenate: handoff and audit]]

Maya works in the moderator console: people and tiers, the scope builder, a scope inspector, a
live event feed, quarantine, one lane per agent, and a handoff inspector that shows every
candidate fact, Jev's probability for it, what was cut and why, and the final token count.
Members get their own view: my agents, create an agent, my memory.
[[SHIPPED? Hyphenate: moderator console; Hyphenate: member view]]

Maya can also open the memory browser to view and edit facts, or retire one. A retired fact moves
to cold storage with its history kept; nothing is ever hard-deleted. [[SHIPPED? Memory browser]]

**Other memory tools ask what's relevant. Bullwark first decides what each person's memory
should hold, then what's relevant.**

## How we built it

Three paths, each in a fixed order:

```
save:      capture → cold archive → Jev triage (keep? group? AI instructions? relation?) → Claude writer → fact in its group
                                                       └→ quarantine (moderators only)    └→ inbox (moderators only)
scope:     task + exclusions → excluded groups and labels dropped (code) → Moss candidates → Jev yes/no → fixed list of fact ids
handoff:   request → Moss + keyword inside the scope (code-enforced) → Jev relevance → token budget → audit log
```

[[SHIPPED? Jev: triage; Hyphenate: scope builder; Moss: search; Hyphenate: handoff and audit]]

- **Capture.** A Claude Code hook (`hooks/claude-code/`) posts the live transcript on every
  turn. A Chrome extension (`extension/`) captures ChatGPT web sessions while you type. An
  ingest client brings in memos, team chat, meeting notes, email and exported AI sessions. Each
  item carries its author. All of them post to one endpoint, and the raw text lands in a cold
  archive that nothing deletes. The extension is the first capture path we cut if time runs
  short; if it is cut, Dan's ChatGPT session in the demo goes in through the ingest client.
  [[CHECK: which path carried Dan's ChatGPT session in the demo: extension or ingest client]]
  [[SHIPPED? Ingest client]]
- **Jev triage.** The distiller worker (`distiller/`) listens on the server's event stream. For
  each captured item it sends Jev **one** batched request with every question for every draft
  fact: worth remembering? which group (an existing one, a new one, or unsure)? instructions
  aimed at an AI? how does it relate to the closest existing facts? Code applies the thresholds,
  and they lean the safe way. Saving is generous (the archive is the safety net). A group pick
  below 60% confidence, or "unsure," files the fact in `inbox`, which joins no member's scope
  until a moderator files it. A 30% chance of instructions aimed at an AI quarantines the whole
  item. Deal code names and company names are matched in code as a filing hint next to Jev's
  pick. (All thresholds live in `shared/src/types/judge.ts`.) [[SHIPPED? Jev: triage]]
- **Claude writer.** Claude (`claude-sonnet-5-5`) turns kept items into one-claim facts with two
  dates (when it happened, when Bullwark learned it), the author, and a link to the source. Deal
  names stay verbatim so grouping can see them. Old facts are replaced, never deleted, so
  history stays. When Jev isn't available, the judge is the Claude fallback
  (`claude-haiku-5-5`), so Claude also answers the triage questions, including which group a
  fact goes in. [[SHIPPED? Anthropic: finance writer]]
- **Scope builder.** A moderator types a task and optional exclusions: group ids, labels, or a
  plain sentence like "anything about pending deals." Excluded groups and labels are removed in
  code first, so they never reach Moss or Jev and can't come back as "relevant." For a sentence,
  Jev asks of every group whether it falls under the exclusion, and a 20% chance excludes the
  whole group. Then one Moss query finds candidates in what remains, and one batched Jev call
  asks of each candidate: does it fall under the exclusion (a 30% "maybe" counts as yes, so it's
  out), and does it help with this task (70% to join)? The result is a fixed list of fact ids.
  Each stage reports its measured time:
  [[LIVE COUNTER: scope build time per stage for Priya's scope]].
  [[SHIPPED? Hyphenate: scope builder; Moss: search; Jev: scope and handoff questions]]
- **Living scopes.** When a fact is saved, it joins its author's scope, unless it was filed in
  `inbox` (nothing from a quarantined item becomes a fact until a moderator releases it). It
  joins anyone else's scope only if it clears that person's
  exclusions in code, Moss's similarity check against their task, and Jev's yes/no. A rule edit
  rebuilds the scope, and an agent's scope is rebuilt inside its creator's.
  [[SHIPPED? Hyphenate: living scopes]]
- **Search inside the scope.** Moss finds facts by meaning, and keyword search catches exact
  names and code names. Each fact is indexed with its id, group and labels, and a handoff
  filters on the scope's fact ids (or, if a long id list is slow, on groups and labels, with
  out-of-scope results dropped in code), so only facts inside the scope come back.
  [[SHIPPED? Moss: search]]
- **Jev relevance and the token budget.** One batched request: "Does this request need stored
  context at all?" (if not, only the ~200-token pinned profile goes out) and "Does fact *i* help
  with this request?" for every candidate (70% to keep). Code trims the slice to the budget
  (1,500 tokens by default) and writes an audit row with exactly which facts went to whom.
  [[SHIPPED? Hyphenate: handoff and audit; Jev: scope and handoff questions]]
- **No existence signals.** The pinned profile and `canon_whoami` show a person's or agent's
  name, tier and task, never their exclusions, the names of excluded groups, or a count of
  anything hidden. The handoff's candidate list, the scope inspector, the people list and the
  audit log are for moderators only. An agent run that fails says why in a fixed line that never
  quotes a fact. [[SHIPPED? Hyphenate: handoff and audit; Factory Droid: agent runs]]
  [[CHECK: GET /api/facts, /events and /health need a token or are scoped to the caller; nothing outside a member's scope, and no total counts, come back without one. Test with no token: `curl -s localhost:4100/api/facts` and `curl -sN localhost:4100/events` return no `deal/falcon` fact, and `curl -s localhost:4100/health` has no fact count. On `main` today the first returns every fact outside `private/` and the last returns the store's count (lane A)]]
- **Agent profiles.** Anyone can create an agent: a name, a task and optional exclusions. The
  server builds its scope from its creator's scope only and checks in code that it is a subset,
  at build time and on every update. No MCP tool or sandbox can edit a scope rule, a scope or a
  tier, and members can create agents but not people.
  [[SHIPPED? Hyphenate: tiers and agent profiles]]
- **Droid agent runs.** Claude writes a short brief from the most relevant facts in the agent's
  scope. Bullwark creates a sandbox folder for the run, outside the repo and Bullwark's data,
  holding only that scope's facts as markdown files, quoted as information, never instructions.
  It runs Factory Droid headless with `droid exec --auto low`, the lowest level that lets it
  create and edit files. On macOS a sandbox profile also stops it from reading the repo,
  Bullwark's data or another agent's folder.
  [[CHECK: at the Factory booth, that `--auto low` is fine for headless finance runs, whether it runs Python for the numbers at that level, and whether `droid exec --auto low` can make an HTTP GET to localhost:4100 (Bullwark's own server) or reach the network at all; the walls-era `sandbox-exec` profile on PR #9 denies only file paths (blocker Q1)]]
  Each task runs as a few short Droid steps. Every step, file and result streams into that
  agent's lane on the dashboard and becomes its audit record. The agent's new facts are its
  creator's memories. [[SHIPPED? Factory Droid: agent runs; Anthropic: briefs and runner]]
- **Live routing.** Between steps, each agent has an inbox. When a new fact joins an agent's
  scope, Jev answers "Does this agent need it now?" (60% to deliver), and it reaches the agent
  at its next step. When a moderator narrows a scope, the agent loses those facts before its
  next step: drafts and plans may already carry them, so the run folder is discarded and the run
  restarts from the plan step in a fresh folder built from the new scope.
  [[SHIPPED? Factory Droid: live routing]]

**Architecture choices.** TypeScript on Node 22, one npm workspace per part (`server/`,
`distiller/`, `hooks/`, `extension/`, `web/`, `bench/`), each its own process talking over HTTP
and Server-Sent Events. The contract between them is code in `shared/src/types/` (`scopes.ts`
for tiers, groups, scope rules, scopes, quarantine and audit; `agents.ts` for runs, steps and
inboxes), agreed first so three people could build in parallel against fakes. Facts are plain
markdown files with YAML front matter, filed by group (`data/facts/deal/falcon/…`), so the whole
store opens in Obsidian, and raw captures sit next to them as JSON in a cold archive. There is
no database: local files plus plain SSE carry the whole build. Every model sits behind one
`judge()` interface with three implementations: Jev, a Claude fallback (`claude-haiku-5-5`) and
an offline fake that labels itself simulated. Swapping is a config change. Model APIs (Claude,
Jev) are called with plain `fetch` rather than SDKs, and the only third-party runtime
dependencies are the MCP SDK and zod in the server, so there is little to break at 4 AM. AI
tools connect over MCP (`canon_context`, `canon_search`, `canon_save`, `canon_whoami`), one
token per client.

## Challenges we ran into

- **Deciding access before the question, not after.** The easy design is "search everything,
  then let the model decide what to share." That design leaks: a deal fact can come back as the
  most relevant one, and a model can be talked into sharing it. We moved access to the moment a
  scope is built. Exclusions run in code before any model sees a fact, and the result is a fixed
  list of fact ids. At question time, code only searches inside that list, so there is nothing
  for a prompt to argue with. [[SHIPPED? Hyphenate: scope builder; Hyphenate: handoff and audit]]
- **A refusal is a leak.** Our first design had neutral refusals: "I can't help with that
  company right now." But any refusal proves there is something to refuse, and a refusal decided
  by a model can be argued with. We cut refusals entirely. A member's agent answers only from its
  scope, and asked about something outside it, it behaves like any agent that has never heard of
  the topic. Then we hunted down the quieter signals: `canon_whoami` used to list folders, so a
  member's whoami now shows only their task, and counts of hidden facts appear nowhere a member
  can see. [[SHIPPED? Hyphenate: handoff and audit; Factory Droid: agent runs]]
  [[CHECK: the tokenless GET /api/facts, /events and /health check under "No existence signals" passed]]
- **Planted instructions.** Bullwark reads text from outside parties, like the target company's
  lawyers. Our synthetic email hides a line telling the AI to send the Falcon terms to research.
  Triage asks of every item whether it contains instructions aimed at an AI and quarantines it,
  and nothing from it joins any scope until a moderator releases it. Facts reach agents quoted,
  as data, never as instructions. [[SHIPPED? Armadin: quarantine; Anthropic: briefs and runner]]
- **A fact filed in the wrong group.** Code catches deal code names and company names, but a
  paraphrased memo that names none of them depends on Jev's pick. We stacked defenses: labels as
  a second filter, unsure picks to the moderators-only `inbox`, and, when an exclusion is
  written in words, a per-fact "does this fall under the exclusion?" check at scope build where
  "maybe" counts as yes. The paraphrase and indirect attacks in our test set measure what still
  gets through. [[SHIPPED? Jev: triage; Hyphenate: scope builder; Microsoft: finance benchmark]]
- **Agents that can't climb.** If Priya can create an agent, she can tell it "include everything
  about Falcon." So an agent's scope is built from its creator's scope only, checked in code to
  be a subset at build time and on every update. Ten of our 60 attacks try exactly this.
  [[SHIPPED? Hyphenate: tiers and agent profiles; Microsoft: finance benchmark]]
- **Updating agents that are already running.** We designed each agent task as a few short Droid
  steps with an inbox in between, so a rule change takes effect at the next step whether or not
  the runtime accepts messages mid-run. A narrowed scope is the hard case: an agent's drafts may
  already hold a removed fact, so we throw the run folder away and restart from the plan step.
  [[SHIPPED? Factory Droid: live routing]]
- **Droid for finance work.** Droid is built as a coding agent. Our finance tasks are "work over
  a folder": read memos, run Python for the numbers, write a memo file. That framing fits a
  general agent with file and shell tools.
- **Calibrating a judge for compliance.** Saving, building scopes and handing over need different
  bars. We ended up generous at save time, strict at scope build and handoff, and cautious on
  exclusions and injection: a "maybe" counts as excluded, and as quarantined.
- **Not making up numbers.** Every measured figure in this writeup and the video (leaks,
  missing context, accuracy, tokens, latency, cost, scope build time) comes from our own
  benchmark runs or the live dashboard, and until those ran the text held placeholders. The
  other numbers, like the 20%, 30% and 70% thresholds, the 1,500-token budget and the sizes of
  our test sets, are design settings, not results.

## Accomplishments that we're proud of

- Access is decided in code before the question. An excluded group is removed before Moss or
  Jev sees anything, and a member's question is answered only from a fixed list of fact ids.
  What code alone can't guarantee is the filing: a deal fact that triage misfiles into a public
  group, and that Jev's per-fact exclusion check also misses, would reach a scope. The paraphrase
  and indirect attacks in our benchmark are aimed at exactly that.
  [[SHIPPED? Hyphenate: scope builder; Hyphenate: handoff and audit]]
- On our 60-attempt attack set (direct questions, paraphrases, the code name, indirect
  questions, planted instructions and agent escalation, 10 of each), Bullwark with Jev got a
  Falcon fact to a member whose scope excludes it [[BENCH: leaks out of 60, Bullwark + Jev]]
  times. A shared memory told in its prompt to respect the walls leaked
  [[BENCH: leaks out of 60, shared memory]] times.
- It still does the work. On 30 real tasks from both sides of the wall, Bullwark with Jev was
  missing a needed fact on [[BENCH: missing-context rate, Bullwark + Jev]] of them and answered
  [[BENCH: task accuracy, Bullwark + Jev]] correctly, handing over
  [[BENCH: mean tokens per handoff, Bullwark + Jev]] tokens per handoff.
- A scope builds while you watch: exclusions, Moss, Jev, done, each stage with its measured time
  ([[LIVE COUNTER: scope build time, Priya's scope]] for the whole build in the demo).
  [[SHIPPED? Hyphenate: scope builder]]
- Agents inherit and never exceed. Priya's agent told to "include everything about Falcon" got
  nothing about Falcon, because her scope has none.
  [[SHIPPED? Hyphenate: tiers and agent profiles; Factory Droid: agent runs]]
- Live scopes: when Falcon is announced, Maya removes the deal exclusion from two rules, the
  scopes rebuild, and the research agent gets the facts at its next step, with no restart.
  [[SHIPPED? Hyphenate: living scopes; Factory Droid: live routing]]
- Every scope build and change, every fact that joins a scope, every handoff, tier change and
  quarantine is in one audit log, so Maya can answer "who knew what, and when?" in one view.
  [[SHIPPED? Hyphenate: handoff and audit; Hyphenate: moderator console]]
- Three people, one night, one shared contract, and every lane tested offline against fakes.

## What we learned

- **A prompt is not a wall.** Access control and relevance are different problems. Code should
  own access; a model should only make judgment calls inside what code already allows.
- **Decide access before the question.** Once a scope is a fixed list, a clever question has
  nothing to work on. The judgment calls move to build time, where a moderator can inspect them.
- **Any refusal is an existence signal.** "I can't discuss that" tells you there's something to
  discuss. The safest answer is the one an agent gives about a topic it has never heard of.
- **Typed questions beat free-form output.** Asking Jev yes/no and pick-one questions with
  probabilities gives Maya something she can audit, and lets us tune behavior with thresholds in
  code instead of rewriting prompts.
- **"Maybe" should mean "no" on the way in.** Counting an uncertain exclusion as excluded costs
  some missing context, which we measure; guessing the other way costs a leak.
- **Agents need less than you think.** The "inject nothing" check and the token budget keep each
  agent's context small and on task.

## What's next for Bullwark

| Stage | What it is |
| --- | --- |
| Small team (what we demo) | One firm, two tiers, its people and agents, one compliance officer as moderator |
| Mid-size firm | Several desks, several moderators, single sign-on, connectors to email, chat and document storage |
| Company version | Org-wide policies per agent, retention rules, regulator-ready exports, set up with a forward-deployed engineer |

Only the first row is what we built; the other two are design. Our scale slide marks which
parts of the first row are real and which ran simulated.

Next steps after the hackathon: talk to more compliance officers at small firms, run Bullwark on
their real (redacted) workflows, replace the synthetic connectors with real email and chat, draw
a scope map of who can see which groups, and flag when two teammates' notes contradict each other.

## Built with

typescript, node.js, mcp, server-sent-events, claude, claude-sonnet, claude-haiku,
chrome-extension, claude-code-hooks, esbuild, tsx, node-test, obsidian,
[[SHIPPED? Jev: client, verified against TypeSafe's docs and used in the demo, not the Claude fallback]] jev, typesafe-ai,
[[SHIPPED? Factory Droid: agent runs]] factory-droid,
[[SHIPPED? Moss: search]] moss,
[[CHECK: anything Edan added to the `web/` dashboard beyond TypeScript and esbuild]],
[[CHECK: bitdeer-model-studio, only if it shipped]], [[CHECK: mana, only if used]]

## Sponsor tracks

Each paragraph says where the sponsor's tool does real work in the running product. File paths
and build status are in [`docs/SPONSORS.md`](SPONSORS.md).

**Hyphenate: Autonomous Systems for Finance.** Hyphenate asks, "Would you hire it?" Bullwark is
designed around the answer: limited access and a clean record of its work. Every agent has a
scope no bigger than its creator's, and every scope build, scope change and handoff is in the
audit log. It fills two seats at a small firm: a compliance analyst that builds and keeps scopes
and the audit log for Maya, and a research assistant that does real work from a scope that never
held the deal. The video opens on Leo's question that doesn't leak, and judges can try their own
attack live, as a member or by creating an agent. All data is synthetic, and we say exactly what
is real and what is simulated below.
[[SHIPPED? Hyphenate: scope builder; Hyphenate: tiers and agent profiles; Hyphenate: handoff and audit; Armadin: attack box]]

**Anthropic.** We built for a named community: one-person compliance teams at small advisory
firms, like Maya. Claude does the writing. `claude-sonnet-5-5` turns captured memos, chat and AI
sessions into short sourced facts and writes each agent's brief from its scope.
`claude-haiku-5-5` is the fallback judge behind the same `judge()` interface as Jev. The obvious
way Claude could go wrong here is leaking across the wall: writing a deal fact so it reads as
public, or repeating deal details in a brief. Bullwark limits both. Claude only writes briefs
from facts already in the agent's scope, and excluded groups are removed in code before any
model sees a fact. When the Claude fallback judge runs, Claude Haiku answers the triage and
scope questions, including which group a fact goes in, with an unsure pick going to the
moderators-only inbox and a "maybe" on an exclusion counting as excluded. The risk left is a deal
fact misfiled into a public group that the per-fact exclusion check also misses; the paraphrase
and indirect attacks in our benchmark measure it.
[[SHIPPED? Anthropic: finance writer; Anthropic: briefs and runner; Jev: triage; Hyphenate: scope builder]]

**Microsoft: Built for the Real World.** Bullwark is a finance agent system built for production
habits: members start with nothing, exclusions run in code, every handoff is audited, and
usefulness is measured. Our benchmark compares four setups (no memory, shared memory, Bullwark
with a Claude filter, Bullwark with Jev) on leak rate, missing-context rate, task accuracy,
tokens, time to first reply, cost and scope build time. Results:
[[CHECK: link to bench/results/latest.json from a run that is not simulated]]. The scale path
goes from one firm to a company version, and our scale slide marks what is built and what is
design. [[SHIPPED? Microsoft: finance benchmark; Hyphenate: handoff and audit]]
[[CHECK: "members start with nothing" only if the tokenless GET /api/facts, /events and /health check under "No existence signals" passed]]

**Factory Droid SDK.** Droid runs every agent in Bullwark. It isn't a chat wrapper: a member
creates an agent from their scope, and Bullwark runs Droid headless (`droid exec --auto low`) in
a sandbox folder outside the repo that holds only that agent's scope as markdown files, where it
can create and edit files. [[CHECK: Python at `--auto low`, and whether Droid at that level can make an HTTP GET to localhost:4100 or reach the network at all, from the Factory booth (blocker Q1); if it can, drop "exactly what each Droid can see and touch" below]]
Each task runs as a few short steps with an inbox in between. Each step, file and result streams
into the agent's lane on the dashboard. Bullwark controls exactly what each Droid can see and
touch: new in-scope facts reach it at its next step, and when its creator's scope narrows, the
removed facts are gone before its next step. [[SHIPPED? Factory Droid: agent runs; Factory Droid: live routing]]

**Moss.** Moss is the search layer for every scope build, live update and handoff. Each fact is
indexed with its id, group and labels, so a handoff searches only inside the requester's scope.
Its search latency shows on the dashboard counter: [[LIVE COUNTER: Moss search latency]].
[[SHIPPED? Moss: search]]

**Armadin: Best Security Hack.** Bullwark is a security system for information. Scopes are fixed
lists enforced in code at question time, so there is no refusal to probe and nothing for a
prompt to talk a model out of. Agents are capped at their creator's scope. Captured text with
planted instructions is quarantined. Judges can attack it in the attack box, as a member or by
creating an agent.
[[SHIPPED? Hyphenate: scope builder; Hyphenate: tiers and agent profiles; Armadin: quarantine; Armadin: attack box]]

[[CHECK: keep only if it shipped]] **Bitdeer AI Model Studio.** An open model on Bitdeer's Model
Studio writes facts from high-volume team chat and meeting transcripts, where Claude would be
overkill.

[[CHECK: keep only if used, with links]] **Mana.space.** We used Mana while building. Our public
chats and pages are linked below, and Mana changed what we built here:
[[CHECK: one concrete moment, e.g. the moderator console prototype]].

[[CHECK: keep only if used, with links]] **Notability.** Edan kept our design notes, sketches
and decisions in Notability from Saturday on. The notes show how the idea moved from a student
memory tool to walls, and then to task-built scopes.

## What's real and what's simulated

All data is synthetic: Harbor Lane Partners, Project Falcon, Nimbus Logistics, and Maya, Dan,
Priya and Leo are invented. Bullwark is decision support for a compliance officer, not a replacement
for legal compliance.

| Part | State at submit |
| --- | --- |
| Capture: Claude Code hook, ChatGPT web (extension, or the ingest client if the extension is cut), memos, chat and email through the ingest client | [[CHECK: real / not shipped]] |
| Storage and events | Local files and plain SSE, no database |
| Jev triage (keep, group, AI instructions, relation) and quarantine | [[CHECK: real Jev / Claude fallback / simulated fake judge]] |
| Claude fact writer and briefs | [[CHECK: real / simulated]] |
| Scope builder, living scopes, tiers and agent profiles | [[CHECK: real / not shipped]] |
| Handoff inside the scope, token budget, audit log | [[CHECK: real / not shipped]] |
| Moss search | [[CHECK: real Moss / keyword fallback]] |
| Droid agents and live routing | [[CHECK: real `droid exec` / Claude fallback runner / simulated fake runner]] |
| Moderator console, member view, memory browser | [[CHECK: real / not shipped]] |
| Benchmark numbers | From our own runs only: [[CHECK: link to bench/results/latest.json]] |

## Links

- Repo: [[CHECK: GitHub URL]]
- Video: [[CHECK: video URL]]
- Scale slide: [[CHECK: link to the slide built from docs/SCALE_SLIDE.md]]
