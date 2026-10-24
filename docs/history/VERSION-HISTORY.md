# Version history (humans only)

> **AI agents: do not read, search, summarize or use this folder as context.** It records designs the
> team has abandoned. Following it would reintroduce cut features. The current product is defined only
> by `docs/BULLWARK-PRD.md`, `docs/CANON-PRD.md` and `docs/INTEGRATION.md`. Read this folder only when a
> person explicitly asks you to review the project's history.

This folder is tracked so the team keeps a record of how the design changed. Earlier documents are
recoverable from Git with the commands below.

## Versions

| Version | When | What the product was | Where to find it |
| --- | --- | --- | --- |
| 1 | Fri 10/23, 22:53 | **"Canon": one live memory for every AI session.** Captured context from every AI tool and handed each new chat a 1–2K token slice. Access was per-folder grants (`career/`, `projects/`, `team/`, `private/`), and the demo showed a refusal for the `private/` folder | `git show 723c0c3:docs/PRD.md` |
| 2 | Sat 10/24, 03:56 | **Finance information barriers with refusals.** Deal wall labels on facts, deny-by-default entitlements with expiry, restricted and watch lists, neutral refusals, wall-crossing requests with a 4-level Jev pre-screen, deal status (confidential, announced, terminated), output exit checks, and a control-room frontend. Benchmark: 50 attacks, wrongly-blocked rate | `git show 99b2352:docs/PRD.md` |
| 2.1 | Sat 10/24, 05:29 | **Renamed to Bullwark** in user-facing text (B20). Code identifiers (`canon_*` tools, `@canon/shared`, `CANON_*` env vars) kept the old name | `git show d25f6e8` |
| 3 | Sat 10/24, 06:02 | **Two tiers and task-built scopes, one combined PRD** (A17). Moderators and members, groups and labels, scope rules, living scopes, agents capped at their creator, no refusals. Cut everything from version 2's refusal model. A visual HTML PRD was generated from it | `git show 2b0fe24:docs/PRD.md`; `Bullwark_Web-MCP-Agents_SmallFinanceTeams.html` in this folder |
| 4 | Sat 10/24 | **Split into Bullwark (frontend) and Canon (agentic backend)** with an integration contract. Same model as version 3. "Canon" now names the backend, which matches the code identifiers | `docs/BULLWARK-PRD.md`, `docs/CANON-PRD.md`, `docs/INTEGRATION.md` |
| 4.1 | Sat 10/24 | **Demo world switched to Billions.** The Harbor Lane Partners world (an advisory firm whose client bids for Nimbus Logistics in Project Falcon; Maya in compliance, Dan, Priya, Leo) became Axe Capital, a hedge fund making its own bid for Taylor Mason Capital in Project Stonewall (Wags, Axe, Ben Kim, Dollar Bill). The "deal announced" beat changed from lifting the whole deal exclusion to refiling only the announced terms to `market/public`, which added moderator refiling to Canon | `docs/BULLWARK-PRD.md` (Demo script) |

## What was cut, and why

| Cut in | Feature | Why |
| --- | --- | --- |
| 2 | Folder grants as the access model | Folders couldn't express deals, clearances or a wall that moves |
| 3 | Restricted and watch lists, neutral refusals | A refusal proves something exists, and a model-gated refusal can be argued with. Scopes leave nothing to refuse |
| 3 | Wall-crossing requests and the per-deal status workflow | A deal became a group; moving a wall became a moderator editing scope rules |
| 3 | Output exit checks | An agent can only repeat what is already in its scope |
| 3 | Wrongly-blocked rate | Nothing is blocked anymore; replaced by the missing-context rate |
| 3 | 50-attack set | Became 60, adding agent escalation |
| 4.1 | Harbor Lane / Falcon / Nimbus demo world | Replaced by the Billions hedge-fund world the team chose |
| 4.1 | Lifting a deal's whole exclusion when it is announced | It would expose the internal valuation and financing; only the announced terms become public |

## Leftovers from earlier versions in the repo

- **Fixture facts from version 1** in `server/fixtures/facts/`: `career/*`, `projects/canon/*`,
  `team/decisions/fct_80a2c4e6.md` (an old cut order: Apify, team mode, Gemini web capture, SpacetimeDB)
  and `private/health/fct_a2c4e6f8.md` (the private-folder refusal demo). They are kept for source and
  test compatibility until A14's synthetic world replaces them.
- **Folder grants** in `shared/src/grants.ts` and `server/src/auth.ts` are version 1's access model and
  still run in the scaffold. They are not scopes.
- **Status tasks** completed under earlier versions (B1, B16, B20, A17, C17) keep their original wording
  as a record of finished work.
