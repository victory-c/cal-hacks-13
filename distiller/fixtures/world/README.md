# Synthetic world: Harbor Lane Partners and Project Falcon

**Everything in this folder is made up.** The firm, the people, the companies, the tickers, the
numbers, the law firm and the email addresses (all on the reserved `.example` domain) are invented
for the Cal Hacks demo and tests. Any resemblance to a real company or ticker is accidental.

Harbor Lane Partners is a 30-person advisory firm with a deal team, a research desk and a small
trading desk. Its client, Corvane Freight Holdings (private), wants to buy Nimbus Logistics (a
fake public third-party logistics company, ticker NMBL). The deal's code name is Project Falcon.

| Person | id | Desk | Side of the wall |
|---|---|---|---|
| Maya | `maya` | compliance | sees everything |
| Dan | `dan` | deal | over the wall for Falcon |
| Priya | `priya` | research | public side |
| Leo | `leo` | trading | public side |

## Files

| File | Shape | What it is | What it tests |
|---|---|---|---|
| `deals.json` | `DealsResponse` | Project Falcon, `deal_falcon`, confidential since 2026-10-06 | alias matching in code (`Falcon`, `Nimbus`, `Nimbus Logistics`, `NMBL`) |
| `lists.json` | `ListsResponse` | Restricted: Nimbus Logistics (NMBL). Watch: Larkspur Cold Chain (LKSP) | refusals; the watch list is secret, so never show it to staff |
| `dan-chatgpt-falcon-terms.json` | `CapturedSession` (`ai_session`, `chatgpt`, principal `dan`) | Dan works out Falcon's price per share, premium, exclusivity and break fee with ChatGPT | the writer keeps code names and tickers verbatim, attributes decisions to Dan, not to ChatGPT, and reads `happened` off stated dates |
| `falcon-process-memo.json` | `CapturedSession` (`memo`, `ingest`, principal `dan`) | Dan's draft v3 process update to the deal team | a dense, dated memo with bracketed notes to self; many one-claim facts |
| `hl-floor-chat-week.json` | `CapturedSession` (`chat`, `ingest`, no principal) | A week of the firm-wide `#hl-floor` channel | one indirect reference: Dan's "the logistics thing" names no alias, so only Jev can tie it to Falcon (unsure goes to the compliance queue); Leo's LKSP line touches the watch list |
| `outside-counsel-email.json` | `CapturedSession` (`email`, `ingest`, principal `dan`, `external: true`) | Nimbus's lawyers reply about data-room access and the NDA amendment | the planted instruction (in the original HTML it was white-on-white text) must be quarantined and never become a fact |
| `nimbus-public-news.json` | `CapturedSession` (`note`, `ingest`, principal `priya`) | Priya's roundup of Nimbus's public Q3 results and news | public information that still names Nimbus, so code rules raise it to `deal_falcon` while Falcon is confidential; it reads as public after Falcon is announced. Use it to measure "wrongly blocked" |

## Conventions

- Session ids are `ses_1024000N` (hex, per `SESSION_ID_RE`), unique across the folder.
- Chat lines are `role: "user"` messages whose content starts with the speaker's first name
  (`"Dan: can't, …"`), with a timestamp on each line. Memos, notes and emails are one `user`
  message per document or per email in the thread, with their own `From:` / `Date:` lines.
- An item's `principal` is whose context it is: the author of a memo or note, the person in an AI
  session, the mailbox an email thread came from. The firm-wide channel has none on purpose, so
  triage meets the "unknown, treat cautiously" case.
- Timeline: NDA 2026-10-06, management meeting 2026-10-15, Corvane IC range 2026-10-20, memo
  2026-10-21, Dan's ChatGPT session the evening of 2026-10-21 (PDT), Nimbus Q3 print 2026-10-22,
  lawyers' reply 2026-10-22, LOI due 2026-10-28, Nimbus board 2026-10-29.
- The deal numbers agree with each other (9.5x of $142m LTM EBITDA, $310m net debt and 27.0m
  shares give about $38.50 per share, a 24% premium to $31.05). They are synthetic data, never
  results: no benchmark or dashboard number comes from this folder.

Try one offline (simulated, no keys):

```
npm run distill -w distiller -- fixtures/world/dan-chatgpt-falcon-terms.json --engine heuristic
```
