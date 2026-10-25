# `e2e/` — the Claude Code loop, end to end

**Owner:** lane A, Henry Lai. One test file, run by `npm run check` with every other workspace.

`src/claude-code-loop.test.ts` proves the loop in `docs/PIPELINE-PRD.md` §4.7 on the offline
providers, with the real pieces running together instead of one package's fakes:

- the real server (`server/src/app.ts` `startServer`) on port 0, fresh data dir seeded with the
  Axe Capital world, the simulated scope judge and the keyword retriever;
- the real distiller handler (`distiller/src/worker.ts`) against that server over HTTP, with the
  heuristic writer and a small simulated triage judge for this world (the shipped offline judge
  still files by the Falcon world's group ids);
- the real hook scripts (`hooks/claude-code/canon-capture.mjs`, `canon-context.mjs`) as child
  processes, fed Claude-Code-shaped transcripts from `fixtures/` with `CANON_PERSON_TOKEN` set and
  `CANON_REPO_ROOT` pointing at an empty `.env`, so a developer's own `.env` is never read.

What it asserts, in order: Dollar Bill's desk log is captured as his session; it becomes facts
authored `dollar-bill` in `desk/dollar-bill`; they join his scope and his desk assistant's; a floor
rumor about the bid, filed under `deal/stonewall` by triage, joins neither; the context hook puts
the new facts in his next prompt and adds nothing to a haiku; `canon_whoami`, `canon_search`,
`canon_context` and `canon_save` act on his scope only; a restart on the same data dir keeps the
scopes, the audit and the served facts; and a question about the bid gets an ordinary slice from
every door, never a refusal.

The desk log and the rumor are two Claude Code sessions. Triage files a draft in `inbox` when its
item names a group other than Jev's pick, so one transcript carrying both would send the trade
facts to moderators only; two sessions is also how it happens at a desk.

```bash
npm run typecheck -w e2e
npm test -w e2e
```

The unit suites in `server/`, `distiller/` and `hooks/` each fake their neighbours; this is the one
place the contract between them is exercised as shipped. Everything here is simulated and says so
in its logs; the live run on Jev and the Claude writer is recorded in the PR, not in CI.
