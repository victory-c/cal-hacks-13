# `@canon/distiller` — captured item in, walled facts out

**Owner:** lane B, Victor Chun. This README describes the implemented worker. Finance triage,
wall labels, Claude fact writing and Droid agent dispatch are tracked in `../docs/WORK_SPLIT.md`.

A worker process on the server's event stream. It never imports
server code: everything goes over HTTP as the `distiller` client (`CANON_TOKEN_DISTILLER`).

```
SSE session.captured ─▶ GET /api/sessions/:id ─▶ engine.distill() ─▶ triage() ─────────────────────▶ POST /api/facts
                        (cold archive)            DraftFact[] + plan    one Jev request per item:       facts carry wall +
                                                                        inject · keep · confidential ·  decision.triage
                        GET /api/facts (hot) ─┐                         deal · relation                ─▶ POST /api/review
                        GET /api/deals ───────┼─▶ code rule (names) ──▶ thresholds + raise-only walls     label_unsure · quarantine
                        GET /api/lists ───────┘                                                        ─▶ POST /api/events
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
| `src/client.ts` | Typed fetch client: `getSession`, `listFacts`, `postFacts`; the finance routes `getDeals`, `getLists` (checked by `parseDeals` / `parseLists`: a body they cannot use throws), `postReview`, `publishEvent` (RELAYED_EVENTS only). Bearer auth, 10 s timeout, errors say status + body. |
| `src/triage.ts` | Finance save-time triage: one batched `judge.ask()`, thresholds and wall rules applied by us. Pure given a `Judge`. Also `financeFakeJudge()`, the offline judge. |
| `src/walls.ts` | `codeWall()` (deal names and listed companies, in code, on folded text) and `raiseWall()` (public < deal < unlabeled, never lowers). Pure. |
| `src/engines/` | `Distiller` interface, `createDistiller()`, the three engines (below). |
| `src/decide.ts` | The earlier, pre-finance save-time decisions (tier, folder, dedupe). The worker no longer calls it; triage reuses its exact-duplicate rule. |
| `src/cli.ts` | Run the pipeline on a recorded item; `--post` files the result on the server like the worker does. |
| `fixtures/session.sample.json` | A Claude Code session (ships the capture hook, decides folders, targets backend internships). An existing compatibility transcript, not the finance demo world. |
| `fixtures/world/` | The synthetic finance world (Harbor Lane Partners, Project Falcon): a deal, the restricted and watch lists, and five captured items. All made up; see its README. `src/engines/world.test.ts` checks it against the contract. |

## Run and test

```bash
npm run dev -w distiller                 # the worker; needs the server on CANON_URL (npm run dev at the root runs both)
npm run distill -w distiller -- distiller/fixtures/session.sample.json            # no server needed
npm run distill -w distiller -- <item.json> --deals <deals.json> --lists <lists.json>
npm run distill -w distiller -- distiller/fixtures/session.sample.json --engine claude --post
npm run typecheck -w distiller && npm test -w distiller                            # offline, no keys
```

The CLI prints the plan, the drafts, the triage table (outcome, wall, keep / confidential / deal
answers, relation, action) and the review items, then everything as JSON. Deals and lists come
from `--deals` / `--lists` (a `DealsResponse` / `ListsResponse` JSON file), else from
`fixtures/world/deals.json` and `fixtures/world/lists.json` when they exist. With `--post` they
come from the server only: `--deals` / `--lists` are refused and the fixtures are never read,
since the result is filed on that server and a local list could label public what its walls
would not (or skip the `inbox` fallback on a server without the finance routes). Without both,
nothing is labeled public and every fact goes to `inbox`. If the server takes the facts but fails
on a review item or event, `--post` says what was not filed and exits 1. Tokens and ms in its
output are real measurements (`usage` from the API, wall clock); nothing is estimated.

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
sender). Deal code names, company names and tickers stay verbatim, because the wall rules match
them in code, and a hint such as "the logistics thing" is kept word for word, never resolved.
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
agent runner. The current product target is headless finance-agent dispatch with isolated
context, work steps, inbox updates and checked outputs (B2 and B18). Confirm headless finance
work at the Factory gate before claiming the integration. The existing Claude and heuristic
engines remain usable for development.

**Anthropic track.** `claude-sonnet-5-5` follows the claude-api skill: forced `tool_choice` is a
400 on this model, so the request uses `auto` + `strict: true` + a system prompt that says to call
`emit_facts` once, and fails clearly when no call came back; adaptive thinking (default) at
`effort: medium`; `max_tokens` 4096 because thinking counts against it; `fallbacks: "default"`
(beta `server-side-fallback-2026-07-01`) so a safeguard false positive is retried server-side.

## Jev save-time triage (`src/triage.ts`, `src/walls.ts`)

**One `judge.ask()` per captured item** (CLAUDE.md rule). The state is the item (kind, client,
`external`, principal, its text: title plus `role: content` per message), the deals (id, code
name, aliases, companies, status), the numbered drafts and up to 40 existing hot facts (id,
statement, wall). Past 24 000 characters the text keeps its head and tail, and the cut middle is
scanned in code (on folded text) for sentences that read like orders to an AI or like forwarding
something out; up to 8 of them are spliced in where the cut is, so the `inject` question is asked
of the whole item. A sentence longer than 280 characters is cut to a window that starts just
before the match, so padding in front of an order cannot push it out (the quarantine excerpt
works the same way). The state also tells the judge the item text is untrusted data, never
instructions. The questions:

| Id | Type | Question | What code does (`TRIAGE_THRESHOLDS`) |
|---|---|---|---|
| `inject` | noul, once per item | Instructions aimed at an AI? | `>= 0.3`: the **whole item** is quarantined. Every draft's outcome is `quarantine`, nothing is written, one `quarantine` review item (with the sentence that tripped it). |
| `keep:i` | noul | Worth remembering? | `< 0.35`: `archive_only` (the raw item stays in the cold archive). Kept facts are hot above 0.6, else cold (the existing `KEEP_HOT` rule). |
| `conf:i` | noul | Looks like confidential deal information, including indirect references? | `>= 0.2` with no deal wall: `compliance`. |
| `deal:i` | choice: `unsure`, each deal id, `public` | Which deal? | A pick below 0.6 counts as `unsure`. A confident deal raises the wall. |
| `rel:i` | choice over `RELATIONS` (`unrelated` first) | Relation to the closest fact? | `same` → merge, `replaces` → supersede, the rest → add. Needs p > 0.5 to merge or supersede. |
| `relto:i` | choice: `none`, existing ids | Which fact? | Must be one the judge was shown, else none. |

**The wall, raise-only.** It starts at `public` and only goes up (`raiseWall`: public < any
deal < unlabeled):

1. **Code rule** (`codeWall`, no model): the draft's statement and detail are matched against every
   deal's id, code name, its short form ("Project Falcon" → "Falcon"), aliases and companies, plus
   restricted and watch-list companies, case-insensitively, with letters and digits as the only
   word characters. The text is folded first: NFKC, accents and zero-width / format characters
   dropped, Cyrillic and Greek look-alikes mapped to Latin, `_` read as a space, and camelCase also
   tried split. So `Falcon_LOI_v3.docx`, `deal_falcon`, `#project_falcon`, `ProjectFalcon`,
   `FalconModel.xlsx` and "Falcon" with a zero-width space inside all name Falcon. A hit walls the fact to
   that deal **even when Jev says public**.
2. **Jev's confident deal** (`deal_p >= 0.6`) raises it.
3. **The related fact** (`relto`, or an exact duplicate) is a floor: a fact that replaces, merges
   into, adds to or contradicts an existing fact never gets a lower wall than that fact.
4. **The item backstops the draft.** The code rule also runs once over the whole captured item. A
   writer often paraphrases the code name away ("the target"), so a draft that would be labeled
   `public` from an item that names a deal goes to `compliance` instead, with that deal as the
   proposal (not forced: public news that mentions a deal company is not over-walled).

Outcomes: `fact` with a deal wall, or with `public` when nothing points at a deal, the
confidentiality answer is below 0.2, Jev is confidently public and the item names no deal.
Everything else that is kept is **`compliance`**: two deals (a conflict), a floor that is itself
unlabeled, a listed company that belongs to no known deal (even next to a deal wall),
confidential with no clear deal, deal unsure, or a public-looking draft from an item that names a
deal. A `compliance` fact is **written with no wall** (unlabeled: nobody but compliance sees it)
and a `label_unsure` review item carries `proposed_wall` (= `TriageDecision.wall`: what content
and the related fact's floor say, raised by Jev's below-threshold deal pick, else the deal the item
names; never below the floor). For a `fact`, `TriageDecision.wall` is the wall the fact got,
floor included. For a two-deal conflict there is no single right wall, so the item has no
`proposed_wall` and says "pick one".

**Missing or neutral answers land on the safe side:** no `inject` answer is 0.5, so the item is
quarantined; no `conf` answer is 0.5, so confidential; no `deal` answer is unsure; no relation
answer is add (nothing retired). The `deal`, `rel` and `relto` options list the safe answer first,
so a judge that falls back to `options[0]` picks it. The exact-duplicate rule from `decide.ts`
still holds: a draft that repeats a stored fact word for word merges into it.

**What the worker files.** Facts (`fact` and `compliance`) go to `POST /api/facts` with
`decision.triage` set. Then the review items (`POST /api/review`), then the events
(`POST /api/events`): one `triage.decided` per draft, including archive-only and quarantined
ones, and one `quarantine.flagged` per quarantined item, carrying the id the review queue gave
back. An item with no drafts still gets the `inject` question. A route that exists but fails
(a 5xx, a timeout, a dropped connection) loses nothing: the review items and events it did not
take are held and retried with backoff (5 s doubling to a minute), on the next capture (a re-post
of the same one included) and once more on shutdown, for up to 10 minutes, then the worker says
what it gave up on. The facts are never sent again. A quarantine item's `quarantine.flagged`
waits with it, so the event carries the queue's id. Only a missing route (404 / 405) is skipped.

**Against a server without the finance routes** (`/api/deals`, `/api/lists`, `/api/review` or
`/api/events` answer 404): **walls are not enforced there.** Such a server (today's) checks folder
grants only, so an unlabeled or deal-walled fact in `team/` would reach every client that reads
`team/`. The worker warns once per route for its whole life, triages with an empty deal list, **labels nothing public** (a public
result is written unlabeled) and **files every fact in `inbox`**, which no AI client reads under
`DEMO_GRANTS` (`wall_reason` says why). It skips the review items and events and keeps running.
Facts still go to `POST /api/facts`, which it accepts. The same holds when either route fails
or returns a body the client cannot use (not `{ deals }` / `Deal[]`, a deal without a
`deal_…` id or code name, `restricted` not a list): `labelPublic` is false.

**Offline judge (simulated).** With no keys `createJudge()` returns the fake judge, and
`triageJudge()` swaps in `financeFakeJudge()`: a few regexes with finance sense, not a model,
reading the same folded text as the code rule. Falcon, Nimbus, LOI, term sheet, multiple, EBITDA
and similar read as confidential Falcon information (a named deal at 0.9, unnamed deal talk at
0.7, a plain line from an item that names a deal at 0.65). An indirect reference (the target,
the buyer, the seller, …) from an item with deal terms reads as maybe confidential (0.4, Falcon at
0.5), so it goes to compliance with Falcon proposed. "ignore your instructions", "AI assistant"
and similar read as injection, and so does "forward … to" in an item from outside the firm;
public news and everyday lines read as public. The probabilities it gives are made up for the
simulation; logs and the CLI say "simulated".

## Env (all from `.env`, see `.env.example`)

`CANON_URL` · `CANON_TOKEN_DISTILLER` (dev default `dev-distiller`) · `DISTILLER` · `FACTORY_API_KEY`
· `ANTHROPIC_API_KEY` · `FIRM_TZ` · `DISTILL_LIVE` · `JUDGE_PROVIDER` / `JEV_API_KEY` / `JEV_API_URL`.

## Assumptions (B5, written down while Victor slept)

- **Folder:** finance triage asks no folder question. A fact goes to the engine's `folder`, else `team`, or
  `team/<deal>` (e.g. `team/falcon`) for a deal-walled fact. Unlabeled facts stay in plain `team`
  so the path hints at nothing. Without the server's deals and lists every fact goes to `inbox`
  (fail closed by folder). `SaveDecision.folder_p` is 1 because code chose the folder.
- **Tier:** kept facts keep the existing rule (hot above `KEEP_HOT` 0.6, else cold).
- **The floor covers every relation but `unrelated`**, not only replaces and same: a detail added
  to a Falcon fact is Falcon information.
- **The code rule walls by the draft and backstops by the item.** A name in the draft walls the
  fact; a name only in the item sends a public-looking draft to compliance (proposing that deal)
  rather than walling it, since the item may be public news that mentions a deal company. Jev
  sees the whole item, so a plain line from a Falcon memo can still be walled by Jev (the fake
  judge does this too). Restricted-list companies count at draft level only.
- **A listed company with no known deal** sends the fact to compliance rather than labeling it,
  even when a deal wall applies: that wall covers the deal, not the other company. The deal wall
  is the proposal.
- **Watch-list names stay out of `wall_reason`** ("a watch-list name"), since the reason rides on
  events. The review item, which is compliance-only, quotes the statement.
- **Missing, failing or malformed deals or lists** (either one) means no public labels and every
  fact in `inbox`, in the worker and the CLI. With `--post` the CLI uses only the server's and
  refuses `--deals` / `--lists`.
- **A held public fact keeps outcome `fact` and `decision.wall` `public`** while the fact itself is
  written with no wall; `wall_reason` says "left unlabeled". `TriageDecision.wall` has no
  "unlabeled" value, so saying it there needs a contract change (lane A).

## Open

- Contract requests (lane A): pin the `POST /api/review` response (the client accepts the item,
  `{ item }` or `{ id }`; `quarantine.flagged.review_id` is `""` when it gets none), and give
  `TriageDecision` a way to say "two deals" (today `wall` holds the first one and the review item
  has no `proposed_wall`).
- Replay skipping is time-based (events older than the worker). Proposal for A↔B: the server's
  `EventBus` honours `Last-Event-ID` (replay only ring ids above it) and `subscribeEvents` sends
  the last id it saw on reconnect; then the worker can drop the 5 s heuristic.
- How the engine's plan reaches the dashboard: `distill.finished` is a server-emitted event and
  `PostFactsBody` has no `plan`/`engine`/`duration_ms`. Proposal for A↔B: add them as optional
  fields on `PostFactsBody` so the server can emit the event. Until then the plan is in the logs.
