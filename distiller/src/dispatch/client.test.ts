import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ROUTES } from "@canon/shared";
import type { CapturedSession, PublishEventBody, ScopeRule } from "@canon/shared";
import { fakeFact, quiet, readBody, serve } from "../test-helpers.ts";
import { DispatchApiError, createDispatchClient } from "./client.ts";

const rule: ScopeRule = {
  principal: "agt_dan_deal",
  task: "Draft a short Falcon board memo",
  exclude: { groups: [], labels: [] },
  set_by: "dan",
  updated_at: "2026-10-24T12:00:00Z",
};
const session: CapturedSession = {
  id: "ses_0000a001",
  client: "dispatcher",
  started_at: "2026-10-24T12:00:00Z",
  messages: [{ role: "assistant", content: "out/result.md\n\n# Memo" }],
  principal: "dan",
  kind: "ai_session",
};

describe("dispatch client", () => {
  test("talks the scopes routes with the dispatcher's bearer token; principal ids are encoded into the path", async () => {
    const seen: Array<{ method: string; url: string; auth?: string; body: string }> = [];
    const srv = await serve(async (req, res) => {
      const body = await readBody(req);
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === `${ROUTES.scopeRules}/agt_dan_deal`) return res.end(JSON.stringify(rule));
      if (req.url === `${ROUTES.scopes}/agt_dan_deal/facts`) return res.end(JSON.stringify({ facts: [fakeFact("fct_fa1c0001", "Falcon fact", { folder: "deal/falcon" })] }));
      if (req.url === ROUTES.handoff) return res.end(JSON.stringify({ facts: [], profile: "p", tokens: 0, latency_ms: 1, inject_nothing: true, candidates: [], audit_id: "aud_1" }));
      if (req.url === ROUTES.sessions) return res.end(JSON.stringify({ id: "ses_0000a001", updated: false }));
      res.end("");
    });
    try {
      const c = createDispatchClient({ baseUrl: `${srv.url}/`, token: "dev-dispatcher" });
      assert.deepEqual(await c.getScopeRule("agt_dan_deal"), rule);
      assert.deepEqual(
        (await c.getScopeFacts("agt_dan_deal"))?.map((f) => f.id),
        ["fct_fa1c0001"],
      );
      assert.equal((await c.handoff({ principal: "agt_dan_deal", task: "t", run_id: "run_1" }))?.inject_nothing, true);
      const event: PublishEventBody["event"] = { type: "agent.step", at: "2026-10-24T12:00:00Z", step: { run_id: "run_1", n: 1, kind: "brief", text: "b", at: "2026-10-24T12:00:00Z" } };
      await c.publishEvent(event);
      assert.deepEqual(await c.postSession(session), { id: "ses_0000a001", updated: false });
      await c.getScopeFacts("agt_x/../../facts");

      assert.ok(seen.every((s) => s.auth === "Bearer dev-dispatcher"));
      assert.deepEqual(
        seen.map((s) => `${s.method} ${s.url}`),
        [
          `GET ${ROUTES.scopeRules}/agt_dan_deal`,
          `GET ${ROUTES.scopes}/agt_dan_deal/facts`,
          `POST ${ROUTES.handoff}`,
          `POST ${ROUTES.publish}`,
          `POST ${ROUTES.sessions}`,
          `GET ${ROUTES.scopes}/agt_x%2F..%2F..%2Ffacts/facts`,
        ],
      );
      assert.deepEqual(JSON.parse(seen[3].body), { event });
      assert.deepEqual(JSON.parse(seen[4].body), session);
    } finally {
      await srv.close();
    }
  });

  test("against today's server every scope route 404s: safe defaults (no rule, no facts), one warning per route, no crash", async () => {
    const srv = await serve((req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no route for ${req.method} ${req.url}` }));
    });
    try {
      const c = createDispatchClient({ baseUrl: srv.url, token: "dev-dispatcher" });
      const { lines } = await quiet(async () => {
        for (const agent of ["agt_dan_deal", "agt_priya_research"]) {
          assert.equal(await c.getScopeRule(agent), null);
          assert.equal(await c.getScopeFacts(agent), null, "no route means no facts, never a wider read");
          assert.equal(await c.handoff({ principal: agent, task: "t" }), null);
          await c.publishEvent({ type: "agent.inbox", at: "2026-10-24T12:00:00Z", item: { id: "inb_1", run_id: "run_1", kind: "new_fact", urgent: false, text: "t", at: "2026-10-24T12:00:00Z" } });
          assert.equal(await c.postSession(session), null);
        }
      });
      assert.equal(lines.length, 5, `one line per route, not per call or per agent:\n${lines.join("\n")}`);
      assert.ok(lines.every((l) => /HTTP 404, the server has no such route yet/.test(l)));
      assert.ok(!lines.some((l) => l.includes("agt_")), "the log names the route pattern, not the agent");
    } finally {
      await srv.close();
    }
  });

  test("an unknown token (401) says how to fix it without printing the token; a 500 throws", async () => {
    const srv = await serve((req, res) => {
      const status = req.url?.startsWith(ROUTES.scopeRules) ? 401 : 500;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "nope" }));
    });
    try {
      const token = "tok-secret-7f3a9c";
      const c = createDispatchClient({ baseUrl: srv.url, token });
      const { lines } = await quiet(() => c.getScopeRule("agt_dan_deal"));
      assert.match(lines[0], /CANON_CLIENT_TOKENS needs a dispatcher=<token> pair matching CANON_TOKEN_DISPATCHER/);
      assert.ok(!lines.some((l) => l.includes(token)), "the token's value never reaches the log");
      await assert.rejects(c.getScopeFacts("agt_dan_deal"), (err: unknown) => err instanceof DispatchApiError && err.status === 500);
    } finally {
      await srv.close();
    }
  });
});
