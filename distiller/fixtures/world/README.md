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

A group's description and aliases are moderators-only. How the engines use them:

- **Triage** (Jev, `decide.ts`) reads the descriptions and matches the aliases in code as a filing
  hint next to Jev's pick.
- **The Claude writer** (`src/engines/claude.ts`) gets the list with each item, as **ids only**,
  above the item and as the `group` enum of its `emit_facts` tool. It never sees a description or
  an alias. It suggests a group from that list or null, never a new one, and up to four labels
  made only of the item's own words. Code drops a draft that names a group id or alias the item
  itself never mentions, so nothing the writer was shown for filing reaches anyone's memory. For
  that check to catch a code name, every deal group lists its code name as an alias
  (`src/engines/world.test.ts` checks).
- **The heuristic engine** (offline, simulated) suggests a group when a sentence names the
  aliases of exactly one group. No alias, or two groups' aliases: no suggestion. It adds no labels.

## Files

| File | Shape | What it is | Where its facts belong, and what it tests |
|---|---|---|---|
| `groups.json` | `GroupsResponse` | The five groups above | alias matching in code (`Falcon`, `Nimbus`, `Nimbus Logistics`, `NMBL`; `LKSP` for the desk); no two groups share an alias |
| `dan-chatgpt-falcon-terms.json` | `CapturedSession` (`ai_session`, `chatgpt`, principal `dan`) | Dan works out Falcon's price per share, premium, exclusivity and break fee with ChatGPT | `deal/falcon`, in Dan's memory. The writer keeps code names and tickers verbatim (the item writes "falcon" and "NMBL"), attributes decisions to Dan, not to ChatGPT, and reads `happened` off stated dates and firm-local stamps |
| `falcon-process-memo.json` | `CapturedSession` (`memo`, `ingest`, principal `dan`) | Dan's draft v3 process update to the deal team | `deal/falcon`. A dense, dated memo with bracketed notes to self; many one-claim facts, and many lines that name no alias, so triage places them, not the alias match. Its section 5 still says "wall list" and "restricted list": that is the firm's own wording in the memo, and those lines are `deal/falcon` facts like the rest |
| `hl-floor-chat-week.json` | `CapturedSession` (`chat`, `ingest`, no principal) | A week of the firm-wide `#hl-floor` channel | Mixed: attestations, SSO and the AI-tools reminder are `firm/ops`; Leo's LKSP and basket lines are `desk/trading`; Priya's sector-note lines are `research/logistics`. Dan's "the logistics thing is eating my whole week, board stuff due by the 29th" names no alias: the **indirect case only Jev can place**, into `deal/falcon` or, when unsure, the moderators-only `inbox`. Never `research/logistics` or `firm/ops`, which would tell Priya and Leo there is a logistics matter with a board date. The writer and the heuristic leave it ungrouped |
| `outside-counsel-email.json` | `CapturedSession` (`email`, `ingest`, principal `dan`, `external: true`) | Nimbus's lawyers reply about data-room access and the NDA amendment | The planted instruction aimed at an AI (in the original HTML it was white-on-white text) gets the whole item quarantined: it joins no scope, not even Dan's, until Maya releases it. The writer and the heuristic leave the planted paragraph out of the facts, and it never chooses a group or a label |
| `principals.json` | `{ principals: Principal[] }` | Maya (moderator), Dan, Priya, Leo (members) and Leo's desk assistant (`agt_leodesk`) | the server's scopes stubs (A2) load this as their starting state; `GET /api/principals` |
| `scope-rules.json` | `{ rules: ScopeRule[] }` | One rule per member and agent: the task, plus `deal` exclusions for Priya, Leo and the agent | `GET/PUT /api/scope-rules/:principal`; the exclusions are never shown to the member |
| `scopes.json` | `{ scopes: Scope[] }` | Fixed fact-id lists per principal, consistent with `server/fixtures/facts/` | `GET /api/scopes/:principal`; the agent's list is a subset of Leo's (checked in code and tests) |
| `quarantine.json` | `{ items: QuarantineItem[] }` | The lawyers' planted paragraph, held (`qtn_c0de01`, from `ses_10240004`) | `GET /api/quarantine` and the moderator release flow |
| `audit.json` | `{ entries: AuditEvent[] }` | People added, scopes built, the agent created, the quarantine hold | `GET /api/audit?principal=&since=` |
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
