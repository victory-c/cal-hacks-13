# Development compatibility fixtures

`npm run seed -w server` copies these fixtures into `CANON_DATA_DIR` (default `data/`),
without overwriting existing files. The server also seeds an empty store at startup.

The existing facts and session are retained for source and test compatibility. They exercise
serialization, cold and superseded facts, source links and folder-grant refusals. The exact fact
format is defined in `shared/src/types/fact.ts` and `shared/src/fact-file.ts` at the repo root.
Session ids must be `ses_` followed by hex digits, as defined by `SESSION_ID_RE`.

These fixtures are not the finance demo world or benchmark evidence. The Axe Capital / Project
Stonewall / Taylor Mason Capital world lives in `../../fixtures/world/` (C20): memos, chat, a meeting
transcript, an AI session, a public letter and an email from counsel containing a planted instruction,
with an answer key. C6 writes legitimate tasks and attacks against that world. Replace fixtures only alongside the required
schema, permission behavior and tests. Use synthetic data throughout. These fixtures do not define product scope; the PRDs in `../../docs/` do.
