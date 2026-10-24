import assert from "node:assert/strict";
import { test } from "node:test";

import { newFactId, newSessionId, nowIso, today } from "./ids.ts";
import { FACT_ID_RE, SESSION_ID_RE } from "./types/fact.ts";

test("newFactId / newSessionId match the contract regexes and do not collide", () => {
  const facts = new Set<string>();
  const sessions = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const f = newFactId();
    const s = newSessionId();
    assert.match(f, FACT_ID_RE);
    assert.match(f, /^fct_[0-9a-f]{8}$/);
    assert.match(s, SESSION_ID_RE);
    assert.match(s, /^ses_[0-9a-f]{8}$/);
    facts.add(f);
    sessions.add(s);
  }
  assert.equal(facts.size, 1000);
  assert.equal(sessions.size, 1000);
});

test("today is the local YYYY-MM-DD", () => {
  const t = today();
  assert.match(t, /^\d{4}-\d{2}-\d{2}$/);
  const d = new Date();
  assert.equal(t, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
});

test("nowIso is ISO 8601 UTC and parses back", () => {
  const s = nowIso();
  assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Math.abs(Date.parse(s) - Date.now()) < 5000);
});
