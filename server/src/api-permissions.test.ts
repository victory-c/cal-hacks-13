import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { DEMO_GRANTS, FakeJudge } from "@canon/shared";
import type { CapturedSession, Fact, SaveDecision } from "@canon/shared";

import { getSession, postFacts, postSession } from "./api.ts";
import type { ApiDeps } from "./api.ts";
import { EventBus } from "./events.ts";
import { HttpError } from "./http.ts";
import { KeywordRetriever } from "./retrieval/keyword.ts";
import { FileStore } from "./store.ts";

const privateFact: Fact = {
  id: "fct_a110",
  statement: "Synthetic private test fact",
  folder: "private/testing",
  tier: "hot",
  jev_keep: 0.9,
  source: { client: "distiller", session: "ses_a110" },
  updated: "2026-10-24",
};
const projectFact: Fact = { ...privateFact, id: "fct_a111", statement: "Synthetic project test fact", folder: "projects/testing" };

function entry(fact: Fact, action: SaveDecision["action"] = "add", supersedes?: string): { fact: Fact; decision: SaveDecision } {
  return {
    // merge/supersede must name the retired fact on both the fact and the decision.
    fact: supersedes ? { ...fact, supersedes } : fact,
    decision: {
      action, tier: fact.tier, folder: fact.folder, keep_p: 0.9, folder_p: 0.9, judge: "fake",
      ...(supersedes ? { supersedes } : {}),
    },
  };
}

async function setup(t: TestContext): Promise<ApiDeps> {
  const dir = await mkdtemp(join(tmpdir(), "canon-api-permissions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  await store.putFact(privateFact);
  return { store, bus: new EventBus(), grants: DEMO_GRANTS, judge: new FakeJudge(), retriever: new KeywordRetriever(), startedAt: Date.now() };
}

for (const action of ["supersede", "merge"] as const) {
  test(`POST facts denies ${action} of a fact outside the client's write grant before writing any batch entry`, async (t) => {
    const deps = await setup(t);
    const before = deps.store.listFacts();
    const allowedFirst = { ...projectFact, id: "fct_a112" };

    await assert.rejects(
      postFacts(deps, "claude-code", { facts: [entry(allowedFirst), entry(projectFact, action, privateFact.id)] }),
      (error: unknown) => error instanceof HttpError && error.status === 403 && !error.message.includes(privateFact.folder),
    );

    assert.deepEqual(deps.store.listFacts(), before);
    assert.deepEqual(deps.bus.replay().map((e) => e.type), ["access.denied"]);
    const reloaded = new FileStore(deps.store.dir);
    await reloaded.loadAll();
    assert.deepEqual(reloaded.listFacts(), before);
  });
}

test("POST facts denies moving an existing restricted ID into a writable folder before writing any batch entry", async (t) => {
  const deps = await setup(t);
  const before = deps.store.listFacts();
  const overwrite = { ...projectFact, id: privateFact.id };

  await assert.rejects(
    postFacts(deps, "claude-code", { facts: [entry(projectFact), entry(overwrite)] }),
    (error: unknown) => error instanceof HttpError && error.status === 403 && !error.message.includes(privateFact.folder),
  );

  assert.deepEqual(deps.store.listFacts(), before);
  assert.deepEqual(deps.bus.replay().map((e) => e.type), ["access.denied"]);
  const reloaded = new FileStore(deps.store.dir);
  await reloaded.loadAll();
  assert.deepEqual(reloaded.listFacts(), before);
});

test("POST facts permits updates and retirement entirely within the client's write grant", async (t) => {
  const deps = await setup(t);
  await deps.store.putFact(projectFact);
  const updated = { ...projectFact, statement: "Updated synthetic project fact", folder: "projects/other" as const };
  await postFacts(deps, "claude-code", { facts: [entry(updated)] });
  assert.deepEqual(deps.store.getFact(projectFact.id), updated);

  const replacement = { ...projectFact, id: "fct_a112" };
  const result = await postFacts(deps, "claude-code", { facts: [entry(replacement, "supersede", updated.id)] });
  assert.deepEqual(result, { saved: [replacement.id], retired: [updated.id] });
  assert.equal(deps.store.getFact(updated.id)?.tier, "cold");
  assert.deepEqual(deps.store.getFact(privateFact.id), privateFact);
});

test("POST facts preserves the distiller's ability to retire and move private facts", async (t) => {
  const deps = await setup(t);
  const result = await postFacts(deps, "distiller", { facts: [entry(projectFact, "merge", privateFact.id)] });
  assert.deepEqual(result, { saved: [projectFact.id], retired: [privateFact.id] });
  assert.equal(deps.store.getFact(privateFact.id)?.tier, "cold");

  const moved = { ...privateFact, folder: "career/testing" as const };
  await postFacts(deps, "distiller", { facts: [entry(moved)] });
  assert.deepEqual(deps.store.getFact(privateFact.id), moved);
});

const capturedSession: CapturedSession = {
  id: "ses_a110",
  client: "claude-code",
  started_at: "2026-10-24T12:00:00.000Z",
  title: "Synthetic session ownership test",
  messages: [{ role: "user", content: "Synthetic original transcript" }],
};

for (const client of ["chatgpt", "distiller"]) {
  test(`POST sessions denies ${client} replacing a session captured by another client`, async (t) => {
    const deps = await setup(t);
    await deps.store.putSession(capturedSession);

    await assert.rejects(
      postSession(deps, client, { ...capturedSession, client, messages: [{ role: "user", content: "Synthetic replacement transcript" }] }),
      (error: unknown) => error instanceof HttpError && error.status === 403,
    );

    assert.deepEqual(await deps.store.getSession(capturedSession.id), capturedSession);
    assert.equal(deps.bus.size, 0);
  });
}

test("POST sessions allows its original client to update the transcript", async (t) => {
  const deps = await setup(t);
  const first = await postSession(deps, capturedSession.client, capturedSession);
  assert.deepEqual(first, { id: capturedSession.id, updated: false });
  const updated: CapturedSession = {
    ...capturedSession,
    ended_at: "2026-10-24T12:01:00.000Z",
    messages: [...capturedSession.messages, { role: "assistant", content: "Synthetic answer" }],
  };

  assert.deepEqual(await postSession(deps, capturedSession.client, updated), { id: capturedSession.id, updated: true });
  assert.deepEqual(await deps.store.getSession(capturedSession.id), updated);
  assert.deepEqual(deps.bus.replay().map((e) => e.type), ["session.captured", "session.captured"]);
});

test("POST sessions continues to reject body.client impersonation by the internal distiller", async (t) => {
  const deps = await setup(t);
  await deps.store.putSession(capturedSession);

  await assert.rejects(
    postSession(deps, "distiller", capturedSession),
    (error: unknown) => error instanceof HttpError && error.status === 403,
  );

  assert.deepEqual(await deps.store.getSession(capturedSession.id), capturedSession);
  assert.equal(deps.bus.size, 0);
});

test("POST sessions binds ownership atomically when two clients race to create the same id", async (t) => {
  const deps = await setup(t);
  const attempt = (client: string): CapturedSession => ({
    ...capturedSession,
    client,
    messages: [{ role: "user", content: `Synthetic transcript from ${client}` }],
  });

  const results = await Promise.allSettled([
    postSession(deps, "claude-code", attempt("claude-code")),
    postSession(deps, "chatgpt", attempt("chatgpt")),
  ]);

  assert.equal(results[0].status, "fulfilled");
  assert.deepEqual(results[0].status === "fulfilled" && results[0].value, { id: capturedSession.id, updated: false });
  assert.ok(results[1].status === "rejected" && results[1].reason instanceof HttpError && results[1].reason.status === 403);
  assert.deepEqual(await getSession(deps, capturedSession.id), attempt("claude-code"));
  assert.deepEqual(deps.bus.replay().map((e) => e.type), ["session.captured"]);
  await assert.rejects(
    postSession(deps, "chatgpt", attempt("chatgpt")),
    (error: unknown) => error instanceof HttpError && error.status === 403,
  );
  const reloaded = new FileStore(deps.store.dir);
  await reloaded.loadAll();
  assert.equal(reloaded.sessionClient(capturedSession.id), "claude-code");
});
