# `@canon/shared` — the A↔B contract as code

**Owner:** lanes A (Henry Lai) and B (Victor Chun) together. Nothing here runs on its own: every
other package imports it (`import { ... } from "@canon/shared"`, never a relative path). Pure
TypeScript, zero dependencies, runs under `tsx` with no build step.

The existing folder-based contracts remain the implemented interface. Finance wall labels,
deals, expiring entitlements, lists and audit events are planned extensions (A1), not fields
available to consumers yet. Coordinate with both builders before changing them.

## Frozen vs free

| Path | Status | Change it by |
|---|---|---|
| `src/types/*` | **Frozen.** Fact schema, session capture, MCP tool I/O, events, grants, `Judge`. | Agreeing the interface with both builders, updating consumers and documenting the change together. |
| `src/*.ts`, `src/judge/*` | Free. Runtime helpers. | A PR. Add, don't rename: other lanes import these names. |

### Adding a helper

1. Put it in a small file under `src/` (or `src/judge/`), with a comment that says why it exists.
2. `export * from "./your-file.ts"` under **Runtime helpers** in `src/index.ts` (`.ts` extension,
   `import type` for type-only imports).
3. Test it in `your-file.test.ts` next to it: `node:test` + `node:assert/strict`, fast, offline.
   For HTTP, boot your own server on port 0 (see `src/test-helpers.ts`).

## What is in here

| File | Exports | Notes |
|---|---|---|
| `env.ts` | `loadEnv` `env` `requireEnv` `dataDir` `REPO_ROOT` | Call `loadEnv()` once at the top of each entrypoint, never in library code. |
| `grants.ts` | `folderAllows` `grantFor` `canRead` `canWrite` `parseClientTokens` | Prefix match is per path segment: `projects` grants `projects/x`, not `projects-other`. |
| `tokens.ts` | `estimateTokens` `factTokens` `cutToBudget` | ~4 chars/token. Label it **est.** in any UI; real counts come from a model's `usage`. |
| `fact-file.ts` | `serializeFactFile` `parseFactFile` `validateFact` `factPath` | The markdown fact file (frontmatter + body). Hand-rolled YAML for this flat schema. |
| `ids.ts` | `newFactId` `newSessionId` `today` `nowIso` | `fct_`/`ses_` + 8 hex. `today()` is local, `nowIso()` is UTC. |
| `sse.ts` | `subscribeEvents` `formatSseEvent` `parseSseChunk` | Client reconnects with backoff (1 s → 10 s) until unsubscribed, also when no bytes arrive for `idleMs` (default 45 s, 3× the server's 15 s heartbeat). Non-JSON events → `onError`. |
| `judge/` | `createJudge` `timed` `FakeJudge` `JevJudge` `ClaudeJudge` | See below. |

**Fact files.** `serializeFactFile(fact)` writes the shape defined in `src/types/fact.ts`; `parseFactFile`
also reads a hand-edited file (block-form `source:`, comments, CRLF, unknown keys ignored).
`validateFact` never throws and returns a clean `Fact` (optionals only when set, detail body
normalized). `factPath` is `facts/<folder>/<id>.md` relative to `dataDir()`.

## How `judge()` works

Jev answers typed questions with probabilities; our code applies the thresholds in
`THRESHOLDS`. Every provider implements the same `Judge` interface, so swapping is config:

```ts
const judge = createJudge();                       // logs "[judge] provider: …"
const { result, ms } = await timed(() => judge.ask(state, questions));
```

| `JUDGE_PROVIDER` | Class | Real? | Needs |
|---|---|---|---|
| `jev` | `JevJudge` | Yes. **Request/response shape unverified until TypeSafe's docs arrive (blocker Q3).** | `JEV_API_KEY`, `JEV_API_URL` |
| `claude` | `ClaudeJudge` | Yes. `claude-haiku-5-5`, one forced `answer` tool call, raw Messages API over `fetch`. | `ANTHROPIC_API_KEY` |
| `fake` | `FakeJudge` | **No, simulated.** Deterministic keyword heuristic; logs that it is simulated. | nothing |

Unset, `createJudge` picks `jev` if `JEV_API_KEY` is set, else `claude` if `ANTHROPIC_API_KEY`
is set, else `fake`. A missing key for an explicit provider fails at construction with the
variable's name. Both network judges read responses defensively: a missing or malformed answer
becomes a neutral default (`p` 0.5 / `options[0]` / midpoint) with one `console.warn`.

**The one-batched-request rule (`CLAUDE.md`).** One `judge.ask()` per decision: one `state`,
all candidates' questions in the array. Never loop `ask()` over candidates.

**Sponsor integration.** Anthropic plugs in at `src/judge/claude.ts` (the fallback judge, so the
demo keeps deciding when Jev is down). Jev plugs in at `src/judge/jev.ts`.

## Run and test

```bash
npm run typecheck -w shared
npm test -w shared          # ~0.5 s, offline, no keys needed
```
