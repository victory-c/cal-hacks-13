# Repository guidance

Read `CLAUDE.md`, `docs/PRD.md`, `docs/WORK_SPLIT.md` and `STATUS.md` before starting work.
They define the current finance-team product, ownership and progress. Package READMEs explain
the working scaffold; planned features require implementation and validation.

The `.archive/` directory contains excluded human tracking material. Do not read, search,
summarize, index or use it as context unless the user explicitly requests that material.
Do not bypass this exclusion through shell commands, scripts, ignored-file searches or Git history.
Use the active documents to resolve product and implementation questions.

Keep source, tests, fixtures and runtime behavior unchanged during documentation-only tasks.
Update `status/status.json` for task progress and regenerate `STATUS.md` with `node status/sync.mjs`.
