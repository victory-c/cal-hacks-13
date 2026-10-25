# Shared HTTPS preview

The tested `main` revision `3a8bc07` is accessible through an authenticated HTTPS tunnel to the
existing local Docker stack. This is a team preview hosted on Victor's Mac, not a Vultr VM.
The exact URL and team login are in the host's private file
`~/.config/bullwark/preview-access.txt` (mode 600). Share only that URL and team password privately
with teammates; browser viewers do not need sponsor API keys.

## Current operation

- ngrok forwards HTTPS to `http://127.0.0.1:8080`; the API and worker ports stay unpublished.
- The existing Bullwark sign-in protects dashboard files, API reads, health and SSE. Machine clients
use their own Canon bearer token and retain the implemented folder grants.
- `.env.preview` has `PREVIEW_PUBLIC_URL` equal to the tunnel's HTTPS origin and `PREVIEW_SITE=:80`.
This gives the login form the correct Origin check, redirects the dashboard to the shared API,
and produces Secure, HttpOnly, SameSite=Strict cookies. Use the HTTPS URL for browser login;
`localhost:8080` is the tunnel upstream and is no longer the configured browser login origin.
- ngrok HTTP inspection is disabled so its local inspector does not record passwords, bearer
headers or request bodies. Provider keys remain in the ignored host environment file.
- Docker volumes preserve the file store and Moss model cache. Existing records were retained.

On this host, `~/Library/LaunchAgents/com.bullwark.preview-tunnel.plist` starts the existing ngrok
binary with the assigned HTTPS URL, restarts it if it exits, and wraps it with `caffeinate -s`.
The host must stay powered, connected and awake, with Docker running. The power assertion applies
on AC power; it does not make a closed or powered-off laptop a cloud server. Logs are in
`~/Library/Logs/Bullwark/`. The LaunchAgent and credential file are local operational configuration,
not repository secrets or committed runtime files.

```bash
# App/proxy health
docker compose --env-file .env.preview -f compose.preview.yaml ps
# Tunnel supervisor status
launchctl print gui/$(id -u)/com.bullwark.preview-tunnel
# Start it again after an explicit stop (if not already loaded)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.bullwark.preview-tunnel.plist
# Stop public access while keeping local Docker data
launchctl bootout gui/$(id -u)/com.bullwark.preview-tunnel
```

After updating app code, preserve the Compose project and data volumes:

```bash
git pull --ff-only
docker compose --env-file .env.preview -f compose.preview.yaml up -d --build --wait
```

## Measured verification

On October 24, 2026 (October 25 UTC), the HTTPS endpoint passed **36/36 authenticated/public
HTTP and MCP checks**, plus **14 independent unauthenticated route checks**:

- Login succeeded with the actual HTTPS Origin and set a Secure/HttpOnly/SameSite cookie.
Wrong passwords, foreign origins and unknown bearer tokens were rejected.
- Dashboard HTML, JavaScript and CSS were delivered after login. API/MCP/SSE requests without
a team session or valid client token returned 401. Public source/asset requests exposed only the
login page. Private facts and raw transcripts were excluded from unauthorized views.
- New synthetic session `ses_d0b366b1` traversed public capture → Factory → Jev → stored facts.
The worker saved seven real Jev-judged facts (five hot, two cold), retiring four previous facts
by normal merge/supersede decisions. Worker time was 20,488 ms; capture-to-visible wall time
was 21,592 ms. No preexisting record was manually removed.
- Public MCP search returned authorized Moss results. The context request considered eleven
candidates and returned one fact (10 estimated tokens within a 300-token budget), with a measured
server latency of 159 ms. It reported `enough: false`, so this is connectivity/retrieval evidence,
not a claim that the broad architecture question was fully answered.
- Public SSE delivered extraction completion events with raw plans omitted.

A separate 18-second public SSE check received a newly emitted capture event and the server's
15-second heartbeat. The session was reposted with its existing message count; the worker
recognized the duplicate and did not repeat extraction. The ngrok agent is supervised by the
active macOS LaunchAgent, and its public URL remained unchanged after supervision was enabled.

Browser automation remains disabled in Work settings, so rendered appearance and manual
click-through have not been visually verified. Earlier local regression results are in
[LOCAL_TEST_REPORT.md](LOCAL_TEST_REPORT.md).

## Remaining hosting work

Vultr MLH account activation, confirmed credit/spending and VM credentials were unavailable on this
host. No paid VM was created. For hosting independent of this Mac, use the existing single-VM
Docker deployment in [PREVIEW.md](PREVIEW.md), transfer the secret file securely, and set its
public origin to the VM's HTTPS URL. No app migration is needed.

The preview runs the current folder-grant implementation. Henry's scope branch and the full
finance demo remain separate integration work; they were not deployed by enabling this tunnel.
