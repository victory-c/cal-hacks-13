# Sponsor integration evidence

Owner: Victor (B13). Current integrated code and this working branch are the evidence baseline;
changes on this branch still need the team's normal review and merge. Tests and live calls prove
different things. See [B_LANE_WRAPUP.md](B_LANE_WRAPUP.md) and
[SHARED_PREVIEW.md](SHARED_PREVIEW.md) for their separate evidence.

| Tool or track | Implemented role | Verified boundary |
|---|---|---|
| Anthropic | Claude fact writer in `distiller/src/engines/claude.ts`; scoped briefs and fallback runtime in `distiller/src/dispatch/`; fallback judge in `shared/src/judge/claude.ts` | Real writing and Claude runtime calls verified. No production-compliance claim. |
| Factory | Headless SDK extraction in `distiller/src/engines/droid.ts`; CLI dispatcher in `distiller/src/dispatch/runners/droid.ts` | Preview extraction is real. Preview agents use Claude. Linux Droid dispatch has no configured supported OS sandbox; a real macOS Seatbelt finance-agent run completed two steps and saved its note in 35.3 seconds (single run). |
| Jev / TypeSafe | Batched triage, exclusion/relevance decisions and routing, behind `shared/src/judge/jev.ts` | Real keyed requests and integrated finance scope behavior verified; judge probabilities are decisions, not measured security guarantees. |
| Moss | `server/src/retrieval/moss.ts` local hybrid retrieval; scope construction and handoff results checked against canonical IDs | Prior preview live retrieval passed. Keyword retrieval is an explicitly simulated alternative. No full benchmark latency claim. |
| Hyphenate | Wags's small-fund workflow, scope builder, creator-bounded agents, living scopes and audit | Integrated API/UI and synthetic-world regressions. Customer quote and video recording still require team work. |
| Microsoft | Handoff inspector, audit, persistent state, four-setup finance runner and scale path | Runner and 60-attack / 30-task sets implemented. Complete measured 360-cell run pending; no leak or usefulness rates claimed. |
| Armadin | Triage quarantine, code-enforced scopes and agent bounds | Enforcement and quarantine tests exist. Dedicated attack-box UI remains unshipped. Track criteria/selection are submitter checks. |

The Claude Code hooks and ingest/Add item paths are implemented and tested. The ChatGPT extension
has code and offline tests, but no completed live chatgpt.com capture acceptance check here.
MCP uses per-principal tokens; shared preview login selects a synthetic identity and keeps the token
on the host. The shared password is not individual employee authentication.

Bitdeer has no verified writer integration. Mana and Notability require actual usage artifacts.
Do not select or claim these solely because they appear in planning documents. Vultr hosting
remains blocked by account review; the existing preview is hosted on the Mac through HTTPS.

For recordings, retain provider labels, token estimates and unknown values. Say which provider
actually ran. Do not call Claude agent lanes Droid lanes. Missing benchmark metrics remain absent;
a simulated benchmark is not submission evidence.
