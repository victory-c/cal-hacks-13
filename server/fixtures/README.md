# Sample data for development

Hand-written fixtures so the demo runs on a fresh machine: `npm run seed -w server` copies them
into the data dir (`CANON_DATA_DIR`, default `data/`) without overwriting anything there.

- `facts/<folder>/<id>.md` — 10 facts for a Berkeley student recruiting for internships, in the
  CLAUDE.md fact file format. One (`fct_0b2d4f6e`) is cold, superseded by `fct_a1c3e5f7`, so the
  retire flow has something to show. `private/health` exists to demo a grant refusal.
- `sessions/ses_de0001.json` — the captured Claude Code session behind the `projects/canon` facts.
  Session ids are `ses_` + hex (`SESSION_ID_RE`), so `ses_demo01` would not be a valid id.

Not real benchmark data. Numbers in the facts (dates, thresholds) describe the project, not
measurements.
