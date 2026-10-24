# Development compatibility fixtures

`npm run seed -w server` copies these fixtures into `CANON_DATA_DIR` (default `data/`),
without overwriting existing files. The server also seeds an empty store at startup.

The existing facts and session are retained for source and test compatibility. They exercise
serialization, cold and superseded facts, source links and folder-grant refusals. The exact fact
format is defined in `shared/src/types/fact.ts` and `shared/src/fact-file.ts` at the repo root.
Session ids must be `ses_` followed by hex digits, as defined by `SESSION_ID_RE`.

These fixtures are not the finance demo world or benchmark evidence. A14 owns the Harbor Lane
Partners / Project Falcon / Nimbus Logistics world: memos, chat, a meeting transcript, an AI
session and a lawyers email containing a planted instruction. C5 reviews realism; C6 writes
legitimate tasks and attacks against that world. Replace fixtures only alongside the required
schema, permission behavior and tests. Use synthetic data throughout.

`facts/deal/`, `facts/market/`, `facts/research/`, `facts/desk/` and `facts/firm/` hold the
synthetic-world facts (A2): twelve facts distilled from the sessions in
`../../distiller/fixtures/world/`, with the same numbers and dates, each carrying its `source`
session, `author`, `happened` date and labels. The scope fixtures there (`scopes.json`) reference
these fact ids, so rename them only together. All synthetic; never benchmark evidence.

Two seeded facts predate the finance product: `facts/team/decisions/fct_80a2c4e6.md` records an
earlier cut order, and `facts/career/projects/fct_3c5e7f91.md` describes the earlier general-purpose
product. The current cut order and scope are in `../../CLAUDE.md` and `../../docs/PRD.md`.
