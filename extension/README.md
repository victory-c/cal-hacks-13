# extension/ — Bullwark Capture (Chrome MV3)

**Owner:** lane B, Victor Chun. Captures ChatGPT web sessions live and streams them to the Bullwark
server. Part of the "live, no export/import" story: the same conversation shows up on the dashboard
while you are still typing in it.

## What runs where

| Piece | Runs in | Does |
|---|---|---|
| `src/content/chatgpt.ts` | the chatgpt.com tab (isolated world) | Watches the DOM, extracts the turns 1.5 s after the last change, sends `{ kind: "turns", … }` to the worker. On `pagehide` sends `ended: true`. |
| `src/background.ts` | extension service worker | Throttles per conversation (2 s), stamps `started_at`, `POST /api/sessions` with the bearer token. Badge `•` green on success, `!` red on failure. |
| `src/options.html` + `options.ts` | options page | Bullwark URL, client token, principal id, Save, Test connection (`GET /health`), last post result. |
| `src/shared/` | both | `protocol.ts` (messages), `session.ts` (turns → `CapturedSession`, FNV-1a session ids), `settings.ts` (storage keys). Pure, tested. |
| Other content scripts | Other declared sites | Inactive compatibility stubs; outside the current capture scope. |

What gets captured: **turn text only** (`user` / `assistant`), the page URL and the conversation title.
No cookies, no account data, no DOM beyond the message nodes. Every snapshot re-sends the whole
turn list; the server upserts by session id, so a conversation is one `ses_…` in the cold archive
no matter how many times it is posted. The id is FNV-1a of `chatgpt:<conversation id>`, so it is
stable across reloads with no state. Session capture does not call any AI; nothing here is
simulated. (The server downstream may run its judge/distiller in simulated mode and says so.)

**Finance fields (walls).** Every captured chat is `kind: "ai_session"`, and carries `principal`
(whose context it is, e.g. `dan`) when one is set on the options page. The value is normalized
the same way as in the Claude Code hook and the ingest CLI (`Dan`, `Dan Okafor` and
`dan.okafor@harborlane.com` all become `dan`; `agt_research_1` is kept), so one person has one
id; blank means the field is left out and triage treats the session cautiously. Today's server
accepts and drops both fields until lane A's server keeps them for the finance contract; nothing
else changes. If the extension is cut (see [Current capture scope](#current-capture-scope)),
Dan's ChatGPT session goes in through the ingest CLI instead, as
[`hooks/README.md`](../hooks/README.md#dans-chatgpt-session-without-the-extension) describes.

## Run

```bash
npm run build -w extension          # → extension/dist (or: npm run dev -w extension to watch)
```

1. `chrome://extensions` → Developer mode → **Load unpacked** → pick `extension/dist`.
2. Click the extension → **Options**. Bullwark URL is `http://localhost:4100` by default. Token: the
   `chatgpt=…` value from `CANON_CLIENT_TOKENS` in the repo's `.env` (`dev-chatgpt` in
   `.env.example`). Principal: your id at the firm (`dan` in the demo). Save, then **Test
   connection** should report the server's health.
3. Open chatgpt.com and chat. The badge turns green on the first successful post; the session
   appears on the dashboard (http://localhost:4200) and in `data/sessions/`.

Red badge: open Options, the status line shows the last error (no token, server down, 401 from a
wrong token). After `npm run dev -w extension` rebuilds, click the extension's reload icon in
`chrome://extensions`; content scripts only re-attach on page reload.

## Test

```bash
npm run typecheck -w extension
npm test -w extension               # node:test, offline, ~1 s
```

Tests cover the session id (format, stability, per-site), `extractTurns` against a fake DOM root
(roles, order, empty and unknown roles skipped), `toCapturedSession` (title fallback, `ended_at`),
the worker's pure helpers (`buildPost`, `shouldDebounce`), the message guard, and a build smoke
test that bundles into a temp dir and asserts no `node:` import reached the browser.

## Fragility note

ChatGPT changes its markup often. All selectors live in `SELECTORS` at the top of
`src/content/chatgpt.ts`: today a turn is `[data-message-author-role]`. If capture goes quiet,
open DevTools on chatgpt.com and run `document.querySelectorAll("[data-message-author-role]").length`.
Fix the selector, rebuild, reload the extension. The service worker and the server never change.

## How `@canon/shared` is used

Extension code imports only from `@canon/shared` (types plus the contract constants `ROUTES`,
`DEFAULT_SERVER_URL`, `KNOWN_CLIENTS`). The package's index also re-exports Node-only helpers,
so `scripts/build.mjs` resolves `@canon/shared` to `shared/src/types/*` for the browser bundle.
Importing a runtime helper (e.g. `estimateTokens`) in extension code fails the build with a clear
"No matching export"; port it into `src/shared/` instead. Tests run under Node and see the whole
package.

## Sponsor integrations

None plug in here. The extension is a capture client; Droid, Jev and Moss do their work in
`distiller/` and `server/` on what it sends.

## Current capture scope

The finance demo uses the Claude Code hook, ingest API and ChatGPT capture. Other capture
stubs are preserved in source and are not scheduled work. The ChatGPT extension is the first
capture path to cut if time runs short. Use `../docs/WORK_SPLIT.md` for ownership and gates.
