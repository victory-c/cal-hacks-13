# Local preview verification — October 24, 2026

Tested the Docker preview at `http://localhost:8080` using synthetic data. The starting source
revision was `f69d08a`; the permission fixes below are part of the same verification change.
This is a local preview, not a public Vultr deployment.

## Live provider run

The run at 00:49 UTC on October 25 (17:49 PDT on October 24) passed **36/36 HTTP and MCP checks**.
Provider keys and preview credentials were read from the ignored local environment file and were
not copied into this report or the browser.

| Check | Observed result |
| --- | --- |
| Login and routing | Unauthenticated API/MCP/SSE requests returned 401; invalid password returned 401; foreign login origin returned 403; valid login set an HttpOnly, SameSite=Strict cookie and routed the dashboard to its own API URL |
| Web delivery | Dashboard HTML, JavaScript and CSS returned 200 |
| REST authorization | Client-specific fact lists matched folder grants; private facts were absent from the dashboard; unknown bearer token returned 401 |
| Capture and archive | Session accepted for its authenticated client; client impersonation and cross-client raw transcript reads returned 403; dashboard raw transcript access returned 401 |
| Factory → Jev → store | New synthetic session `ses_16e25cd2` produced six facts; worker event named `droid`, and all six save decisions named `jev` |
| Retention | Four facts were saved hot and two cold; measured worker time was 12,036 ms, and capture-to-visible wall time was 12,124 ms |
| Moss → Jev → context | Ten candidates produced six returned facts, including three facts from this new session; 212 estimated tokens within a 300-token budget; measured request latency 125 ms |
| MCP authorization | Both Claude Code and ChatGPT identities matched their tokens; search results stayed inside their grants; explicit private-folder requests were rejected |
| Extraction plans | Team-dashboard SSE omitted raw extraction plans |

The context response reported `enough: false`. Retrieval succeeded, but Jev did not certify that
these facts fully answered the broad architecture task. Cold facts were not indexed for hot
retrieval. These observations are not a claim of answer quality or finance-wall coverage.

## Bugs found and fixed

- Authenticated SSE originally bypassed folder grants. Ordinary streams now apply their read
grant to live events and replay, hide other clients' activity, and omit restricted fact references.
The internal distiller keeps its full stream; the tokenless team dashboard keeps its existing
team view with private facts and private references excluded.
- Fact writes originally checked only the destination folder. A caller could overwrite a restricted
ID or retire a restricted fact via merge/supersede. The entire batch now checks write access to
each existing fact it would mutate before persisting any entry.
- A caller could replace another client's archived session by reusing its ID. Session updates now
require the original capturing client, including when the caller is the internal distiller.

Automated regression tests use isolated temporary stores. Live permission checks use clearly
marked synthetic canaries; their `fake` save decisions exercise authorization and are separate
from the real Jev provider run above.

## Final regression and restart checks

- `npm run check`: **291/291 tests passed**, including 15 new permission regressions;
all workspace typechecks and status validation passed. `npm run build` built both the web and
extension bundles successfully.
- The rebuilt Docker image passed **16/16 additional live authorization checks**: batch write
rejection, restricted-ID protection, session ownership, ordinary/internal/dashboard SSE views,
private retirement references, and filtered replay. Together with the provider run, this is
52 passing HTTP/MCP checks.
- SHA-256 hashes of the running container's API, router and store sources matched the tested
local files. Both app and proxy were recreated successfully.
- A second recreation preserved **24 facts and 4 sessions**, with the complete fact-content
fingerprint unchanged. All six provider-run facts and all three synthetic permission canaries
remained present. The private canaries remain private; all permission canaries are cold.
- After recreation, authenticated health still named Jev and Moss. A fresh MCP search returned
ten authorized hot facts, including all four new hot facts from the provider run.

Final container verification completed at 00:53 UTC on October 25 (17:53 PDT on October 24).
The synthetic records remain in the local preview for inspection; existing data and persistent
model-cache volumes were preserved.

## What this does not verify

- Browser automation is disabled in the current Work settings. HTML/assets and API connections
were checked over HTTP; rendered appearance and click-through interaction were not visually tested.
- The implemented server still uses folder grants. Finance principals, scopes, quarantine,
scoped agent runs, and the complete finance demo remain separate tasks on the board.
- No shared public server or team-accessible HTTPS URL was provisioned by this test.
- Anthropic fallback had a successful live check during provider activation (B22); this run used
Factory as the active extractor and did not repeat the fallback request.

Re-run source validation with `npm run check` and `npm run build`. Check the local stack with
`docker compose --env-file .env.preview -f compose.preview.yaml ps`. Provider checks require
valid runtime keys and can consume provider credit; offline automated tests use test doubles.
