# Lane A handoff: finishing the core pipeline on `main`

**Written Sat 10/24 ~23:00 PDT by Henry's session, for whoever picks up lane A.** Branch:
`a/loop-on-main` (cut from `origin/main` at d52acd1). Read this, then `docs/PIPELINE-PRD.md`
(the loop, its rules and acceptance stories) and `docs/INTEGRATION.md` (the contract).

**Pickup update, Sat 10/24 23:46 PDT:** items 1–5 below are complete on the same branch after
merging current `origin/main`. The review findings in §5 were resolved and covered by focused tests.
No current provider credentials were available for a fresh live benchmark, so the recorded live Jev
run remains historical and the Moss boundary is verified offline; do not quote it as a Moss result.

## 1. What happened tonight, in one paragraph

Lane A built the core loop (persisted world, member routes, scoped MCP tools, one
`CANON_PERSON_TOKEN`, an end-to-end test) on `a/claude-code-loop`, but the branch sat unpushed
while Victor's B27 (#35) landed his own implementation of the same features in `server/` on
`main`, and Edan reconciled the console against it (ccfc9af). At 22:30 we chose `main` as the
base: `a/claude-code-loop` is pushed **as a record only** (do not merge it; its server files
conflict with main's in 27 files). This branch ports onto main only what main still lacks.

## 2. What this branch already adds (committed, tests green)

| Change | Where | Verified |
|---|---|---|
| CORS preflight allows `PUT` and `PATCH` (the console edits facts with PATCH and rules with PUT from its own origin; without this the browser dropped them) | `server/src/http.ts` | `server/src/app.test.ts` "unknown routes and preflight" |
| An unparseable request target is answered with a constant 400 and logged as `<unparseable url>` (the raw target carried `?token=`) | `server/src/router.ts` | `app.test.ts` "a request target Node accepts…" asserts the token is neither echoed nor logged |
| `startServer()` returns `living` (await `living.drain()` after a `fact.saved`) and `restored` (true when `data/world/principals.json` existed at start) | `server/src/app.ts` | used by `e2e/` |
| The end-to-end loop test workspace `e2e/` (real server on port 0, real distiller handler over HTTP, real hook scripts as child processes, Dollar Bill's token) | `e2e/`, root `package.json` workspaces | see §3: state at handoff |

Server suite on this branch: 139 tests pass (`npm test -w server`).

## 3. Original handoff checklist (items 1–5 completed during pickup)

1. **`e2e/` green on main's server.** `npm test -w e2e`. The test was written against the retired
   branch; main differs in small ways (the capture hook's debug line is
   `[canon] SessionEnd ses_xxxxxxxx 4 msgs → 200`, already fixed; `session.captured.session.client`
   is the capture source; triage filing changed in `distiller/src/triage.ts`). Adapt assertions
   about log formats only. **Never weaken** an assertion about leaks, refusals, authorship or scope
   membership: if one fails, that is a real product-rule defect on main; fix the server, not the
   test. Then add `e2e` to CI by nothing more than the workspace (root `npm run check` already runs
   every workspace's tests).
2. **Doctor connector checks** (`scripts/doctor.mjs`, `scripts/doctor.test.mjs`). Port the pure
   checks from `a/claude-code-loop:scripts/doctor.mjs` (`parseDotEnv`, `parseClientTokens`,
   `checkPersonToken`, `checkAuthor`, `checkMcpJson`, `checkHookWiring`, `main()` behind an
   `isMain()` guard) while keeping main's `setting()` precedence for ports and data dir. Adapt
   `checkMcpJson` to main's committed `.mcp.json` (server named `canon`, `localhost`): accept one
   http entry whose url ends in `/mcp` and whose Authorization header starts with
   `Bearer ${CANON_PERSON_TOKEN`; never a literal token. Drop the "bare `$CLAUDE_PROJECT_DIR`"
   warning: Claude Code runs hooks through Git Bash on Windows, where both forms expand. Merge the
   two `doctor.test.mjs` files (main's spawns the CLI from an isolated copy; the branch's tests the
   pure functions). CLAUDE.md already says `npm run doctor` checks `CANON_PERSON_TOKEN`; make it true.
3. **Hooks' shared `.env` lookup** (`hooks/claude-code/lib.mjs`): add `resolveEnv(names)` from the
   retired branch (process env → `.env` at `CANON_REPO_ROOT` → `../../.env` from the script) and use
   it in both `canon-capture.mjs` and `canon-context.mjs`, keeping main's token precedence
   (`CANON_PERSON_TOKEN || (CANON_PRINCIPAL && CANON_TOKEN_INGEST) || CANON_TOKEN_CLAUDE_CODE`) and
   main's debug line exactly (its tests pin it). Add a third candidate for **git worktrees**
   (`git -C <scriptDir> rev-parse --path-format=absolute --git-common-dir`, 1.5 s timeout, errors
   swallowed → `<common dir>/../.env`): today a worktree has no `.env`, so the person token is lost
   there and captures fall back to the operator token with no author. Test it.
4. **`install.mjs`**: port the retired branch's version (all three hook events incl.
   `UserPromptSubmit`, `--mcp`, `--show-token`) with `MCP_SERVER_NAME = "canon"` and
   `http://localhost:4100`; `--mcp` must print a PowerShell line too (`$env:CANON_PERSON_TOKEN`;
   PowerShell expands `${VAR}` inside double quotes to nothing). `--project` must regenerate exactly
   the committed `.claude/settings.json`. Update `hooks/claude-code/settings.snippet.json` and the
   Install section of `hooks/README.md`.
5. **Status board**: `status/status.json` has A22–A23 (added by this branch); set A23 as
   you finish, bump `updated`, run `node status/sync.mjs`, commit `STATUS.md` with the work.
6. **PR**: `a/loop-on-main` → `main`, merge commit (not squash), after CI's `check` job is green.

## 4. The measured benchmark (A8), what we know

`npm run finance -w bench` runs the 60 attacks + 30 tasks across the four setups against the
real server in-process. On this machine (Sat 10/24 ~22:45 PDT) it ran on **live Jev and Claude
(`claude-sonnet-5-5` responder and judge)** with the **keyword retriever** (no Moss key here), so
the runner labels the Bullwark setups *simulated* even though the leak code checks measure the real
enforcement path. The host `.env` lacks the person tokens the bench harness needs, so run it as:

```bash
CANON_CLIENT_TOKENS="$(grep '^CANON_CLIENT_TOKENS=' .env.example | cut -d= -f2-)" \
  npm run finance -w bench -- --allow-simulated --allow-partial
```

Results: `bench/results/finance-<stamp>.json` (always), `finance-latest.json` and
`finance-chart.json` (the pitch chart) when measured or `--allow-simulated`. Commit the run that
backs any quoted figure. With Moss credentials (Victor's machine) the labels drop.

## 5. Review findings resolved during pickup (historical checklist)

Each item below was confirmed, corrected and regression-tested. The session-ID distinction remains a
low-risk protocol property because IDs are unguessable capture hashes; no authorization data or
session content is returned.

- A creator can read moderator-set exclusions on their own agent's rule
  (`GET /api/scope-rules/:agent`, `server/src/scopes.ts`), contrary to INTEGRATION.md. **Edan's
  member client (`web/src/member/canon.ts` `updateAgent`) currently depends on that read** to keep
  group/label exclusions on a PUT, so change both sides together: return `exclude` only when
  `rule.set_by === caller`, and have the client send the server a PUT that preserves them.
- `GET /api/facts` for a member attaches `source_title` only for the caller's own items on main
  (good); keep it that way.
- `principalEvents` (`server/src/router.ts`) passes `server.started` totals and the member's own
  `scope.build` with `remaining` set to the scope size; a member's own build stages carry counts of
  hidden things. Zero them except at `done`.
- `POST /api/groups` adds the new group to every member rule's `exclude.groups` and bumps
  `updated_at` without rebuilding scopes (`rule_updated_at` on the scope goes stale). Decide whether
  to rebuild or to record the rule change in the audit.
- `POST /api/principals` without a `rule` gives a member a default task ("Use public market
  information for assigned work", excluding `deal`) and builds a scope on it. A moderator who adds a
  person has not written that task; consider leaving the person without a scope until a rule is set.
- `POST /api/sessions` is an existence oracle on other people's session ids (403 for a foreign
  existing id vs 200 for a new one). Low: the ids are not guessable in practice.
- `.env.example` offers `CANON_REPO_ROOT` as a `.env` key, but the hooks read it only from the
  process environment (it locates the `.env`). Reword.

## 6. Local state on Henry's machine (not in git)

- `data/` holds a live demo world from tonight's runs; `npm run reset -w server` returns it to 0:00.
- The host `.env` has Jev and Anthropic keys, no Moss or Factory keys, and a `CANON_CLIENT_TOKENS`
  line without the dispatcher, ingest and person tokens (copy the `.env.example` line).

## 7. Benchmark result recorded on this branch (Sat 10/24 22:40 to 23:05 PDT, `bench/results/finance-2026-10-25T05-40-57.198Z.json`)

One run, 360 cells (60 attacks and 30 tasks across 4 setups). Judge: live Jev and live Claude
(`claude-sonnet-5-5`). Retriever: keyword (no Moss key), so the runner labels the Bullwark setups
**simulated**: **do not quote these on Devpost**; rerun with Moss on Victor's machine.

| Setup | Leak rate | Missing-context rate | Accuracy |
|---|---|---|---|
| no-memory | 0% | 93% | 7% |
| shared-memory | 17% | 0% | 100% |
| bullwark-claude | 12% | 10% | 90% |
| bullwark-jev | 14% | 7% | 93% |

**Triage result:** all eight Jev flags were answer-judge-only flags. The served IDs were in-scope
public facts, and the answers either used only those facts or said the requested calculation lacked
an input. The old evaluator treated same-company topic overlap and neutral requests for another input
as disclosure. The evaluator now compares propositions, the responder prompt no longer advertises
"stored facts" or hidden context, and regression tests cover both cases. The two
`attack-56-agent-self-check` cells were Claude cyber-category refusals, not pipeline failures. A fresh
live, Moss-backed run is still required before publishing benchmark numbers.
