# Bullwark: two-minute pitch

Victor talks (B15); Henry drives; Edan times the pitch and keeps the backup recording ready.
The sequence matches [VIDEO_SCRIPT.md](VIDEO_SCRIPT.md). These are cue points, not measured
runtime promises. Use the actual runtime name and the data shown in the take.

| Time | Screen | Say |
|---|---|---|
| 0:00 | Dollar Bill's opening answer, then Wags's scope inspector | “Dollar Bill asks about Taylor Mason Capital. His assistant receives public information and his desk notes. Axe Capital is preparing a confidential bid, but those facts were never in his memory.” |
| 0:15 | Moderator overview | “Bullwark is the control room for a small finance team's AI. Wags handles compliance at our synthetic thirty-person fund. All this finance data is invented.” |
| 0:25 | Capture, grouping and quarantine | “Memos and AI sessions become sourced facts. Jev judges what to keep and where it belongs. Instructions aimed at an AI go to quarantine, and uncertain filing goes to Compliance.” |
| 0:40 | Ben Kim's scope build | “Wags sets Ben's public-research task and excludes the deal group. Code removes excluded groups before search. Jev judges the remaining candidates. That fixed list is Ben's memory.” |
| 1:00 | Two agent lanes and a Ben-created Stonewall attempt | “Agents inherit their creator's scope. Ben cannot give an agent facts he never had. Each run works from its own scoped folder; the steps are visible here.” |
| 1:20 | Announced terms refiled into public | “When the bid is announced, Wags publishes only the announced terms. Private valuation and financing stay private. Narrowing interrupts an active agent and restarts it in a fresh folder. Stop cancels it.” |
| 1:40 | Handoff and audit | “Every handoff records exactly what was sent. Our sixty attacks and thirty legitimate tasks are ready; the full benchmark is pending, so we are not claiming a leak rate.” |
| 1:55 | Scale slide | “Decision support for a compliance officer. Small finance teams now; a company version after validation.” |

If the full measured finance benchmark arrives, replace the pending line with its actual results.
If it does not, retain that line. Do not borrow the legacy benchmark's numbers.

## Demo operation and fallback

Use the opening question in person-bound Claude Code/MCP or the desk assistant's stored Run task;
the member page has no general chat input. If Ben already exists, edit his rule rather than trying
to add a duplicate. The console supports group exclusions; use the control actually present.

For a fresh local demo, run against a new empty temporary data directory on unused ports. The
server seeds it automatically. Do not reset the shared preview. A separate judge session should
start before announcement, with deal facts still outside the public-side scopes. There is no
shipped dedicated attack-box page; judges can suggest a question for the operator to enter.

If a live beat fails, play its matching clip and keep talking. If cloud connectivity fails, play
the complete backup recording; running the UI locally does not make cloud models offline.
Edan still needs to record, upload and rehearse; this script is not evidence those steps happened.

## Judge questions

| Question | Answer |
|---|---|
| Is the data real? | All finance content is synthetic, using Billions-inspired names. We do not claim a customer interview or quote that we have not collected. |
| What does the product replace? | Manual agent briefings and scattered records of which AI saw what. The target buyer is the compliance owner at a small finance firm; customer validation remains future work. |
| Why not a shared memory and a careful prompt? | The shared-memory baseline gives the model secrets and asks it to withhold them. Bullwark limits the searchable universe before answering. We have not completed the measured comparison yet. |
| Can the scope be wrong? | Yes. A misfiled fact or wrong admission decision can put information in the wrong scope. Exclusions, labels, uncertain picks to inbox and an inspectable audit reduce the risk; they do not prove zero leakage. |
| What if Jev says yes incorrectly? | Relevance cannot resurrect a group already removed in code. Filing and semantic exclusions still depend on judgment, which is why the audit and adversarial tests matter. |
| Can a member's agent escalate? | Its scope is intersected with its creator's, at build time, on updates and on reads. Creating an agent does not create a route to additional facts. |
| What happens after an announcement? | Compliance refiles announced terms into public. The private model and financing keep their deal classification. Removing every deal exclusion would disclose more than the demo intends. |
| What happens when access narrows? | The dispatcher aborts the active step, discards the old folder and restarts from the current scope. Reconnect and before-step checks also catch missed events. |
| What does Stop do? | It requests cancellation through a persistent generation. The worker aborts current work; old-generation output saves are rejected. The UI shows Stopped when cancellation telemetry arrives. |
| How do you handle outages? | Ended captures are recovered from the archive using durable content receipts. Provider failures do not silently switch an agent to a simulated runtime. |
| Which sponsors do real work? | The preview uses Factory SDK extraction, Jev judgments, Moss retrieval and Claude scoped agents. A separate real Droid CLI finance-agent run completed under macOS Seatbelt; Linux Droid isolation remains unverified. |
| Is this legal compliance? | No. It is decision support and a record of the scopes the operator set. Production use needs legal review and operational hardening. |
| What is the cost or leak rate? | We have not measured the complete benchmark yet. The UI preserves unknown values and labels token estimates. |
| Where is the data? | The host stores markdown facts and JSON captures with persisted scopes and audit. Model requests send relevant text to the configured provider. The preview is a Mac-hosted HTTPS service, not a Vultr VM. |
| Is this employee authentication? | The preview uses a shared team password to select synthetic identities. Individual authentication, SSO and tenant isolation are future production work. |
| Can judges attack it? | Suggest a question or create an agent in a public-side demo identity; the operator can inspect the resulting authorized handoff. No dedicated attack-box UI is claimed. |

After collecting a consented interview quote, add it with the speaker's role and source notes.
Rehearse with a timer and update only with measurements from the actual take.
