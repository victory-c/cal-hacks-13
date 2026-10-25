# Lane B freeze wrap-up

Verified October 24, 2026 (PDT), on `codex/b-finish-pipeline`, based on main `ec4ef79`.
Changes are local; the shared preview has not been rebuilt during this task. This report is the
handoff to Henry and Edan for the additive contract, dispatcher and frontend changes.

## Screenshot coding checklist

| Screenshot item | Result and evidence |
|---|---|
| 4. Offline group table | Already fixed on the starting main. `financeFakeJudge` derives finance categories from supplied groups, including Stonewall-world desk and research groups. Existing triage regression passes. |
| 7. Retire stale position | Extended the existing match to the actual seed wording: “The desk is long 180,000 TMC shares at an average cost…” is superseded by its owner’s explicit “Dollar Bill is now long 200,000 TMC shares.” The narrow desk-owner rule preserves other subjects, securities, units, trade deltas and older dates. Regression passes. |
| 8. Merge authorship | Already fixed. Paraphrased merges retain the original author. Existing regression passes. |
| 9. Live duplicate churn | Already fixed. Exact repeated drafts retain identity and send no fact rewrite. Worker and triage regressions pass. |
| 10. Ended sessions during outage | Already fixed. Archive catch-up plus durable revision receipts runs at startup/reconnect and every 30 seconds. The HTTP pipeline regression checks restart idempotency. |
| 11. Writer names and memory echoes | Added server-resolved display names to worker and posting CLI options, Claude/Factory headers and heuristic attribution. Captured metadata cannot supply the name. Existing prompt rule against assistant repeats is retained; real Claude check below verifies it. |
| 12. Live scope change during run | Actual HTTP rule edit and authenticated SSE abort a running step, discard its old folder and restart it without the removed fact. Covered offline end to end and with real Jev/Claude calls. |
| 13. Agent Stop | Implemented creator/Compliance route, persistent generations, SSE cancellation, pending-dispatch cancellation, reconnect/before-step checks, stale output rejection and both live UI controls. Later Run remains allowed. |

The Stop event is `dispatch.stop_requested`. Run/request `stop_generation` is optional in shared
contracts for compatibility; the server stamps new requests. Internal workers read
`GET /api/agents/:id/control`; members cannot read controls for other principals. Changes must be
deployed together. Stop does not retract an output already accepted before the cancellation.

## Separate live provider evidence

All runs used fresh temporary data and sandbox directories, synthetic input and host credentials
loaded without printing their values. No shared preview data was reset or modified.

- **Jev + Claude scope/Stop:** the HTTP/SSE acceptance harness passed in **12,044 ms**, with
  three runtime invocations, one scope restart, an ordinary Stop and a missed-event Stop found
  by resync. Real Claude briefs/runtime calls and Jev were used; retrieval was the simulated
  keyword adapter. These are cancellation observations, not completed-work performance numbers.
- **Claude writer + Jev:** a session from `dollar-bill` said “I am now long 200,000 TMC shares”; an
  assistant turn merely repeated an injected risk-review memory. Claude emitted one fact,
  “Dollar Bill is now long 200,000 TMC shares.” It omitted the risk-review repeat. In the
  successful full capture/MCP/restart check, writing took **2,051 ms**, triage **191 ms**, delivery
  **77 ms**, and Jev keep was **0.63** (hot). Earlier checks of the same synthetic content yielded
  a **0.59** cold fact, consistent with the existing 0.6 hot threshold. This small check does not
  establish extraction accuracy or judge calibration; thresholds were not changed.
- **Factory Droid CLI:** a real research agent ran under macOS **Seatbelt**, completed two
  invocations, created `out/plan.md` and `out/result.md`, and saved one captured session attributed
  to its creator, Ben. The isolated HTTP/SSE run took **35,332 ms**, including scope/brief/provider
  work. Runtime facts contained the supplied public holding only. This verifies a real
  file-based finance task, not Python execution, Linux isolation or a full two-agent demo.

The Droid acceptance run exposed and fixed two issues: execute npm's canonical binary rather
than its denied `.bin` symlink, and allow the current `ApplyPatch` file tool instead of older
`Create`/`Edit` names. Read/list/search/patch are allowed; shell, web and automation tools were not
added. A canonical-executable regression accompanies the fix.

## Validation

Final `npm run check` passed **742 tests**, status validation and every workspace typecheck.
`npm run build` passed the browser and extension bundles. `git diff --check`, submission-marker
checks and local Markdown-link checks passed. The final distiller suite contains 258 tests,
including the actual demo-seed position case; the server suite contains 121 tests.

Root regressions include `scripts/agent-control.test.mjs` and `scripts/pipeline.test.mjs`.
The control test uses real HTTP/SSE with explicitly simulated judge/runtime and covers scope
revocation, Stop authorization, stale replay, missed events, pending and stale queued dispatch,
output-save rejection, and restart persistence. Unit suites cover routing additions and process
group cancellation. No test result is presented as a measured finance benchmark.

## Story and remaining handoffs

Devpost copy, pitch, video script, sponsor evidence, scale-slide content and README now match
Axe Capital / Stonewall / Taylor Mason Capital and actual preview providers. The announcement
beat refiles only public terms; it does not open the valuation model or financing. Unmeasured
claims and placeholder quote/video links were removed, with explicit human handoffs retained.
The scripts use the shipped Run/MCP paths and group-exclusion controls rather than inventing a
chat box, prose-exclusion form or dedicated attack-box page.

Still outside this completed coding work:

- Henry: complete the measured four-setup finance benchmark; only its resulting finance files
  may supply leak/missing-context/accuracy/cost claims.
- Team: review/merge this branch and deploy server, dispatcher and browser bundles together;
  then run the full preview dress rehearsal. This task did not publish or deploy changes.
- Edan: recording/upload, screenshots and cover image, teammates/track selections, rehearsal
  and final Devpost submission. A customer interview requires a real participant and consent.
- Deferred connectors: live ChatGPT-extension acceptance and ChatGPT MCP connector. The
  current build's reliable paths remain Claude Code, ingest and Add item.
- Vultr: external account review still blocks the new isolated VM. Existing Mac-hosted HTTPS
  preview remains the documented deployment.

The remaining items are not marked completed on the board.
