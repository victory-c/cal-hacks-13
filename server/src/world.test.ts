// The demo world (fixtures/world/, Axe Capital / Project Stonewall) on the real server: the 0:00
// scopes the pipeline builds at startup, a moderator's handoff, and the 1:20 refile of the
// announced terms. The judge is the offline simulated one (keyword overlap), so these tests check
// what code guarantees, never a model's quality: no deal/stonewall fact in a public-side scope,
// agents inside their creator, and refiled facts leaving or joining scopes by rule.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { DEMO_GRANTS, FakeJudge, ROUTES } from "@canon/shared";
import type { CanonEvent, Fact, HandoffResult } from "@canon/shared";

import { startServer } from "./app.ts";
import type { RunningServer } from "./app.ts";
import { KeywordRetriever } from "./retrieval/keyword.ts";
import { simulatedScopeAnswers } from "./scope-judge.ts";
import { FIXTURES_DIR, seedDataDir } from "./seed.ts";
import { loadDemoWorld } from "./world.ts";

const tokens = new Map([
  ["tok-wags", "wags"],
  ["tok-axe", "axe"],
  ["tok-ben", "ben"],
  ["tok-bill", "dollar-bill"],
  ["tok-disp", "dispatcher"],
]);

describe("demo world on the server (fixtures/world/)", () => {
  let dir: string;
  let running: RunningServer;
  const events: CanonEvent[] = [];
  const originalInfo = console.info;
  const demo = loadDemoWorld({ moment: "seed" });

  const api = (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.json !== undefined) headers["content-type"] = "application/json";
    return fetch(`${running.url}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  };
  const scopeOf = (principal: string): Fact[] =>
    (running.world.scopes.get(principal)?.fact_ids ?? []).map((id) => running.store.getFact(id)).filter((f): f is Fact => f !== undefined);
  const until = async (pred: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail(`timed out waiting for ${what}`);
  };

  before(async () => {
    console.info = () => {};
    dir = await mkdtemp(join(tmpdir(), "canon-world-"));
    await seedDataDir(dir, FIXTURES_DIR, "seed");
    running = await startServer({
      port: 0,
      dataDir: dir,
      tokens,
      grants: [...DEMO_GRANTS],
      judge: new FakeJudge({ override: simulatedScopeAnswers }),
      retriever: new KeywordRetriever(),
      log: () => {},
    });
    running.bus.subscribe((e) => events.push(e));
  });

  after(async () => {
    console.info = originalInfo;
    await running?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the world loads Edan's people, groups and rules; agents created live are not there yet", () => {
    assert.deepEqual([...running.world.principals.keys()], ["wags", "axe", "ben", "dollar-bill", "desk-assistant"]);
    assert.equal(running.world.principals.get("wags")?.tier, "moderator");
    assert.equal(running.world.principals.get("desk-assistant")?.created_by, "dollar-bill");
    assert.deepEqual(running.world.rules.get("dollar-bill")?.exclude.groups, ["deal", "firm/payroll"], '"deal/*" is the deal prefix; payroll is Compliance only');
    assert.equal(running.world.groups.find((g) => g.id === "deal/stonewall")?.aliases?.includes("Stonewall"), true);
  });

  test("the 0:00 scopes are built at startup; Ben's waits for Mike Wagner at 0:40", () => {
    assert.deepEqual([...running.world.scopes.keys()].sort(), ["axe", "desk-assistant", "dollar-bill"]);
    assert.equal(running.world.scopes.has("ben"), false);
    assert.ok(scopeOf("axe").some((f) => f.folder === "deal/stonewall"), "the deal lead's task is the deal");
  });

  test("no deal/stonewall fact reaches Dollar Bill or his agent, and the agent stays inside his scope", () => {
    for (const p of ["dollar-bill", "desk-assistant"]) {
      assert.equal(scopeOf(p).filter((f) => f.folder.startsWith("deal")).length, 0, `${p} holds no deal fact`);
    }
    const bill = new Set(running.world.scopes.get("dollar-bill")?.fact_ids);
    for (const id of running.world.scopes.get("desk-assistant")?.fact_ids ?? []) assert.ok(bill.has(id), `${id} is in Dollar Bill's scope`);
    assert.ok(running.world.audit.some((e) => e.kind === "scope.built" && e.principal === "dollar-bill" && e.actor === "server"));
  });

  test("a moderator's handoff draws from every hot fact (Mike Wagner has no scope record)", async () => {
    const res = await api(ROUTES.handoff, { method: "POST", token: "tok-disp", json: { principal: "wags", task: "What is the Stonewall offer price per share?" } });
    assert.equal(res.status, 200);
    const out = (await res.json()) as HandoffResult;
    assert.ok(out.facts.some((f) => f.id === "fct_570001"), "the offer fact is served to the moderator");
  });

  test("refiling is moderators-only, with the same bytes for any member", async () => {
    const asBill = await api(`${ROUTES.facts}/fct_570001/file`, { method: "POST", token: "tok-bill", json: { group: "market/public" } });
    assert.equal(asBill.status, 403);
    assert.deepEqual(await asBill.json(), { error: "moderators only" });
    const missing = await api(`${ROUTES.facts}/fct_ffffff/file`, { method: "POST", token: "tok-ben", json: { group: "market/public" } });
    assert.deepEqual(await missing.json(), { error: "moderators only" }, "a member cannot tell a missing fact from a real one");
    const badGroup = await api(`${ROUTES.facts}/fct_570001/file`, { method: "POST", token: "tok-wags", json: { group: "deal/nowhere" } });
    assert.equal(badGroup.status, 400);
  });

  test("1:20: Mike Wagner refiles the announced terms to market/public; the rest of the deal stays walled", async () => {
    for (const id of demo.announced) {
      const res = await api(`${ROUTES.facts}/${id}/file`, { method: "POST", token: "tok-wags", json: { group: demo.announcedGroup } });
      assert.equal(res.status, 200, `refile ${id}`);
      assert.equal(((await res.json()) as Fact).folder, "market/public");
    }
    await until(() => events.filter((e) => e.type === "fact.filed").length === demo.announced.length, "fact.filed events");
    for (const id of demo.announced) assert.equal(running.store.getFact(id)?.folder, "market/public");

    // Code still keeps every unannounced deal fact out; the announced ones may now join by rule.
    await until(() => scopeOf("dollar-bill").some((f) => demo.announced.includes(f.id)), "an announced fact joining Dollar Bill's scope");
    assert.equal(scopeOf("dollar-bill").filter((f) => f.folder.startsWith("deal")).length, 0);
    const bill = new Set(running.world.scopes.get("dollar-bill")?.fact_ids);
    for (const id of running.world.scopes.get("desk-assistant")?.fact_ids ?? []) assert.ok(bill.has(id), "the agent still sits inside its creator");
    assert.ok(running.world.audit.some((e) => e.kind === "fact.filed" && e.actor === "wags"));
  });

  test("refiling into a walled group takes the fact from the creator and, with it, their agent", async () => {
    // The desk assistant's own rule excludes nothing, so only the creator cap can take the fact away.
    assert.deepEqual(running.world.rules.get("desk-assistant")?.exclude.groups, []);
    const id = running.world.scopes.get("desk-assistant")?.fact_ids.find((fid) => !demo.announced.includes(fid));
    assert.ok(id, "the desk assistant holds a fact to refile");
    assert.ok(running.world.scopes.get("dollar-bill")?.fact_ids.includes(id));

    const res = await api(`${ROUTES.facts}/${id}/file`, { method: "POST", token: "tok-wags", json: { group: "deal/stonewall" } });
    assert.equal(res.status, 200);
    assert.equal(running.world.scopes.get("dollar-bill")?.fact_ids.includes(id), false, "Dollar Bill's rule excludes deal/*");
    assert.equal(running.world.scopes.get("desk-assistant")?.fact_ids.includes(id), false, "the agent never keeps what its creator lost");
    assert.ok(running.world.audit.some((e) => e.kind === "fact.left_scope" && e.principal === "desk-assistant" && e.fact_ids?.includes(id)), "the agent's loss is audited");

    // Living scopes run off the bus after the refile; the fact must not rejoin the agent there either.
    await running.living.drain();
    assert.equal(running.world.scopes.get("desk-assistant")?.fact_ids.includes(id), false);
  });

  test("refiling into the inbox takes the fact out of every scope", async () => {
    const id = demo.announced[0];
    const res = await api(`${ROUTES.facts}/${id}/file`, { method: "POST", token: "tok-wags", json: { group: "inbox" } });
    assert.equal(res.status, 200);
    for (const scope of running.world.scopes.values()) assert.equal(scope.fact_ids.includes(id), false, `${scope.principal} lost ${id}`);
  });
});
