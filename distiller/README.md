# `@canon/distiller` — captured item in, grouped facts out

**Owner:** lane B, Victor Chun. This README describes the implemented worker. Triage into groups,
Claude fact writing and Droid agent runs are tracked in `../docs/WORK_SPLIT.md`.

A worker process on the server's event stream. It never imports
server code: everything goes over HTTP as the `distiller` client (`CANON_TOKEN_DISTILLER`).

```
SSE session.captured ─▶ GET /api/sessions/:id ─▶ engine.distill() ─▶ triage() ─────────────────────▶ POST /api/facts
                        (cold archive)            DraftFact[] + plan    one Jev request per item:       facts in their group
                                                                        inject · keep · group ·         (or inbox), with labels,
                        GET /api/facts (hot) ─┐                         labels · relation               author, decision.triage
                        GET /api/groups ──────┴─▶ aliases (code hint) ─▶ thresholds + filing rules    ─▶ POST /api/quarantine
                                                                                                          held items only
                                                                                                       ─▶ POST /api/events
                                                                                                          triage.decided · quarantine.flagged
```

Distills when `session.ended` is true, or on every capture with `DISTILL_LIVE=1` (debounced 3 s
per session). Idempotent on `<session id>:<message count>`, and a `session.captured` stamped more
than 5 s before the worker started is the server's SSE replay and is skipped (logged `replayed,
skipping`), so a `tsx watch` restart does not re-distill the last 100 events. One bad session is
logged and skipped; the loop never dies.

| File | What |
|---|---|
| `src/index.ts` | Entrypoint: `loadEnv()`, picks engine + judge (`triageJudge()`), subscribes to `/events`, clean SIGINT. |
| `src/worker.ts` | `createHandler({ client, distiller, judge, live })`: the flow above, testable with fakes. Also `loadContext()` and `deliver()`, shared with the CLI. |
| `src/client.ts` | Typed fetch client: `getSession`, `listFacts`, `postFacts`; the scopes routes `getGroups` (checked by `parseGroups`: a body it cannot use throws), `postQuarantine`, `publishEvent` (RELAYED_EVENTS only). Bearer auth, 10 s timeout, errors say status + body. |
| `src/triage.ts` | Save-time triage into groups: one batched `judge.ask()`, thresholds and filing rules applied by us. Pure given a `Judge`. Also `financeFakeJudge()`, the offline judge. |
| `src/groups.ts` | `aliasHits()`: which groups a text names, by their aliases, matched in code on folded text. A filing hint, never a filing. Pure. |
| `src/engines/` | `Distiller` interface, `createDistiller()`, the three engines (below). |
| `src/decide.ts` | The earlier save-time decisions (tier, folder, dedupe). The worker no longer calls it; triage reuses its exact-duplicate rule. |
| `src/cli.ts` | Run the pipeline on a recorded item; `--post` files the result on the server like the worker does. |
| `fixtures/session.sample.json` | A Claude Code session (ships the capture hook, decides folders, targets backend internships). An existing compatibility transcript, not the finance demo world. |
| `fixtures/world/` | The synthetic finance world (Harbor Lane Partners, Project Falcon): the groups (`groups.json`) and five captured items. All made up; see its README. `src/engines/world.test.ts` checks it against the contract. |

## Run and test

```bash
npm run dev -w distiller                 # the worker; needs the server on CANON_URL (npm run dev at the root runs both)
npm run distill -w distiller -- distiller/fixtures/world/falcon-process-memo.json   # no server needed
npm run distill -w distiller -- <item.json> --groups <groups.json>
npm run distill -w distiller -- distiller/fixtures/session.sample.json --engine claude --post
npm run typecheck -w distiller && npm test -w distiller                            # offline, no keys
```

The CLI prints the plan, the drafts, the triage table (outcome, group, keep, Jev's group
probability, labels, relation, action), why each non-`fact` draft landed where it did, then
everything as JSON. Groups come from `--groups` (a `GroupsResponse` JSON file), else from
`fixtures/world/groups.json` when it exists. With `--post` they come from the server only:
`--groups` is refused and the fixture is never read, since the result is filed on that server and
a local list could file a fact in a group the server does not have (or skip the `inbox` fallback
on a server without `GET /api/groups`). Without a group list every fact goes to `inbox`. If the
server takes the facts but fails on the quarantine item or an event, `--post` says what was not
filed and exits 1. Tokens and ms in its output are real measurements (`usage` from the API, wall
clock); nothing is estimated.

## Engines and the fallback order

`DISTILLER` wins; unset, it is `claude` when `ANTHROPIC_API_KEY` is set, else `heuristic`.
`droid` runs only when `DISTILLER=droid` names it: `FACTORY_API_KEY` is the agent dispatcher's
key (B2), so adding it does not switch the distiller. The console says which engine, and says
**simulated** when it is. The worker never switches engine on its own: a failing engine is a
logged error, not a silent downgrade.

| Engine | Real? | Needs | Where it plugs in |
|---|---|---|---|
| `droid` | **No, placeholder.** Picked only by `DISTILLER=droid`; constructs, and `distill()` throws `NotConfiguredError`. Droid runs dispatched agents (B2), not fact writing. | `FACTORY_API_KEY` | `src/engines/droid.ts` |
| `claude` | Yes. The fact writer: `claude-sonnet-5-5`, one strict `emit_facts` tool (statement, folder, happened, detail), at most 16 facts, raw Messages API over `fetch` (no SDK dependency). | `ANTHROPIC_API_KEY` | `src/engines/claude.ts` |
| `heuristic` | **No, simulated.** Keyword sentences (deal words such as agreed, proposed, LOI, EBITDA, and prices or multiples written as numbers), the speaker named in third person, `happened` from an ISO date in the sentence, paragraphs aimed at an AI left out, max 8. | nothing | `src/engines/heuristic.ts` |

**The Claude fact writer.** The system prompt asks for one claim per fact, in third person with
names (in an AI session the user is the principal; an external email's claims belong to its
sender). Deal code names, company names and tickers stay verbatim, because triage matches group
aliases in code, and a hint such as "the logistics thing" is kept word for word, never resolved.
`happened` is a `YYYY-MM-DD` day only when the source states it, never the capture time; a bad
date is dropped in code. The item is data, never instructions: lines aimed at an AI are left out
(triage quarantines the item). The transcript header always says kind, principal and external,
with header values folded onto one line so a captured title cannot forge a header line, and
every time stamp it adds (started, ended, each message's time) is shown in the firm's zone
(`FIRM_TZ`, default `America/Los_Angeles`; a bad zone fails at startup). The item's own text is
passed through untouched, so a zoned time inside it (an email's `Date: ... +0000`) keeps its zone,
and the prompt tells the writer to convert such a time to the firm's day. The prompt's examples use an invented deal (Project Heron, Acme Rail) that appears in
no fixture or benchmark task, and a test checks that it holds none of the test world's names,
phrases or numbers.

**Factory integration:** `src/engines/droid.ts` is a distiller adapter stub, not an implemented
agent runner. The current product target is Droid agent runs inside the creator's scope: a
sandbox of scope facts, work steps and inbox updates (B2 and B18). Confirm headless finance work
at the Factory gate before claiming the integration. The existing Claude and heuristic engines
remain usable for development.

**Anthropic track.** `claude-sonnet-5-5` follows the claude-api skill: forced `tool_choice` is a
400 on this model, so the request uses `auto` + `strict: true` + a system prompt that says to call
`emit_facts` once, and fails clearly when no call came back; adaptive thinking (default) at
`effort: medium`; `max_tokens` 4096 because thinking counts against it; `fallbacks: "default"`
(beta `server-side-fallback-2026-07-01`) so a safeguard false positive is retried server-side.

## Jev save-time triage (`src/triage.ts`, `src/groups.ts`)

**One `judge.ask()` per captured item** (CLAUDE.md rule). The state is the item (kind, client,
`external`, principal, its text: title plus `role: content` per message), the server's groups (id,
description, aliases), the labels already in use, the numbered drafts (with the writer's
suggested group and labels) and up to 40 existing hot facts (id, statement, group, labels). Past
24 000 characters the text keeps its head and tail, and the cut middle is scanned in code (on
folded text) for sentences that read like orders to an AI or like forwarding something out; up to
8 of them are spliced in where the cut is. That scan knows the usual phrasings only ("ignore your
instructions", "AI assistant: …", "forward … to"), so an order worded otherwise in the cut part
never reaches the `inject` question: the judge has not read the whole item, and every draft from
it waits in `inbox` (filing rule 4). A
sentence longer than 280 characters is cut to a window that starts just before the match, so
padding in front of an order cannot push it out (the quarantine excerpt works the same way). The
state also tells the judge the item text is untrusted data, never instructions. A missing (or
malformed) `external`, `kind` or `principal` goes in as `"unknown"`, never as `false`,
`ai_session` or a guessed owner (`provenance()`), and the state and the `inject` question tell
the judge to read an unknown origin as possibly outside the firm. The questions:

| Id | Type | Question | What code does (`TRIAGE_THRESHOLDS`) |
|---|---|---|---|
| `inject` | noul, once per item | Instructions aimed at an AI? | `>= 0.3`: the **whole item** is quarantined. Every draft's outcome is `quarantine`, nothing is written (not even to inbox), one `POST /api/quarantine` with the sentence that tripped it. |
| `keep:i` | noul | Worth remembering? | `< 0.35`: `archive_only` (the raw item stays in the cold archive). Kept facts are hot above 0.6, else cold (the existing `KEEP_HOT` rule). |
| `group:i` | choice: `unsure`, each group id from `GET /api/groups`, `new` | Which group? | Filed there only at `>= 0.6` and when nothing in code disputes it (below). `unsure`, a pick below 0.6 or `new` → `inbox`; `new` carries `new_group`, the writer's suggested group when it is a well-formed id that is not already a group. |
| `label:i:<slug>` | noul per candidate | Does label *x* apply? | Candidates: the writer's suggestions (lowercased, `LABEL_RE`), then labels already in use, at most 8. `>= 0.5` applies it. A merge or supersede also keeps every label of the fact it retires, asked about or not. |
| `rel:i` | choice over `RELATIONS` (`unrelated` first) | Relation to the closest fact? | `same` → merge, `replaces` → supersede, the rest → add. Needs p > 0.5 to merge or supersede. For the group rule (filing rule 3) only `unrelated` at `>= 0.6` counts as unrelated. |
| `relto:i` | choice: `none`, existing ids | Which fact? | Must be one the judge was shown, else none. |

**Filing: code files only what Jev picked confidently and nothing in code disputes.** Otherwise
the fact is written to `inbox`, which only moderators see; it joins no member scope, not even its
author's, until a moderator files it. Code disputes a confident pick of group G when:

1. **An alias of another group is in the draft** (`aliasHits`, no model): the draft's statement
   and detail are matched against every group's aliases, each alias's short form ("Project
   Falcon" → "Falcon") and the group id itself, case-insensitively, with letters and digits as the
   only word characters. The text is folded first: NFKC, accents and zero-width / format
   characters dropped, Cyrillic and Greek look-alikes mapped to Latin, `_` read as a space, and
   camelCase also tried split. So `Falcon_LOI_v3.docx`, `deal_falcon`, `#project_falcon`,
   `ProjectFalcon`, `FalconModel.xlsx` and "Falcon" with a zero-width space inside all name
   `deal/falcon`. A group id's words match only across `/`, `_`, `-`, `\` or nothing (`market/public`,
   `market_public.csv`, `MarketPublic`), never across a space or sentence punctuation, so prose
   such as "nothing goes to market. Public comment …" names no group. An alias is a hint, never a
   filing: an alias of G with Jev unsure is still inbox.
2. **The draft names no group and its item names any group other than G**, even when the item
   names G too. The same check runs once over the whole captured item. A writer often paraphrases
   the code name away ("the target"), so a draft from an item that names `deal/falcon` that Jev
   files elsewhere waits for a moderator.
3. **The draft may relate to a fact in another group**: `relto` names a fact the judge was shown,
   in a group other than G, and `rel` is not a confident `unrelated` (p `>= 0.6`). Content never
   moves between groups on its own. A missing or unsure `rel` keeps this rule (the action stays
   add, so nothing is retired on a guess).
4. **The item was too long for the judge to read whole** (over 24 000 characters, see above): an
   order to an AI in the cut part may not have reached the `inject` question.

**An exact duplicate** of a stored fact merges into it whatever the judge says (the `decide.ts`
rule) and is filed in that fact's group, so a moderator's filing holds when the same item is
distilled again; a duplicate of an inbox fact stays in inbox. Only the statements are compared, so
the merged fact writes back the stored fact's content: its statement, `detail` and `author`. The
draft's own detail never rides into that group unchecked (a public close in `market/public` cannot
pick up Falcon terms from a memo's detail), and a new author never makes the stored content their
own fact. The `reason` says when the draft's detail or author was not taken.

**Every written fact** (`fact` or `inbox`) carries `folder` = its group, `labels`, `author` (the
item's principal; unset when the principal is unknown, never guessed), `happened` (a
`YYYY-MM-DD` the writer read off the source, else dropped), `source`, and `decision.triage` (the
full `TriageDecision`: outcome, keep, group and Jev's probability, `new_group`, labels, injection,
relation, and a one-line `reason`, moderators only). `SaveDecision.folder_p` is Jev's probability
for its pick.

**Missing or neutral answers land on the safe side:** no `inject` answer is 0.5, so the item is
quarantined; no `group` answer is unsure, so inbox; no label answer applies the label (a label
only ever lets an exclusion remove a fact); no relation answer is add (nothing retired) and keeps
the group rule for the fact `relto` names. The
`group`, `rel` and `relto` options list the safe answer first, so a judge that falls back to
`options[0]` picks it.

**What the worker files.** Facts go to `POST /api/facts` with `decision.triage` set. Then the
quarantine item (`POST /api/quarantine`), then the events (`POST /api/events`): one
`triage.decided` per draft, including archive-only and quarantined ones, and one
`quarantine.flagged` per quarantined item, carrying the id the server gave back. An item with no
drafts still gets the `inject` question. A route that exists but fails (a 5xx, a timeout, a
dropped connection) loses nothing: the quarantine item and events it did not take are held and
retried with backoff (5 s doubling to a minute), on the next capture (a re-post of the same one
included) and once more on shutdown, for up to 10 minutes, then the worker says what it gave up
on. The facts are never sent again. A quarantine item's `quarantine.flagged` waits with it, so
the event carries the server's id. Only a missing route (404 / 405) is skipped.

**Against a server without the scopes routes** (`/api/groups`, `/api/quarantine` or
`/api/events` answer 404, as today's does): the worker warns once per route for its whole life,
**files every fact in `inbox`** (`reason` says "the server gave no group list"), skips the
quarantine item and events, and keeps running. Facts still go to `POST /api/facts`, which today's
server accepts in `inbox` (one of the distiller's folders). The same holds when `GET /api/groups`
fails or returns a body the client cannot use (not `{ groups }` / `Group[]`, a group id that is
not a group path, or `new` / `unsure` as an id): `groupsKnown` is false.

**Offline judge (simulated).** With no keys `createJudge()` returns the fake judge, and
`triageJudge()` swaps in `financeFakeJudge()`: a few regexes with finance sense, not a model,
reading the same folded text as the alias check. A draft that names a group's alias picks it
(0.9). Falcon, Nimbus, LOI, term sheet, multiple, EBITDA and similar pick the first `deal/` group
(0.7), and so does a plain line from an item that names a `deal/` group (0.65). An indirect
reference (the target, the buyer, the seller, …) from an item with deal terms is a low-confidence
deal pick (0.5), so it waits in inbox. Public news, research, trading and office lines pick
`market/public`, `research/logistics`, `desk/trading` and `firm/ops` (0.8) when those groups
exist; anything else is unsure. A label applies when the draft says it. "ignore your
instructions", "AI assistant" and similar read as injection, and so does "forward … to" in an item
from outside the firm. The probabilities it gives are made up for the simulation; logs and the
CLI say "simulated".

## Env (all from `.env`, see `.env.example`)

`CANON_URL` · `CANON_TOKEN_DISTILLER` (dev default `dev-distiller`) · `DISTILLER` · `FACTORY_API_KEY`
· `ANTHROPIC_API_KEY` · `FIRM_TZ` · `DISTILL_LIVE` · `JUDGE_PROVIDER` / `JEV_API_KEY` / `JEV_API_URL`.

## Assumptions (B5, scopes PRD rework)

- **The item backstop is kept from the walls version, and widened.** A draft that names no group,
  from an item that names any group other than Jev's pick, goes to inbox, even when the item
  names the pick too (a Falcon memo that mentions `market/public` once must not let a paraphrased
  Falcon line into `market/public`). Groups are flat in the contract, so this also holds for
  non-deal aliases: a multi-topic chat that mentions `LKSP` (an alias of `desk/trading`) sends its
  other lines to inbox for a moderator. Safe, at some cost in moderator work; revisit after the
  first end-to-end run.
- **`contradicts` counts as relating**, like same, replaces and adds detail: a line that
  contradicts a Falcon fact is Falcon information.
- **An exact duplicate follows its stored fact's group**, not Jev's pick, and writes back that
  fact's content (statement, detail, author): nothing new reaches the group, and a moderator's
  filing would otherwise be undone on every re-distill. A new detail on a duplicate statement is
  not kept hot (the raw item stays in the cold archive).
- **The relation → action mapping holds for inbox facts too**: a fact that replaces a filed fact
  still retires it (to cold, never deleted) while the replacement waits in inbox. Members can lose
  that fact until a moderator files the replacement; nothing reaches anyone it should not.
- **Labels are generous**: a neutral answer applies a label, because labels only ever let an
  exclusion remove a fact. Candidates are the writer's suggestions and labels in use (Jev picks,
  it does not name), so a brand-new label needs the writer to propose it. A merge or supersede
  keeps every label of the fact it retires, so a moderator's label holds through a re-distill
  even when it is past the 8 candidates or Jev says no to it.
- **`new` proposes the writer's suggested group** (`DraftFact.folder`) when it is a well-formed id
  that is not already a group; the engines still suggest the scaffold's folders (`team`,
  `projects`), so until B17's follow-up the proposal is often absent or coarse.
- **A quarantined draft's decision** says `group: "inbox"` and no labels: nothing from it is
  written, and its Jev answers came from a state that held an injection.
- **A missing `external`, `kind` or `principal` is unknown, not the friendly default.** The
  capture route can drop all three (today's `parseSession` in `server/` does), so a missing flag
  may be an outside email that lost it. Triage does not apply the contract's "missing kind =
  `ai_session`" default for that reason. The offline judge reads unknown origin as possibly
  external: an order to an AI quarantines as always, and so does a request to send something out
  (any "forward/send ... to", and any send to an email address or an outside / personal one).
  Only the author's own plan ("before i send the LOI draft to the team") and "share" the noun
  ("per share ... a premium to") are let through, so the demo world's internal items still triage
  when the server strips their flags. An item stated `external: false` is read as before. A fact
  from an item with no principal has no `author`.

## Open

- Server requests (lane A): `POST /api/sessions` must keep `external`, `kind` and `principal`
  through `parseSession` and storage (asked in PR #7). Until it does, every item reaches triage as
  unknown origin and every fact is written without an `author`, so living scopes cannot add a
  member's own facts to their scope. The distiller's grant must let it write every group (today
  it writes only `career`, `projects`, `team`, `private` and `inbox`, so a fact in `deal/falcon`
  would be a 403 once `GET /api/groups` exists) and `GET /api/facts?tier=hot` must return facts
  from every group to the distiller, or the relation and duplicate rules cannot see them.
- Long items: past 24 000 characters the judge reads the head, the tail and the suspect sentences
  code finds in the middle, so every draft from such an item waits in `inbox` (a long email thread
  with quoted history included). Once Jev's request size limit is known, raise the cap or ask
  `inject` once per chunk in the same request, and drop the inbox fallback for items it covers.
- Replay skipping is time-based (events older than the worker). Proposal for A↔B: the server's
  `EventBus` honours `Last-Event-ID` (replay only ring ids above it) and `subscribeEvents` sends
  the last id it saw on reconnect; then the worker can drop the 5 s heuristic.
- How the engine's plan reaches the dashboard: `distill.finished` is a server-emitted event and
  `PostFactsBody` has no `plan`/`engine`/`duration_ms`. Proposal for A↔B: add them as optional
  fields on `PostFactsBody` so the server can emit the event. Until then the plan is in the logs.
