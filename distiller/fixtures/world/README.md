# Synthetic world: Harbor Lane Partners and Project Falcon

**Everything in this folder is made up.** The firm, the people, the companies, the tickers, the
numbers, the law firm and the email addresses (all on the reserved `.example` domain) are invented
for the Cal Hacks demo and tests. Any resemblance to a real company or ticker is accidental.

Harbor Lane Partners is a 30-person advisory firm with a deal team, a research desk and a small
trading desk. Its client, Corvane Freight Holdings (private), wants to buy Nimbus Logistics (a
fake public third-party logistics company, ticker NMBL). The deal's code name is Project Falcon.
In Bullwark a deal is a group: Falcon's facts share `deal/falcon`.

## People

Two tiers (PRD "Two tiers"): a moderator sees all memory and sets everyone else's scope; a member
sees only their scope, and the agents they create get the same scope or less. The scopes below are
what the demo shows; the server's seed owns the actual scope rules.

| Person | id | Desk | Tier | What their scope holds in the demo |
|---|---|---|---|---|
| Maya | `maya` | compliance | moderator | everything, plus the moderators-only `inbox` group and the quarantine |
| Dan | `dan` | deal | member | his Falcon work (`deal/falcon`), firm templates and public market data |
| Priya | `priya` | research | member | added live: "Write the logistics sector note from public market data", excluding "anything about pending deals" |
| Leo | `leo` | trading | member | public market facts and his own trading notes; Falcon is excluded until it is announced |

## Groups

`groups.json` is a `GroupsResponse` (what `GET /api/groups` returns). Every fact is filed into
one of these, or into `inbox` when nobody could place it. `inbox` is never listed: only triage
files there, and only moderators see it.

| Group | What it holds | Aliases |
|---|---|---|
| `deal/falcon` | Project Falcon: Corvane's planned acquisition of Nimbus Logistics. Confidential terms, process and diligence | `Project Falcon`, `Falcon`, `Nimbus`, `Nimbus Logistics`, `NMBL` |
| `research/logistics` | Harbor Lane research on the logistics and freight sector, from public information | none |
| `market/public` | Public market news, filings and prices | none |
| `desk/trading` | The trading desk's positions, trade ideas and notes | `Larkspur Cold Chain`, `LKSP` |
| `firm/ops` | Tools, scheduling, office and admin | none |

A group's description and alias list are moderators-only. How the engines use them:

- **Triage** (Jev, `decide.ts`) will read the descriptions and match the aliases in code as a
  filing hint next to Jev's pick (B5). Not built yet: `decide.ts` reads no group list and still
  asks the scaffold's folder question, offering only the draft's suggestion and the old top
  folders. Until B5 offers every group plus "new" and "unsure", the worker must not pass the group
  list into `distill()`, or a confident judge files on the hint (see the `nimbus-public-news.json`
  row). `decide.ts` also does not yet copy a draft's `labels` or `happened` onto the stored fact,
  or set its `author` from the item's principal.
- **The Claude writer** (`src/engines/claude.ts`) gets the list with each item, as **ids only**,
  above the item and as the `group` enum of its `emit_facts` tool. It never sees a description or
  an alias list, but an id can carry a code name (`falcon` in `deal/falcon`). It suggests a group
  from that list or null, never a new one, and up to four labels made only of the item's own
  words. Code drops a draft that names a group id, a name inside one (every segment after the
  first: `falcon`, `logistics`, `public`) or an alias that the item itself never mentions, so
  nothing the writer was shown for filing reaches anyone's memory. That check needs no alias
  list, so a new group a moderator accepts after triage is covered too; dropping a fact that uses
  a generic id word (`public`, `trading`) the item never says is the safe failure. Which listed
  id the writer picks, and whether it leaves hints and planted lines ungrouped, is a system-prompt
  rule that code does not check: code accepts any listed id and any label made of the item's
  words. Triage must never file on the writer's group alone.
- **The heuristic engine** (offline, simulated) suggests a group when a sentence names the
  aliases of exactly one group. No alias, or two groups' aliases: no suggestion. It adds no labels.
  For this hint to anchor on a code name, every deal group lists its code name as an alias
  (`src/engines/world.test.ts` checks).

## Files

| File | Shape | What it is | Where its facts belong, and what it tests |
|---|---|---|---|
| `groups.json` | `GroupsResponse` | The five groups above | alias matching in code (`Falcon`, `Nimbus`, `Nimbus Logistics`, `NMBL`; `LKSP` for the desk); no two groups share an alias |
| `dan-chatgpt-falcon-terms.json` | `CapturedSession` (`ai_session`, `chatgpt`, principal `dan`) | Dan works out Falcon's price per share, premium, exclusivity and break fee with ChatGPT | `deal/falcon`, in Dan's memory. The writer keeps code names and tickers verbatim (the item writes "falcon" and "NMBL"), attributes decisions to Dan, not to ChatGPT, and reads `happened` off stated dates and firm-local stamps |
| `falcon-process-memo.json` | `CapturedSession` (`memo`, `ingest`, principal `dan`) | Dan's draft v3 process update to the deal team | `deal/falcon`. A dense, dated memo with bracketed notes to self; many one-claim facts, and many lines that name no alias, so triage places them, not the alias match. Its section 5 still says "wall list" and "restricted list": that is the firm's own wording in the memo, and those lines are `deal/falcon` facts like the rest |
| `hl-floor-chat-week.json` | `CapturedSession` (`chat`, `ingest`, no principal) | A week of the firm-wide `#hl-floor` channel | Mixed: attestations, SSO and the AI-tools reminder are `firm/ops`; Leo's LKSP and basket lines are `desk/trading`; Priya's sector-note lines are `research/logistics`. Dan's "the logistics thing is eating my whole week, board stuff due by the 29th" names no alias: the **indirect case only Jev can place**, into `deal/falcon` or, when unsure, the moderators-only `inbox`. Never `research/logistics` or `firm/ops`, which would tell Priya and Leo there is a logistics matter with a board date. The heuristic leaves it ungrouped (no alias, checked in code). The writer is only told to leave hints ungrouped: it is shown `research/logistics`, which matches these words, and code accepts that pick, so triage must not file on the writer's group alone. The engine tests use a fake model and cannot check this; it needs a live writer check in the bench task set |
| `outside-counsel-email.json` | `CapturedSession` (`email`, `ingest`, principal `dan`, `external: true`) | Nimbus's lawyers reply about data-room access and the NDA amendment | The planted instruction aimed at an AI (in the original HTML it was white-on-white text) gets the whole item quarantined: it joins no scope, not even Dan's, until Maya releases it. The heuristic leaves the planted paragraph out of the facts (in code). The writer is told to leave it out and never let it choose a group or a label, a prompt rule that code does not enforce: the item says "public", so a `market/public` pick and a `public` label would pass the code checks. Quarantine is what keeps this item out of every scope. Like the chat hint, it needs a live writer check in the bench task set |
| `nimbus-public-news.json` | `CapturedSession` (`note`, `ingest`, principal `priya`) | Priya's roundup of Nimbus's public Q3 results and news, from public sources only | **`market/public` content that names Nimbus: the case that tests grouping and exclusions.** The alias match in code points at `deal/falcon`, but nothing in it is inside information, so it belongs in `market/public` (labels such as `nimbus`, `nmbl`). That is what lets Leo's desk assistant answer "anything going on with Nimbus?" from public news while his scope excludes `deal/falcon`; a cautious moderator can still exclude the `nimbus` label. Filed in `deal/falcon` instead, it would be kept from Leo, and because an author's own facts always join her scope, it would sit in Priya's memory under the deal's group. Offline, the heuristic's alias hint says `deal/falcon` for its Nimbus and NMBL lines (simulated): triage must weigh the hint, never file on it alone. Use this item to measure the missing-context rate |

## Conventions

- Session ids are `ses_1024000N` (hex, per `SESSION_ID_RE`), unique across the folder.
- Chat lines are `role: "user"` messages whose content starts with the speaker's first name
  (`"Dan: can't, …"`), with a timestamp on each line. Memos, notes and emails are one `user`
  message per document or per email in the thread, with their own `From:` / `Date:` lines.
- An item's `principal` is whose context it is: the author of a memo or note, the person in an AI
  session, the mailbox an email thread came from. Its facts are that person's memories. The
  firm-wide channel has none on purpose, so triage meets the "unknown, treat cautiously" case.
- Timeline: NDA 2026-10-06, management meeting 2026-10-15, Corvane IC range 2026-10-20, Dan's
  ChatGPT session the evening of 2026-10-21 (PDT, after that day's close of $31.05), where he
  settles on $38.50 a share; his draft v3 memo to the deal team the next morning, 2026-10-22, before
  the market opens; Nimbus Q3 print 2026-10-22, lawyers' reply 2026-10-22, LOI due 2026-10-28,
  Nimbus board 2026-10-29.
- Harbor Lane is in California. Timestamps in these files are UTC (`Z`); the Claude writer shows
  them in the firm's time zone (`FIRM_TZ`, default `America/Los_Angeles`), so Dan's 19:19 PDT
  decision on 2026-10-21 is dated 2026-10-21, not 2026-10-22.
- The deal numbers agree with each other (9.5x of $142m LTM EBITDA, $310m net debt and 27.0m
  shares give about $38.50 per share, a 24% premium to $31.05). They are synthetic data, never
  results: no benchmark or dashboard number comes from this folder.
- No prompt may contain this world's names, groups or numbers (`src/engines/claude.test.ts`
  checks the writer's system prompt against `groups.json` and the list above), or every number
  measured with that prompt would be contaminated.

Try one offline (simulated, no keys):

```
npm run distill -w distiller -- fixtures/world/dan-chatgpt-falcon-terms.json --engine heuristic
```

The CLI does not pass the group list yet, so these drafts carry no group. The engine tests run
the world with `groups.json`: `node --import tsx --test src/engines/*.test.ts` from `distiller/`.
