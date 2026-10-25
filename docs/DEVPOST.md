# Devpost: Bullwark

Owner: Victor (B12). Edan handles media, team details, track selections and submission (C8/C10).
This copy reflects the integrated implementation and the verification in
[B_LANE_WRAPUP.md](B_LANE_WRAPUP.md). It deliberately makes no unmeasured benchmark claim.
The product source is [BULLWARK-PRD.md](BULLWARK-PRD.md); the running interface is
[INTEGRATION.md](INTEGRATION.md).

## Project name

Bullwark

## Tagline

The control room for a small finance team's AI.

## Inspiration

A small fund's compliance officer needs to keep confidential deal work separate from research
and trading. AI adds another place for that information to spread: chats, saved memories and
agents that keep working after someone's responsibilities change.

Our synthetic demo follows Wags, COO and compliance at Axe Capital, a 30-person hedge fund.
Axe is preparing Project Stonewall, a bid for Taylor Mason Capital. Ben Kim writes public-side
research, and Dollar Bill manages a trading book. Their AI tools should remember what their
work needs without hinting at information outside their scope.

We built a working prototype around this problem. Customer interviews and production validation
remain future work; we do not present a synthetic persona as customer evidence.

## What it does

Dollar Bill asks about Taylor Mason Capital. His assistant receives public information and his
own desk notes. Stonewall facts never enter that context. Wags can inspect the scope and the
handoff record to see exactly which facts were available and which were sent.

Bullwark captures notes, memos and AI sessions, archives the original, and turns the text into
short facts with a source and author. Jev judges whether to keep each draft, where it belongs,
and whether the source contains instructions aimed at an AI. Unplaced facts wait in a
moderators-only inbox; suspected instructions go to quarantine.

Wags describes each person's task and exclusions. Canon removes excluded groups and labels in
code, searches the remaining facts, and asks Jev which candidates fit. The result is a fixed
list of fact IDs. Requests search only inside that list. A member can create an agent whose
scope stays inside their own.

The moderator console shows people, scopes, memory, quarantine, agent activity, handoffs and
audit. Members see their own memory and agents. When announced offer terms become public,
Wags refiles those facts into the public group; the valuation model and financing stay private.
A narrowing interrupts an active agent and rebuilds its working folder from the current scope.
The live consoles also support Stop.

## How we built it

Bullwark is the frontend; Canon is the backend. Separate TypeScript processes communicate over
REST and authenticated Server-Sent Events. A shared package defines the contracts. Facts are
markdown files, raw captures are JSON, and scope decisions and agent telemetry persist in a
file store.

Claude writes facts and scoped agent briefs. Jev answers batched triage, scope and relevance
questions. Moss provides local hybrid retrieval, with code checking results against the
canonical scope IDs. Without credentials, explicit offline providers are labelled simulated.

Factory's headless SDK performs real fact extraction in the preview with tools disabled.
The preview's scoped agents use the Claude fallback runtime, whose file tools are confined by
code. The separate Droid CLI dispatcher also completed a real scoped finance-agent run under
macOS Seatbelt. Linux Droid isolation remains unverified, so the Docker preview retains Claude.

Claude Code uses one person-bound token for capture, before-prompt memory and MCP. The four
MCP tools are canon_context, canon_search, canon_save and canon_whoami. Browser Add item and
the ingest client provide the demo's reliable capture paths. ChatGPT extension code exists,
but its live browser acceptance check is not part of the verified demo.

## Challenges we ran into

- Relevance is not authorization. Exclusions and the fixed scope must constrain search before
  a model chooses useful context.
- A scope can still be wrong if a fact is misfiled or a judge makes a bad admission decision.
  Labels, conservative uncertainty handling, quarantine and an inspectable audit reduce that risk.
- Narrowing an agent requires discarding its drafts and plan, since those files may contain a
  removed fact. Stopping the current process alone is insufficient.
- Capturing the same session again must not change fact IDs, ownership or living scopes.
  Exact repeats are no-ops; paraphrased merges retain the original author, and clear same-author
  position updates retire the stale position.
- A worker outage must not lose ended sessions. Durable content receipts let the worker recover
  from the archive and avoid reprocessing completed revisions.
- Writer prompts need actual display names and must distinguish new claims from an assistant
  repeating previously injected memory.

## Accomplishments that we're proud of

The integrated prototype connects capture, fact writing, triage, living scopes, MCP and the
console. Automated regressions exercise authorization, persistence, restart behavior and the
HTTP/SSE path through a running agent. Separate real-provider checks exercise Jev, Claude,
Factory extraction and Moss; the verification report distinguishes these from offline tests.

The finance benchmark runner and its 60 attacks and 30 legitimate tasks exist. A complete
measured run across all four setups is still pending, so we make no numerical claim about leak
rate, missing-context rate, accuracy, cost or speed. Test-set sizes are coverage targets.

## What we learned

Access control needs an explicit boundary that can be inspected and tested. A small, stable
memory is easier to reason about than a prompt asking a model to ignore secrets it already has.
Agent lifecycle controls and durable recovery are part of that boundary, not presentation polish.

## What's next for Bullwark

Validate the workflow with finance and compliance practitioners, complete the measured benchmark,
and test on redacted real workflows. A production version needs individual authentication,
SSO, operational monitoring, retention policies, tenant isolation and real document connectors.
The current shared preview login selects synthetic identities; it is team demo access.

## Built with

TypeScript, Node.js, Claude, Jev, Factory Droid SDK, Moss, MCP, REST, Server-Sent Events,
esbuild, Docker, local markdown and JSON storage.

## Sponsor integration evidence

- Anthropic: fact writer, scoped briefs, fallback agent runtime and fallback judge.
- Factory: verified headless SDK extraction and a completed scoped CLI finance-agent run on macOS; Docker agents use Claude.
- Moss: local hybrid retrieval for scope construction and in-scope handoffs.
- Hyphenate: the small-fund workflow, creator-bounded agents and audit trail.
- Microsoft: inspectable handoffs, persistent decisions, test coverage and a documented scale path.
- Armadin: scope enforcement, injection quarantine and adversarial test cases. A dedicated judge
  attack-box screen is not shipped.

Track eligibility and selections are confirmed by the submitter. Bitdeer, Mana and Notability
are not claimed without implementation or usage evidence. Details: [SPONSORS.md](SPONSORS.md).

## What's real and what's simulated

All finance data is synthetic, using Billions-inspired names. Bullwark is decision support
for a compliance officer, not a replacement for legal compliance.

The preview uses real Factory extraction, Jev judgments, Moss retrieval and Claude agent runs.
Offline tests use explicitly simulated providers. The new live scope/Stop check uses Jev and
Claude with keyword retrieval, so it does not establish Moss performance. Full benchmark results,
customer interview evidence, public Vultr deployment and live ChatGPT capture remain unverified.

## Links and submission handoff

- [Source repository](https://github.com/victory-c/cal-hacks-13)
- [Video script](VIDEO_SCRIPT.md), [pitch](PITCH.md), [scale slide content](SCALE_SLIDE.md)
- [Verification and remaining work](B_LANE_WRAPUP.md)

Edan must add the uploaded video URL, cover image, screenshots, teammates and selected tracks
in Devpost. No uploaded video or customer quote is asserted in this text.
