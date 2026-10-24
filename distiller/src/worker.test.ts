import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FakeJudge } from "@canon/shared";
import type { CanonEvent, CapturedSession, Fact, PostFactsBody } from "@canon/shared";
import type { CanonClient } from "./client.ts";
import { DroidDistiller, HeuristicDistiller } from "./engines/index.ts";
import { fakeFact, loadFixture, quiet } from "./test-helpers.ts";
import { createHandler, sessionRevision } from "./worker.ts";

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
