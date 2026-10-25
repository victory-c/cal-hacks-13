# Demo world: Axe Capital / Project Stonewall

**Owner:** lane C, Edan Wong (task C20). The synthetic world every lane builds and tests against:
Canon's seed and ingest, Bullwark's console mocks, and the benchmark sets. Everything here is
invented, after the TV series Billions. Every company, person, number and email address is
fictional, and every email domain ends in `.example`.

## The story

Axe Capital, a 30-person hedge fund, is quietly preparing **Project Stonewall**: an all-cash tender
offer for its rival **Taylor Mason Capital** (TMC), a listed alternative asset manager, at $52.75 a
share. The deal team (Bob Adams and Ari Spyros) may know; research (Ben Carter) and the trading desk (Dollar
Bill, who is long TMC) must not. Mike Wagner, the COO, doubles as compliance and is the only moderator. On
November 10 the bid is announced; the offer terms become public, but the valuation model, the
walk-away price and the financing stay walled.

## Files

| File | What |
|---|---|
| `world.json` | Firm, deal, target figures, principals (4 people, 3 agents), groups and labels, scope rules, the escalation-attack agent, and the demo timeline (what is seeded, what arrives live at 0:25, what moves at 1:20) |
| `items/*.json` | 13 source items in the `Item` shape from `docs/INTEGRATION.md` (`id`, `kind`, `source`, `author`, `captured_at`, `text`): two Stonewall memos, the deal team meeting transcript, Bob's ChatGPT session, counsel's email with the planted instruction, TMC's public Q3 letter, Ben's research draft, Bill's trading desk notes, four team chat channels, and an unlabelled voicemail whose two facts start in the inbox |
| `expected.json` | The answer key: the facts each item should produce, each fact's group and labels, each fact's stable `fact_id` (used by the benchmark cases), which facts become public at 1:20 (`announced`), which item must be quarantined, the leak markers, and what Bill Stevens's scope must hold at 0:00 |

## How it fits together

| Group | Comes from | Who can see it at 0:00 |
|---|---|---|
| `deal/stonewall` | Both memos, the meeting, Bob's ChatGPT session, `#stonewall` | Mike Wagner, Bob Adams, the deal analyst |
| `market/public` | TMC's Q3 letter, TMC's closing price | Everyone whose rule allows public market data |
| `research/asset-managers` | Ben's draft, `#research` | Ben (built at 0:40), and others whose rules fit |
| `desk/dollar-bill` | Bill's trading desk notes, `#desk` | Bill Stevens and his desk assistant |
| `firm/ops` | `#general` | Everyone whose rule fits |
| `inbox` (not a group) | The voicemail | Moderators only, until Mike Wagner files each fact (`file_to` in `expected.json` is the right group) |

The numbers reconcile, and `web/src/world.test.ts` checks that they do: $52.75 is a 28% premium to
the $41.20 30-day average, 11x the $4.80 consensus 2027 earnings, and about $3.2 billion of equity on
60.7 million shares, financed by $1.9 billion from two banks plus $1.3 billion of Axe Capital's cash.
The public multiple is 8.6x.

## Rules for changing it

- Keep it synthetic, and keep email addresses on `.example`.
- A new item needs an entry in `expected.json`; a new fact needs a group from `world.json` and a key
  phrase that appears in its item.
- Public-side items must never contain a leak marker. The test fails if one does.
- Never renumber a `fact_id`; the cases in `bench/tasks/finance/` refer to them.
- Run `npm test -w web` after any change.
