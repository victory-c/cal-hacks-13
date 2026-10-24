import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FakeJudge } from "@canon/shared";
import type { CanonEvent, CapturedSession, Fact, PostFactsBody } from "@canon/shared";
import type { CanonClient } from "./client.ts";
import { HeuristicDistiller } from "./engines/index.ts";
import { fakeFact, loadFixture, quiet } from "./test-helpers.ts";
import { createHandler } from "./worker.ts";

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
      await handler(captured(fixture.id, 8, true)); // same "<id>:<messages>" key → no-op
      await handler.settle();
    });

    assert.deepEqual(calls.getSession, [fixture.id]);
    assert.equal(calls.listFacts, 1);
    assert.equal(calls.posts.length, 1);
    assert.ok(calls.posts[0].facts.length >= 2);
    assert.ok(calls.posts[0].facts.every((f) => f.decision.judge === "fake"));
    assert.ok(lines.some((l) => /heuristic distilled \d+ drafts in \d+ ms \(simulated\)/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /fake judged \d+ drafts against 1 hot facts in \d+ ms/.test(l)));
    assert.ok(lines.some((l) => /saved \d+, retired \d+ in \d+ ms/.test(l)));
    assert.ok(lines.some((l) => l.includes("already processed at 8 messages")));
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
    const { client, calls } = fakeClient({ [fixture.id]: fixture });
    const handler = createHandler({ client, distiller: new HeuristicDistiller(), judge: await judge(), live: true, debounceMs: 5 });
    await quiet(async () => {
      await handler(captured(fixture.id, 2, false));
      await handler(captured(fixture.id, 3, false));
      await handler(captured(fixture.id, 4, false));
      await handler.settle();
    });
    assert.deepEqual(calls.getSession, [fixture.id], "three quick captures → one fetch");
    assert.equal(calls.posts.length, 1);

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

  test("an engine that throws does not take the loop down and posts nothing", async () => {
    const { client, calls } = fakeClient({ [fixture.id]: fixture });
    const handler = createHandler({ client, distiller: { name: "droid", async distill() { throw new Error("Factory unavailable"); } }, judge: await judge(), live: false });
    const { lines } = await quiet(() => handler(captured(fixture.id, 8, true)));
    assert.equal(calls.posts.length, 0);
    assert.ok(lines.some((l) => l.includes("Factory unavailable")), lines.join("\n"));
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
