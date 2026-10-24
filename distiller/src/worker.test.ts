// Controlled worker tests keep revision ordering, retries and independent sessions observable.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";

import { FakeJudge } from "@canon/shared";
import type { CanonEvent, CapturedSession, Fact, PostFactsBody } from "@canon/shared";
import type { CanonClient } from "./client.ts";
import { DroidDistiller, HeuristicDistiller } from "./engines/index.ts";
import { fakeFact, loadFixture, quiet } from "./test-helpers.ts";
import { RevisionLedger, createHandler, sessionRevision } from "./worker.ts";

function fakeClient(sessions: Record<string, CapturedSession>, hot: Fact[] = []) {
  const calls = { getSession: [] as string[], listFacts: 0, posts: [] as PostFactsBody[] };
  const client: CanonClient = {
    async getSession(id) {
      calls.getSession.push(id);
      const s = sessions[id];
      if (!s) throw new Error(`GET /api/sessions/${id} -> HTTP 404: no such session`);
      return s;
    },
    async listFacts() {
      calls.listFacts++;
      return hot;
    },
    async postFacts(body) {
      calls.posts.push(body);
      return { saved: body.facts.map((f) => f.fact.id), retired: body.facts.flatMap((f) => (f.fact.supersedes ? [f.fact.supersedes] : [])) };
    },
  };
  return { client, calls };
}

/** `at` defaults to now: a fixed past timestamp would read as an SSE replay and be skipped. */
function captured(id: string, messages: number, ended: boolean, at = new Date().toISOString()): CanonEvent {
  return { type: "session.captured", at, session: { id, client: "claude-code", messages, ended } };
}

const fixture = loadFixture();
const judge = () => quiet(() => new FakeJudge()).then((r) => r.result);

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

async function revisionHarness(failFirst = false) {
  const a: CapturedSession = { ...fixture, messages: [{ role: "user", content: "We decided to use Postgres because it handles concurrent writes." }] };
  const b: CapturedSession = { ...a, messages: [{ role: "user", content: "We decided to use SQLite because the demo runs on one laptop." }] };
  const sessions = { [a.id]: a };
  const { client, calls } = fakeClient(sessions);
  const started = gate();
  const blocked = gate();
  const distilled: CapturedSession[] = [];
  const engine = new HeuristicDistiller();
  const handler = createHandler({ client, judge: await judge(), live: false, distiller: {
    name: engine.name,
    async distill(session) {
      distilled.push(session);
      if (distilled.length === 1) {
        started.release();
        await blocked.promise;
        if (failFirst) throw new Error("first revision failed");
      }
      return engine.distill(session);
    },
  } });
  return { a, b, sessions, calls, handler, started, blocked, distilled };
}

describe("worker handler", () => {
  test("an ended session is fetched, distilled, judged and posted once; a repeat is skipped", async () => {
    const { client, calls } = fakeClient({ [fixture.id]: fixture }, [fakeFact("fct_aaaa0001", "Older hook fact")]);
    const handler = createHandler({ client, distiller: new HeuristicDistiller(), judge: await judge(), live: false });

    const { lines } = await quiet(async () => {
      await handler(captured(fixture.id, 8, true));
      await handler(captured(fixture.id, 8, true)); // same content → fetched, then a no-op
      await handler.settle();
    });

    assert.deepEqual(calls.getSession, [fixture.id, fixture.id], "the repeat is fetched to compare its content");
    assert.equal(calls.listFacts, 1);
    assert.equal(calls.posts.length, 1);
    assert.ok(calls.posts[0].facts.length >= 2);
    assert.ok(calls.posts[0].facts.every((f) => f.decision.judge === "fake"));
    assert.ok(lines.some((l) => /heuristic distilled \d+ drafts in \d+ ms \(simulated\)/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /fake judged \d+ drafts against 1 hot facts in \d+ ms/.test(l)));
    assert.ok(lines.some((l) => /saved \d+, retired \d+ in \d+ ms/.test(l)));
    assert.ok(lines.some((l) => l.includes(`session ${fixture.id}: unchanged since it was distilled (${fixture.messages.length} messages), skipping`)), lines.join("\n"));
  });

  // Greptile on PR #12 ("Edited memos keep old facts"): a re-imported memo keeps its session id and
  // its one message, so a key of id + message count skipped the corrected text for good.
  test("a re-sent session with the same id and message count but new content is distilled again", async () => {
    const memo: CapturedSession = {
      id: "ses_0000me00",
      client: "ingest",
      started_at: "2026-10-22T13:00:00.000Z",
      ended_at: "2026-10-22T13:00:00.000Z",
      kind: "memo",
      messages: [{ role: "user", content: "We decided to use Postgres for the fact store because it handles concurrent writes." }],
    };
    const sessions: Record<string, CapturedSession> = { [memo.id]: memo };
    const { client, calls } = fakeClient(sessions);
    const handler = createHandler({ client, distiller: new HeuristicDistiller(), judge: await judge(), live: false });
    await quiet(async () => {
      await handler(captured(memo.id, 1, true));
      sessions[memo.id] = { ...memo, messages: [{ role: "user", content: "We decided to use SQLite for the fact store because the demo runs on one laptop." }] };
      await handler(captured(memo.id, 1, true)); // corrected file, same id, same count
      sessions[memo.id] = { ...sessions[memo.id], started_at: "2026-10-24T05:00:00.000Z", ended_at: "2026-10-24T05:00:00.000Z" };
      await handler(captured(memo.id, 1, true)); // re-imported unchanged (only the times moved)
      await handler.settle();
    });
    assert.equal(calls.getSession.length, 3);
    assert.equal(calls.posts.length, 2, "the corrected text is distilled; the unchanged re-import is not");
    assert.match(calls.posts[1].facts.map((f) => f.fact.statement).join("\n"), /SQLite/);

    const base = sessionRevision(memo);
    assert.equal(sessionRevision({ ...memo, title: "renamed", meta: { path: "x" }, started_at: "2027-01-01T00:00:00.000Z" }), base, "times, title and meta are not content");
    assert.notEqual(sessionRevision({ ...memo, principal: "dan" }), base, "a new author is distilled again");
    assert.notEqual(sessionRevision({ ...memo, external: true }), base);
  });

  // Greptile on f069d37 ("Restored memos stay stale"): a set of every revision ever distilled
  // skipped a memo restored to an earlier text, so the store kept the correction's facts while the
  // archive held the original again.
  test("a memo restored to an earlier text is distilled again; only the last revision is a no-op", async () => {
    const a: CapturedSession = {
      id: "ses_0000me01",
      client: "ingest",
      started_at: "2026-10-22T13:00:00.000Z",
      ended_at: "2026-10-22T13:00:00.000Z",
      kind: "memo",
      messages: [{ role: "user", content: "We decided to use Postgres for the fact store because it handles concurrent writes." }],
    };
    const b: CapturedSession = { ...a, messages: [{ role: "user", content: "We decided to use SQLite for the fact store because the demo runs on one laptop." }] };
    const sessions: Record<string, CapturedSession> = { [a.id]: a };
    const { client, calls } = fakeClient(sessions);
    const handler = createHandler({ client, distiller: new HeuristicDistiller(), judge: await judge(), live: false });
    await quiet(async () => {
      await handler(captured(a.id, 1, true)); // A
      sessions[a.id] = b;
      await handler(captured(a.id, 1, true)); // corrected to B
      sessions[a.id] = a;
      await handler(captured(a.id, 1, true)); // restored to A
      await handler(captured(a.id, 1, true)); // A again, unchanged
      await handler.settle();
    });
    assert.equal(calls.getSession.length, 4);
    const posted = calls.posts.map((p) => p.facts.map((f) => f.fact.statement).join("\n"));
    assert.equal(posted.length, 3, "A, B and the restored A are distilled; the repeat of A is not");
    assert.match(posted[0], /Postgres/);
    assert.match(posted[1], /SQLite/);
    assert.match(posted[2], /Postgres/, "the restored text reaches the store again");
  });

  test("a slow A cannot save stale facts when B arrives, and settle waits for B", async () => {
    const h = await revisionHarness();
    const { lines } = await quiet(async () => {
      const first = h.handler(captured(h.a.id, 1, true));
      await h.started.promise;
      h.sessions[h.a.id] = h.b;
      const second = h.handler(captured(h.a.id, 1, true));
      await tick();
      let settled = false;
      const settling = h.handler.settle().then(() => { settled = true; });
      await tick();
      assert.equal(settled, false);
      assert.equal(h.distilled.length, 1, "B waits for A of the same session");
      h.blocked.release();
      await Promise.all([first, second, settling]);
    });
    assert.deepEqual(h.distilled, [h.a, h.b]);
    assert.equal(h.calls.posts.length, 1, "stale A is never posted");
    assert.match(h.calls.posts[0].facts[0].fact.statement, /SQLite/);
    assert.equal(lines.filter((l) => l.includes("dropping stale result")).length, 1);
  });

  test("B and C queued behind a running A: B is skipped without distilling, C is distilled", async () => {
    const h = await revisionHarness();
    const c: CapturedSession = { ...h.a, messages: [{ role: "user", content: "We decided to use DuckDB because the analysts query it locally." }] };
    const { lines } = await quiet(async () => {
      const first = h.handler(captured(h.a.id, 1, true));
      await h.started.promise;
      h.sessions[h.a.id] = h.b;
      const second = h.handler(captured(h.a.id, 1, true));
      for (let i = 0; i < 5; i++) await tick();
      h.sessions[h.a.id] = c;
      const third = h.handler(captured(h.a.id, 1, true));
      for (let i = 0; i < 5; i++) await tick();
      h.blocked.release();
      await Promise.all([first, second, third]);
      await h.handler.settle();
    });
    assert.deepEqual(h.distilled, [h.a, c], "B never reaches the distiller");
    assert.equal(h.calls.posts.length, 1);
    assert.match(h.calls.posts[0].facts[0].fact.statement, /DuckDB/);
    assert.ok(lines.some((l) => l.includes("a newer revision is queued, skipping this one")), lines.join("\n"));
  });

  test("a fetch overtaken by a newer capture never claims, even when its older content lands last", async () => {
    const a: CapturedSession = { ...fixture, messages: [{ role: "user", content: "We decided to use Postgres because it handles concurrent writes." }] };
    const b: CapturedSession = { ...a, messages: [{ role: "user", content: "We decided to use SQLite because the demo runs on one laptop." }] };
    const { client, calls } = fakeClient({ [a.id]: a });
    const slowA = gate();
    let fetches = 0;
    const getSession = client.getSession.bind(client);
    client.getSession = async (id: string) => {
      fetches++;
      if (fetches === 1) {
        await slowA.promise; // the first fetch's response arrives after the second's
        return a;
      }
      await getSession(id);
      return b;
    };
    const handler = createHandler({ client, distiller: new HeuristicDistiller(), judge: await judge(), live: false });
    const { lines } = await quiet(async () => {
      const first = handler(captured(a.id, 1, true));
      const second = handler(captured(a.id, 1, true));
      // The second fetch lands (and claims) first; only then does the first, older one land.
      for (let i = 0; i < 5; i++) await tick();
      slowA.release();
      await Promise.all([first, second]);
      await handler.settle();
    });
    assert.equal(calls.posts.length, 1, "only the newer content is saved");
    assert.match(calls.posts[0].facts[0].fact.statement, /SQLite/);
    assert.ok(lines.some((l) => l.includes("a newer capture arrived while fetching")), lines.join("\n"));
  });

  test("queued A, B, A distills the restored A and drops the original A", async () => {
    const h = await revisionHarness();
    await quiet(async () => {
      const first = h.handler(captured(h.a.id, 1, true));
      await h.started.promise;
      h.sessions[h.a.id] = h.b;
      const second = h.handler(captured(h.a.id, 1, true));
      await tick();
      h.sessions[h.a.id] = h.a;
      const restored = h.handler(captured(h.a.id, 1, true));
      await tick();
      assert.equal(h.distilled.length, 1, "both later revisions wait");
      h.blocked.release();
      await Promise.all([first, second, restored, h.handler.settle()]);
    });
    assert.deepEqual(h.distilled, [h.a, h.a], "B, already replaced by the restored A, never reaches the distiller");
    assert.equal(h.calls.posts.length, 1, "only the last A is current");
    assert.match(h.calls.posts[0].facts[0].fact.statement, /Postgres/);
  });

  test("a failed job does not block the queued next revision of that session", async () => {
    const h = await revisionHarness(true);
    const { lines } = await quiet(async () => {
      const first = h.handler(captured(h.a.id, 1, true));
      await h.started.promise;
      h.sessions[h.a.id] = h.b;
      const second = h.handler(captured(h.a.id, 1, true));
      await tick();
      assert.equal(h.distilled.length, 1, "B is queued behind the failing A");
      h.blocked.release();
      await Promise.all([first, second, h.handler.settle()]);
    });
    assert.deepEqual(h.distilled, [h.a, h.b]);
    assert.equal(h.calls.posts.length, 1);
    assert.match(h.calls.posts[0].facts[0].fact.statement, /SQLite/);
    assert.ok(lines.some((l) => l.includes("first revision failed")));
  });

  test("different sessions distill concurrently", async () => {
    const h = await revisionHarness();
    await quiet(async () => {
      const first = h.handler(captured(h.a.id, 1, true));
      await h.started.promise;
      const other = { ...h.b, id: "ses_0000cafe" };
      h.sessions[other.id] = other;
      await h.handler(captured(other.id, 1, true));
      assert.deepEqual(h.distilled, [h.a, other], "second session finishes while first is blocked");
      assert.equal(h.calls.posts.length, 1);
      h.blocked.release();
      await Promise.all([first, h.handler.settle()]);
    });
    assert.equal(h.calls.posts.length, 2);
  });

  test("RevisionLedger: a failed distill is forgotten, but never clears a newer claim", () => {
    const ledger = new RevisionLedger();
    const a: CapturedSession = { id: "ses_0000me02", client: "ingest", started_at: "2026-10-22T13:00:00.000Z", messages: [{ role: "user", content: "A" }] };
    const b: CapturedSession = { ...a, messages: [{ role: "user", content: "B" }] };
    const revA = ledger.claim(a.id, a);
    assert.ok(revA);
    assert.equal(ledger.claim(a.id, a), undefined, "a second copy of A while A is claimed is a no-op");
    const revB = ledger.claim(a.id, b);
    assert.ok(revB && revB !== revA);
    ledger.release(a.id, revA); // A failed after B was claimed: B stays the last revision
    assert.equal(ledger.claim(a.id, b), undefined);
    ledger.release(a.id, revB); // B failed: a re-post of either text runs again
    assert.equal(ledger.claim(a.id, b)?.revision, revB.revision);
    assert.equal(ledger.claim("ses_0000me03", a)?.revision, revA.revision, "per session: another id with the same text is its own");
  });

  test("a session.captured replayed from before the worker started is skipped, not re-distilled", async () => {
    const { client, calls } = fakeClient({ [fixture.id]: fixture });
    const handler = createHandler({ client, distiller: new HeuristicDistiller(), judge: await judge(), live: true, debounceMs: 0 });
    const replayed = new Date(Date.now() - 60_000).toISOString();
    const { lines } = await quiet(async () => {
      await handler(captured(fixture.id, 8, true, replayed)); // the server's ring buffer, re-sent on (re)connect
      await handler(captured(fixture.id, 4, false, replayed));
      await handler.settle();
    });
    assert.deepEqual(calls.getSession, [], "nothing fetched, nothing distilled");
    assert.equal(calls.posts.length, 0);
    assert.equal(lines.filter((l) => l.includes(`session ${fixture.id}: captured ${replayed}, before this worker started; replayed, skipping`)).length, 2, lines.join("\n"));

    // Inside the 5 s grace (a session that ended just as the worker came up) still goes through.
    await quiet(async () => {
      await handler(captured(fixture.id, 8, true, new Date(Date.now() - 2_000).toISOString()));
      await handler.settle();
    });
    assert.deepEqual(calls.getSession, [fixture.id]);
    assert.equal(calls.posts.length, 1);
  });

  test("a session that has not ended is ignored unless live mode is on", async () => {
    const { client, calls } = fakeClient({ [fixture.id]: fixture });
    const handler = createHandler({ client, distiller: new HeuristicDistiller(), judge: await judge(), live: false });
    await quiet(async () => {
      await handler(captured(fixture.id, 3, false));
      await handler({ type: "fact.saved", at: "x", fact: fakeFact("fct_aaaa0009", "x"), decision: { tier: "hot", folder: "projects", action: "add", keep_p: 0.9, folder_p: 0.9, judge: "fake" } });
      await handler.settle();
    });
    assert.deepEqual(calls.getSession, []);
    assert.equal(calls.posts.length, 0);
  });

  test("live mode debounces a burst of captures into one distill, and a final capture flushes immediately", async () => {
    // The archive holds what the client sent last: four messages during the burst, all eight at the end.
    const sessions: Record<string, CapturedSession> = { [fixture.id]: { ...fixture, messages: fixture.messages.slice(0, 4) } };
    const { client, calls } = fakeClient(sessions);
    const handler = createHandler({ client, distiller: new HeuristicDistiller(), judge: await judge(), live: true, debounceMs: 5 });
    await quiet(async () => {
      await handler(captured(fixture.id, 2, false));
      await handler(captured(fixture.id, 3, false));
      await handler(captured(fixture.id, 4, false));
      await handler.settle();
    });
    assert.deepEqual(calls.getSession, [fixture.id], "three quick captures → one fetch");
    assert.equal(calls.posts.length, 1);

    sessions[fixture.id] = fixture;
    await quiet(async () => {
      await handler(captured(fixture.id, 6, false)); // pending debounce…
      await handler(captured(fixture.id, 8, true)); // …cancelled by the final capture
      await handler.settle();
    });
    assert.deepEqual(calls.getSession, [fixture.id, fixture.id]);
    assert.equal(calls.posts.length, 2);
  });

  test("a bad session is logged and skipped; the next one still goes through; a retry is allowed", async () => {
    const { client, calls } = fakeClient({ [fixture.id]: fixture });
    const handler = createHandler({ client, distiller: new HeuristicDistiller(), judge: await judge(), live: false });
    const { lines } = await quiet(async () => {
      await handler(captured("ses_deadbeef", 5, true)); // 404 from the fake client
      await handler(captured(fixture.id, 8, true));
      await handler.settle();
    });
    assert.deepEqual(calls.getSession, ["ses_deadbeef", fixture.id]);
    assert.equal(calls.posts.length, 1);
    assert.ok(lines.some((l) => l.includes("session ses_deadbeef: failed, skipping: GET /api/sessions/ses_deadbeef -> HTTP 404")), lines.join("\n"));

    // The failed key was released, so a re-post of that session is tried again.
    await quiet(() => handler(captured("ses_deadbeef", 5, true)));
    assert.equal(calls.getSession.filter((id) => id === "ses_deadbeef").length, 2);
  });

  test("an engine that throws (Droid before Q1) does not take the loop down and posts nothing", async () => {
    const { client, calls } = fakeClient({ [fixture.id]: fixture });
    const handler = createHandler({ client, distiller: new DroidDistiller({ apiKey: "test-factory" }), judge: await judge(), live: false });
    const { lines } = await quiet(() => handler(captured(fixture.id, 8, true)));
    assert.equal(calls.posts.length, 0);
    assert.ok(lines.some((l) => l.includes("Droid SDK wiring pending: blocker Q1")), lines.join("\n"));
  });

  test("a session with nothing durable posts nothing", async () => {
    const empty: CapturedSession = { ...fixture, id: "ses_0000c0de", messages: [{ role: "user", content: "hello there" }] };
    const { client, calls } = fakeClient({ [empty.id]: empty });
    const handler = createHandler({ client, distiller: new HeuristicDistiller(), judge: await judge(), live: false });
    const { lines } = await quiet(() => handler(captured(empty.id, 1, true)));
    assert.equal(calls.listFacts, 0);
    assert.equal(calls.posts.length, 0);
    assert.ok(lines.some((l) => l.includes("nothing to save")));
  });
});
