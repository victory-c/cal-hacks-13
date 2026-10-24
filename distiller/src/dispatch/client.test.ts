import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ROUTES } from "@canon/shared";
import type { PublishEventBody } from "@canon/shared";
import { quiet, readBody, serve } from "../test-helpers.ts";
import { DispatchApiError, createDispatchClient } from "./client.ts";

describe("dispatch client", () => {
  test("talks the v2 routes with the dispatcher's bearer token", async () => {
    const seen: Array<{ method: string; url: string; auth?: string; body: string }> = [];
    const srv = await serve(async (req, res) => {
      const body = await readBody(req);
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === ROUTES.entitlements) return res.end(JSON.stringify({ entitlements: [{ principal: "dan", deal: "deal_falcon" }] }));
      if (req.url === ROUTES.deals) return res.end(JSON.stringify({ deals: [{ id: "deal_falcon" }] }));
      if (req.url === ROUTES.handoff) return res.end(JSON.stringify({ refused: true, message: "no", audit_id: "aud_1" }));
      if (req.url === ROUTES.exitCheck) return res.end(JSON.stringify({ blocked: false, hits: [] }));
      res.end("");
    });
    try {
      const c = createDispatchClient({ baseUrl: `${srv.url}/`, token: "dev-dispatcher" });
      assert.deepEqual(await c.getEntitlements(), [{ principal: "dan", deal: "deal_falcon" }]);
      assert.deepEqual(await c.getDeals(), [{ id: "deal_falcon" }]);
      assert.deepEqual(await c.handoff({ principal: "agt_deal_1", task: "t", run_id: "run_1" }), { refused: true, message: "no", audit_id: "aud_1" });
      assert.deepEqual(await c.exitCheck({ principal: "agt_deal_1", text: "x" }), { blocked: false, hits: [] });
      const event: PublishEventBody["event"] = { type: "agent.step", at: "2026-10-24T12:00:00Z", step: { run_id: "run_1", n: 1, kind: "brief", text: "b", at: "2026-10-24T12:00:00Z" } };
      await c.publishEvent(event);
      await c.registerPrincipal({ id: "agt_deal_1", kind: "agent", name: "Deal analyst 1", desk: "deal", acts_for: "dan", side: "deal_falcon" });

      assert.ok(seen.every((s) => s.auth === "Bearer dev-dispatcher"));
      assert.deepEqual(
        seen.map((s) => `${s.method} ${s.url}`),
        [`GET ${ROUTES.entitlements}`, `GET ${ROUTES.deals}`, `POST ${ROUTES.handoff}`, `POST ${ROUTES.exitCheck}`, `POST ${ROUTES.publish}`, `POST ${ROUTES.principals}`],
      );
      assert.deepEqual(JSON.parse(seen[4].body), { event });
    } finally {
      await srv.close();
    }
  });

  test("against a v1 server every v2 route 404s: safe defaults, one warning per route, no crash", async () => {
    const srv = await serve((req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no route for ${req.method} ${req.url}` }));
    });
    try {
      const c = createDispatchClient({ baseUrl: srv.url, token: "dev-dispatcher" });
      const { lines } = await quiet(async () => {
        for (let i = 0; i < 2; i++) {
          assert.deepEqual(await c.getEntitlements(), []);
          assert.deepEqual(await c.getDeals(), []);
          assert.equal(await c.handoff({ principal: "agt_research_1", task: "t" }), null);
          assert.equal(await c.exitCheck({ principal: "agt_research_1", text: "x" }), null);
          await c.publishEvent({ type: "agent.inbox", at: "2026-10-24T12:00:00Z", item: { id: "inb_1", run_id: "run_1", kind: "new_fact", urgent: false, text: "t", at: "2026-10-24T12:00:00Z" } });
          await c.registerPrincipal({ id: "agt_research_1", kind: "agent", name: "R", desk: "research", acts_for: "dan", side: "public" });
        }
      });
      assert.equal(lines.length, 6, `one line per route, not per call:\n${lines.join("\n")}`);
      assert.ok(lines.every((l) => /HTTP 404, the server has no such route yet \(v1 server\?\)/.test(l)));
    } finally {
      await srv.close();
    }
  });

  test("an unknown token (401) says how to fix it without printing the token; a 500 throws", async () => {
    const srv = await serve((req, res) => {
      const status = req.url === ROUTES.deals ? 401 : 500;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "nope" }));
    });
    try {
      const token = "tok-secret-7f3a9c";
      const c = createDispatchClient({ baseUrl: srv.url, token });
      const { lines } = await quiet(() => c.getDeals());
      assert.match(lines[0], /CANON_CLIENT_TOKENS needs a dispatcher=<token> pair matching CANON_TOKEN_DISPATCHER/);
      assert.ok(!lines.some((l) => l.includes(token)), "the token's value never reaches the log");
      await assert.rejects(c.getEntitlements(), (err: unknown) => err instanceof DispatchApiError && err.status === 500);
    } finally {
      await srv.close();
    }
  });
});
