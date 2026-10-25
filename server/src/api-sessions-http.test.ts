// Issue #21 over real HTTP on port 0: only a session's capture owner may update it (per-person
// clients by principal, other clients by client and principal), and the ownership check is atomic
// with the write, so concurrent first writes by different owners cannot both win.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { DEMO_GRANTS, FakeJudge } from "@canon/shared";
import type { CanonEvent, CapturedSession } from "@canon/shared";

import { startServer } from "./app.ts";
import type { RunningServer } from "./app.ts";
import { KeywordRetriever } from "./retrieval/keyword.ts";
import { FALCON_TEST_GRANTS, loadWorldFixtures } from "./scopes.ts";
import { FileStore } from "./store.ts";

const tokens = new Map([
  ["tok-cc", "claude-code"],
  ["tok-gpt", "chatgpt"],
  ["tok-maya", "maya"], // moderator: with internal workers, the only caller that may GET a raw session
  ["tok-dan", "dan"], // per-person clients: FALCON_TEST_GRANTS binds each to its principal
  ["tok-priya", "priya"],
]);
const TOKEN_OF: Record<string, string> = { "claude-code": "tok-cc", chatgpt: "tok-gpt", dan: "tok-dan", priya: "tok-priya" };
const PERSON = new Set(["dan", "priya"]);

const synthetic = (id: string, client: string, content: string): CapturedSession => ({
  id,
  client,
  started_at: "2026-10-24T12:00:00.000Z",
  title: "Synthetic ownership test",
  messages: [{ role: "user", content }],
});
/** What the archive holds after `client` captured `session`: a per-person client's principal is filled in. */
const stored = (session: CapturedSession): CapturedSession => (PERSON.has(session.client) ? { ...session, principal: session.client } : session);

describe("POST /api/sessions ownership over HTTP (issue #21)", () => {
  let dir: string;
  let running: RunningServer;
  let events: CanonEvent[];
  const originalInfo = console.info;

  const post = async (session: CapturedSession) => {
    const res = await fetch(`${running.url}/api/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN_OF[session.client]}`, "content-type": "application/json" },
      body: JSON.stringify(session),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const archived = async (id: string) => {
    const res = await fetch(`${running.url}/api/sessions/${id}`, { headers: { authorization: "Bearer tok-maya" } });
    assert.equal(res.status, 200);
    return (await res.json()) as CapturedSession;
  };
  const captured = (id: string) =>
    events.filter((e) => e.type === "session.captured" && e.session.id === id).map((e) => (e.type === "session.captured" ? e.session.client : ""));

  before(async () => {
    console.info = () => {};
    dir = await mkdtemp(join(tmpdir(), "canon-sessions-http-"));
    running = await startServer({ port: 0, dataDir: dir, tokens, grants: [...DEMO_GRANTS, ...FALCON_TEST_GRANTS], judge: new FakeJudge(), retriever: new KeywordRetriever(), world: loadWorldFixtures(), log: () => {} });
    events = [];
    running.bus.subscribe((e) => events.push(e));
  });
  after(async () => {
    await running.close();
    await rm(dir, { recursive: true, force: true });
    console.info = originalInfo;
  });

  for (const [n, owner] of [["1", "claude-code"], ["2", "dan"]] as const) {
    test(`the capture owner (${owner}) may update its own session`, async () => {
      const original = synthetic(`ses_2100000${n}`, owner, "Synthetic original transcript");
      assert.deepEqual(await post(original), { status: 200, body: { id: original.id, updated: false } });
      const update: CapturedSession = { ...original, ended_at: "2026-10-24T12:05:00.000Z", messages: [...original.messages, { role: "assistant", content: "Synthetic answer" }] };
      assert.deepEqual(await post(update), { status: 200, body: { id: original.id, updated: true } });
      assert.deepEqual(await archived(original.id), stored(update));
      assert.deepEqual(captured(original.id), [owner, owner]);
    });
  }

  for (const [n, owner, intruder] of [["3", "claude-code", "chatgpt"], ["4", "dan", "priya"], ["5", "dan", "claude-code"]] as const) {
    test(`${intruder} overwriting ${owner}'s session is 403: archive, owner and event stream unchanged`, async () => {
      const original = synthetic(`ses_2100000${n}`, owner, "Synthetic original transcript");
      assert.equal((await post(original)).status, 200);
      const attack = await post(synthetic(original.id, intruder, "Synthetic replacement transcript"));
      assert.deepEqual(attack, { status: 403, body: { error: "session belongs to another capture owner" } });
      assert.deepEqual(await archived(original.id), stored(original));
      assert.equal(running.store.sessionClient(original.id), owner);
      assert.equal(running.store.sessionPrincipal(original.id), stored(original).principal);
      assert.deepEqual(captured(original.id), [owner], "no session.captured for the rejected write");
    });
  }

  for (const [tag, a, b] of [["c", "claude-code", "chatgpt"], ["d", "dan", "priya"]] as const) {
    test(`concurrent first writes of one id by ${a} and ${b}: exactly one wins and keeps ownership`, async () => {
      for (let i = 0; i < 10; i++) {
        const id = `ses_2100${tag}${i.toString(16).padStart(3, "0")}`;
        const [ra, rb] = await Promise.all([post(synthetic(id, a, `Synthetic transcript from ${a}`)), post(synthetic(id, b, `Synthetic transcript from ${b}`))]);
        assert.deepEqual([ra.status, rb.status].sort(), [200, 403], `trial ${i}: one write wins, the other is 403`);
        const winner = ra.status === 200 ? a : b;
        const expected = stored(synthetic(id, winner, `Synthetic transcript from ${winner}`));
        assert.deepEqual(await archived(id), expected);
        assert.deepEqual(captured(id), [winner], `trial ${i}: one session.captured, from the winner`);
        const reloaded = new FileStore(dir);
        await reloaded.loadAll();
        assert.equal(reloaded.sessionClient(id), winner, `trial ${i}: ownership survives a restart`);
        assert.equal(reloaded.sessionPrincipal(id), expected.principal);
      }
    });
  }
});
