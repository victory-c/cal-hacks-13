# Shared HTTPS preview

The finance integration runs on the existing **Mac Docker preview**, through its authenticated
HTTPS tunnel. It is not a Vultr VM. The public URL and team password are in the private host file
`~/.config/bullwark/preview-access.txt` (mode 600); share those privately with teammates. Browser
viewers do not need any sponsor API key.

## Access and identities

Sign in as `team`, enter the preview password, and choose Wags, Axe, Ben or Dollar Bill. Wags opens
the moderator console; the others open the member view. **Switch demo identity** returns to the
selector. The shared password permits selecting any synthetic identity; this is team demonstration
access, not individual employee authentication.

The gateway keeps each Canon token on the server and attaches it to API requests. Canon enforces
that principal's scope. Machine clients use their own bearer token. Use the same
`CANON_PERSON_TOKEN` for Claude Code capture, before-prompt context and the committed `.mcp.json`.
Never give a teammate the distiller/dispatcher token or the whole host environment file.

- Pages default to live data. `?data=mock` selects explicitly labelled offline fixtures.
- SSE uses authenticated fetch with headers/cookies; tokens stay out of URLs.
- Member sessions cannot download moderator bundles or benchmark results, including encoded paths.
- Unknown/absent API credentials receive 401; member administrative actions receive 403.
- Missing judge answers cannot admit facts or weaken exclusions. Raw private source headlines are
  omitted from facts shown to other members. Agent reads stay inside the creator's current scope
  even while a child scope rebuild is pending.

## Measured verification, October 24, 2026

The final integration passed **737 automated tests**, workspace TypeScript checks and builds.
The test suite includes a real HTTP capture → archive → writer → triage → living scope → MCP
round trip, worker catch-up after an outage, durable duplicate receipts and a server restart.
Providers in that regression are labelled simulations; it is not live provider evidence.

Separate live checks against the HTTPS preview passed **32 authentication, role, static asset,
privacy, health and MCP assertions**. Real Jev and Moss returned three public facts for Dollar Bill;
the response omitted hidden-candidate and missing-context fields. Moderator and member pages loaded
in the browser without console errors.

A new synthetic person-bound session `ses_6d0d7182` passed through the configured real Factory
extractor and Jev triage. It produced a hot research fact attributed to Axe, visible to scopes
whose rules fit. The seeded `desk-assistant` then completed a real Claude run in two runtime
invocations, producing `out/result.md` and saving its output as Dollar Bill's captured memory.
The member console showed the run as Done. This verifies the Claude fallback, not Linux Droid
agent isolation. Factory remains the real extraction provider.

These checks do not establish the full 360-cell finance benchmark, native Claude Code process
hook execution, automatic scheduling or live agent Stop/document configuration. Unsupported live
controls are hidden or disabled. The source contract and package READMEs describe current behavior.

## Operation and persistence

ngrok forwards HTTPS to `http://127.0.0.1:8080`; API/worker ports stay unpublished. Its local
HTTP inspector is disabled. The configured origin produces Secure, HttpOnly, SameSite=Strict
cookies and validates login origins. Sponsor keys stay in ignored `.env.preview`.

The Compose project and existing data/model volumes were retained. A private tar backup was made
before adding the finance fixtures; existing captures were preserved. People, scopes, rules,
quarantine, agent telemetry and audit persist under the data volume. Fixture sessions already
represented by seeded facts receive receipts, avoiding unnecessary paid extraction on restart.

On this host `~/Library/LaunchAgents/com.bullwark.preview-tunnel.plist` supervises ngrok and wraps
it with `caffeinate -s`. The Mac must stay powered, connected and awake, with Docker running.
Logs are in `~/Library/Logs/Bullwark/`.

```bash
npm run preview:setup # preserves credentials, adds any missing principal/worker tokens
npm run preview:check
# Build/update while retaining the Compose project and data volumes:
docker compose --env-file .env.preview -f compose.preview.yaml up -d --build --wait
docker compose --env-file .env.preview -f compose.preview.yaml ps
# Stop public access without deleting Docker data:
launchctl bootout gui/$(id -u)/com.bullwark.preview-tunnel
```

A new isolated Vultr sponsor VM remains blocked by account review. The user is seeking onsite
Vultr/MLH assistance. No Vultr resource was created and no support email was sent. Do not reuse
Hermes or another existing server. See [VULTR_DEPLOYMENT.md](VULTR_DEPLOYMENT.md).

## Lane B follow-up branch

The local follow-up in `docs/B_LANE_WRAPUP.md` adds live Stop and writer display-name resolution.
Its API, dispatcher and browser bundles must be deployed together after review. The earlier
preview evidence above describes the previously deployed integration; these local changes have
not been installed into the shared running preview during this task.
