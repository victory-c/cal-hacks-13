# Canon

One place that keeps your context from every AI session, live, and gives each new chat only
what it needs. Built at Cal Hacks 13.0.

Canon captures sessions from Claude, ChatGPT and Gemini on the web and from Claude Code,
Cursor and Hermes as they happen, with no export or import. When you open a new session
anywhere, Jev picks the small slice of context that's relevant and Moss retrieves it. You
decide which AI can see which folder.

- **Spec:** [`docs/PRD.md`](docs/PRD.md)
- **Working agreement for humans and agents:** [`CLAUDE.md`](CLAUDE.md)
- **Progress:** [`STATUS.md`](STATUS.md), generated from [`status/status.json`](status/status.json)

## Status board

```bash
node status/serve.mjs
```

Then open http://localhost:4173. After editing `status/status.json`, run:

```bash
node status/sync.mjs
```

It validates the file and regenerates `STATUS.md`. Commit both with your work.

## Setup

Copy `.env.example` to `.env` and fill in the keys. Never commit `.env`.

## Sponsor integrations

Each section below says where the integration runs in the product. They get filled in as the
work lands.

- **Anthropic (Claude):** _TBD_
- **Factory Droid SDK:** _TBD_
- **Moss:** _TBD_
- **Microsoft (Built for the Real World):** _TBD_
