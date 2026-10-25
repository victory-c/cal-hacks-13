# `@canon/web` — Bullwark console and member view

Owner: lane C, Edan Wong. Static HTML and TypeScript, bundled with esbuild. The UI talks to Canon
only over HTTP and SSE; it imports no server implementation. `docs/INTEGRATION.md` and
`docs/PIPELINE-PRD.md` define the live contract. All finance demo data is synthetic.

```bash
npm run dev -w web       # build, watch and serve :4200
npm run build -w web     # one-shot browser bundles
npm start -w web         # serve an existing dist/
npm run typecheck -w web
npm test -w web          # node:test, offline
```

## Open the product

- `/moderator.html`: Compliance's people, scopes, agents, memory, quarantine, feed, handoffs and audit.
- `/member.html`: the signed-in person's own agents, memory and feed.
- `/index.html`: the original technical dashboard for capture/extraction diagnostics. The preview
  gateway redirects `/` to the appropriate product page after login.

The product pages use **live Canon at the page's origin by default**, with the preview gateway's
HttpOnly login cookie. They do not need a provider key or a token in the browser. The gateway maps
the selected synthetic person to a server-side per-person token.

For direct development with the static server and API on separate ports, use
`?server=http://localhost:4100&token=<person-token>`. An explicit token is removed from the address
bar and remembered only for `auth=token` mode; ordinary cookie logins ignore old saved tokens.
REST and streaming SSE both put explicit credentials in an Authorization header, never the SSE
URL. The stream reconnects and the page refetches current snapshots.

Use **`?data=mock`** for the browser simulation. It is explicitly labelled on the page. The member
mock contains only Ben Kim's public-side facts. The moderator mock includes the whole world, so
the preview gateway restricts moderator HTML, JavaScript and source maps to Compliance. Do not
expose the unauthenticated static development port as a public deployment.

## Live behavior

| Area | Implemented behavior |
|---|---|
| People and scopes | List people and their agents; add a person; change tiers; build/edit task and group exclusions; inspect the facts and streamed build stages. Editing group cards preserves existing label, prose and future-group exclusions. An empty scope can be saved. |
| Memory | **Top of mind · Background · All** tabs with counts: background memories (out of date, unused for a while, or moved there) show greyed with the reason, and are used only when a question asks about them. Each memory shows how often and how recently it was used, with **Move to background** / **Bring back** and **Let Bullwark decide**. Grouped facts with provenance/date; keyword, group, source and date filters; edit and retire; moderator filing of one or many facts and group creation. Filing preserves existing labels. Creating a group while editing a fact keeps the unsaved statement. |
| Capture | Add a memo, chat excerpt, email, transcript or note. Members capture as themselves; Compliance can attribute an item. Canon's real archive/triage/writer handles it. |
| Quarantine and inbox | Compliance sees held items, releases them, and files unplaced facts. Members see neither queue. |
| Agents | An agent profile is a name, a task, **what it can remember** (one box per group of the member's own memory; only their groups are listed) and an optional leave-out sentence. Create, edit, delete; **Run** on its task or on a one-off assignment typed on its card. While it works the card shows a live panel: the phase (getting ready, planning, working, writing, saving), a step count, a ticking clock and its last five steps in plain words ("Reading “TMC's assets under management…”", from the member's own memory). Stop requests cancellation; Stopped appears after the dispatcher reports it. When it finishes the card shows **What it wrote** (the documents, rendered from markdown as text nodes only) and **Saved to your memory** (the notes it wrote to `out/memories/`, which also arrive in My memory through the fact writer). Revoked scopes withdraw old run traces, withheld documents ask for a new run, and the dispatcher restarts when required. |
| Handoffs and audit | Compliance sees actual candidates, relevance decisions, estimated tokens and measured timings from Canon, plus the audit filtered by person/group. |

**Live limits:** renaming existing agents, document-type selection and schedules are not
implemented by the dispatcher. Those controls are hidden/disabled in live mode. A creator's group
edit can only narrow an agent whose rule Compliance set last. The mock exposes
and labels its simulated versions. File names are reported from real runtime steps; the UI does
not pretend to download arbitrary sandbox files.

Canon's canonical storage facts and worker events differ from display records. The HTTP clients
refetch the current authorized REST projections before displaying fact or agent SSE payloads,
so a replayed old save cannot reintroduce a revoked fact or a stale document. Scope removals also
clear affected local facts/documents immediately.

## Browser simulation

`src/member/mock.ts` and `src/moderator/mock.ts` implement the same view interfaces. They use
sentence splitting for extraction, keyword overlap for retrieval/judging, timed agent steps, and
documents assembled only from the simulated agent's scoped facts. Nothing is presented as a real
provider call. Regressions cover quarantine, staged scope builds, public announcement/refiling,
creator bounds, scope revocation, automatic restart, and new facts arriving during an existing run.

`src/member/fixture.ts` is a deliberately limited copy of Ben's facts. Tests check it against the
world without shipping the complete answer key in `member.js`. The moderator simulation uses the
full `fixtures/world` answer key and its additive inbox voicemail.

## Honest measurements and diagnostics

Tokens are labelled **est.** (approximately four characters per token). Unknown latency/cost is
shown as `—`; simulations are labelled. The technical dashboard can set a USD-per-million-token
rate with `?rate=`; no price is assumed. Its benchmark comparison reads same-origin
`/bench/latest.json`, which the development static server maps to `bench/results/latest.json`.
A missing/unrecognized result remains an explicit empty state.

The technical dashboard's original settings still use `?server=`, then its remembered setting,
then `DEFAULT_SERVER_URL`. It consumes canonical events and preserves extraction metadata; it is
separate from the principal product pages.

## Files and validation

- `src/member.ts`, `member.html`, `member.css`: member screen; `src/moderator.ts`,
  `moderator.html`, `moderator.css`: Compliance screen, preserving Edan's layout.
- `src/member/contract.ts`, `src/moderator/contract.ts`: display/API interfaces; `canon.ts`:
  HTTP clients and canonical-event adapters; `mock.ts`: labelled browser simulations.
- `src/stream.ts`: authenticated fetch SSE parser, reconnect and cancellation.
- `src/state.ts`, `main.ts`, `render.ts`: technical dashboard.
- Tests cover view logic, mock journeys, fixture/benchmark consistency, scope-rule preservation,
  label-safe filing, dispatch tasks, current-snapshot event projection, and SSE framing/auth.

`npm run check` at the repository root additionally checks all workspaces, the shared contracts,
server authorization and the end-to-end pipeline. A successful browser build alone is not an
end-to-end deployment test.
