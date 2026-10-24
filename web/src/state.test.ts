import assert from "node:assert/strict";
import { test } from "node:test";

import type { CanonEvent, Fact, SaveDecision } from "@canon/shared";

import { EVENT_TYPES, initFromFacts, initialState, lastServed, newestFirst, reduce } from "./state.ts";
import type { State } from "./state.ts";

const T0 = "2026-10-24T03:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

function fact(id: string, over: Partial<Fact> = {}): Fact {
  return {
    id,
    statement: `Statement for ${id}`,
    folder: "career/projects",
    tier: "hot",
    jev_keep: 0.9,
    source: { client: "claude-code", session: "ses_00000001" },
    updated: "2026-10-24",
    ...over,
  };
}

function decision(over: Partial<SaveDecision> = {}): SaveDecision {
  return { tier: "hot", folder: "career/projects", action: "add", keep_p: 0.9, folder_p: 0.8, judge: "fake", ...over };
}

function run(events: CanonEvent[], start: State = initialState()): State {
  return events.reduce(reduce, start);
}

test("EVENT_TYPES lists each type once", () => {
  assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length);
  assert.equal(EVENT_TYPES.length, 20);
});

test("a replayed fact.saved lands on the same row", () => {
  const saved: CanonEvent = { type: "fact.saved", at: at(1), fact: fact("fct_aaaa0001"), decision: decision() };
  const s = run([saved, saved, { ...saved }]);
  assert.equal(s.facts.size, 1);
  assert.equal(s.facts.get("fct_aaaa0001")?.decision?.judge, "fake");
});

test("sessions update in place by id", () => {
  const s = run([
    { type: "session.captured", at: at(1), session: { id: "ses_1", client: "chatgpt", title: "Roles", messages: 2, ended: false } },
    { type: "session.captured", at: at(5), session: { id: "ses_1", client: "chatgpt", title: "Roles", messages: 7, ended: true } },
    { type: "session.captured", at: at(3), session: { id: "ses_2", client: "claude-code", messages: 1, ended: false } },
  ]);
  assert.equal(s.sessions.size, 2);
  assert.deepEqual(s.sessions.get("ses_1"), { id: "ses_1", client: "chatgpt", title: "Roles", messages: 7, ended: true, at: at(5) });
  assert.equal(newestFirst(s.sessions.values())[0]?.id, "ses_1");
});

test("distill.finished replaces distill.started for the session", () => {
  const s = run([
    { type: "distill.started", at: at(1), session_id: "ses_1", engine: "droid" },
    { type: "distill.finished", at: at(4), session_id: "ses_1", engine: "droid", facts: 3, plan: "1. read\n2. extract", duration_ms: 2870 },
  ]);
  assert.equal(s.distills.size, 1);
  const row = s.distills.get("ses_1");
  assert.equal(row?.status, "finished");
  assert.equal(row?.facts, 3);
  assert.equal(row?.duration_ms, 2870);
  assert.equal(row?.plan, "1. read\n2. extract");
});

test("supersede retires the old fact, via fact.retired or the saving decision", () => {
  const s = run([
    { type: "fact.saved", at: at(1), fact: fact("fct_aaaa0001"), decision: decision() },
    { type: "fact.saved", at: at(2), fact: fact("fct_bbbb0002", { supersedes: "fct_aaaa0001" }), decision: decision({ action: "supersede", supersedes: "fct_aaaa0001" }) },
  ]);
  assert.deepEqual(s.facts.get("fct_aaaa0001")?.retired, { by: "fct_bbbb0002", at: at(2) });
  assert.equal(s.facts.get("fct_bbbb0002")?.retired, undefined);

  // The server's explicit event says the same thing; applying it changes nothing material.
  const s2 = reduce(s, { type: "fact.retired", at: at(3), id: "fct_aaaa0001", superseded_by: "fct_bbbb0002" });
  assert.equal(s2.facts.get("fct_aaaa0001")?.retired?.by, "fct_bbbb0002");
  assert.equal(s2.facts.size, 2, "retired facts stay listed, struck through");
});

test("fact.retired arriving before its fact still marks it", () => {
  const s = run([
    { type: "fact.retired", at: at(1), id: "fct_aaaa0001", superseded_by: "fct_bbbb0002" },
    { type: "fact.saved", at: at(2), fact: fact("fct_aaaa0001"), decision: decision() },
  ]);
  assert.equal(s.facts.get("fct_aaaa0001")?.retired?.by, "fct_bbbb0002");
});

test("context.served: newest first, duplicates dropped, lastServed is the latest", () => {
  const served = (sec: number, task: string): CanonEvent => ({
    type: "context.served",
    at: at(sec),
    client: "claude-code",
    task,
    fact_ids: ["fct_aaaa0001"],
    candidates: 12,
    tokens: 1380,
    latency_ms: 410,
    enough: true,
  });
  const s = run([served(1, "first"), served(9, "second"), served(1, "first"), served(5, "late arrival")]);
  assert.equal(s.served.length, 3);
  assert.deepEqual(
    s.served.map((r) => r.task),
    ["second", "late arrival", "first"],
  );
  assert.equal(lastServed(s)?.task, "second");
  assert.equal(lastServed(s)?.tokens, 1380);
});

test("access.denied log dedupes replays", () => {
  const denied: CanonEvent = { type: "access.denied", at: at(1), client: "chatgpt", tool: "canon_context", folder: "private" };
  const s = run([denied, denied]);
  assert.equal(s.denied.length, 1);
  assert.equal(s.denied[0]?.folder, "private");
});

test("server.started is recorded", () => {
  const s = run([{ type: "server.started", at: at(0), facts: 42, sessions: 7 }]);
  assert.deepEqual(s.server, { facts: 42, sessions: 7, at: at(0) });
});

test("initFromFacts: REST rows have no decision until an event brings one; supersedes marks the old fact", () => {
  const rest = [fact("fct_aaaa0001"), fact("fct_bbbb0002", { supersedes: "fct_aaaa0001" })];
  let s = initFromFacts(rest);
  assert.equal(s.facts.size, 2);
  assert.equal(s.facts.get("fct_aaaa0001")?.decision, undefined);
  assert.equal(s.facts.get("fct_aaaa0001")?.retired?.by, "fct_bbbb0002");

  s = reduce(s, { type: "fact.saved", at: at(1), fact: fact("fct_bbbb0002", { supersedes: "fct_aaaa0001" }), decision: decision({ action: "supersede", supersedes: "fct_aaaa0001" }) });
  assert.equal(s.facts.get("fct_bbbb0002")?.decision?.action, "supersede");

  // Reloading the list after a reconnect keeps the decision we already know.
  s = initFromFacts(rest, s);
  assert.equal(s.facts.get("fct_bbbb0002")?.decision?.action, "supersede");
  assert.equal(s.facts.size, 2);
});

test("reduce never mutates the previous state", () => {
  const before = run([{ type: "fact.saved", at: at(1), fact: fact("fct_aaaa0001"), decision: decision() }]);
  const after = reduce(before, { type: "fact.saved", at: at(2), fact: fact("fct_cccc0003"), decision: decision() });
  assert.equal(before.facts.size, 1);
  assert.equal(after.facts.size, 2);
  assert.notEqual(before.facts, after.facts);
});

test("reduce rejects an event type outside the contract", () => {
  assert.throws(() => reduce(initialState(), { type: "nope", at: at(0) } as unknown as CanonEvent), /unknown event/);
});
