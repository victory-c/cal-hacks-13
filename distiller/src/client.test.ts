import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CanonApiError, createClient } from "./client.ts";
import { fakeFact, loadFixture, readBody, serve } from "./test-helpers.ts";

describe("createClient", () => {
  test("sends bearer auth and hits the contract routes; parses each response", async () => {
    const fixture = loadFixture();
    const seen: Array<{ method: string; url: string; auth?: string; body?: string }> = [];
    const { url, close } = await serve(async (req, res) => {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.startsWith("/api/sessions/")) res.end(JSON.stringify(fixture));
      else if (req.method === "GET") res.end(JSON.stringify({ facts: [fakeFact("fct_aaaa0001", "x")] }));
      else res.end(JSON.stringify({ saved: ["fct_aaaa0002"], retired: [] }));
    });
    try {
      const client = createClient({ baseUrl: `${url}/`, token: "dev-distiller" });
      const session = await client.getSession(fixture.id);
      assert.equal(session.id, fixture.id);
      const hot = await client.listFacts({ tier: "hot" });
      assert.equal(hot.length, 1);
      const all = await client.listFacts();
      assert.equal(all.length, 1);
      const fact = fakeFact("fct_aaaa0002", "posted");
      const posted = await client.postFacts({ facts: [{ fact, decision: { tier: "hot", folder: "projects", action: "add", keep_p: 0.9, folder_p: 0.9, judge: "fake" } }] });
      assert.deepEqual(posted, { saved: ["fct_aaaa0002"], retired: [] });

      assert.deepEqual(
        seen.map((s) => [s.method, s.url]),
        [
          ["GET", `/api/sessions/${fixture.id}`],
          ["GET", "/api/facts?tier=hot"],
          ["GET", "/api/facts"],
          ["POST", "/api/facts"],
        ],
      );
      assert.ok(seen.every((s) => s.auth === "Bearer dev-distiller"));
      assert.equal(JSON.parse(seen[3].body ?? "{}").facts[0].fact.id, "fct_aaaa0002");
    } finally {
      await close();
    }
  });

  test("HTTP errors carry method, status and body; a dead server says so", async () => {
    const { url, close } = await serve((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "distiller may not read private/" }));
    });
    try {
      const client = createClient({ baseUrl: url, token: "nope" });
      await assert.rejects(client.listFacts({ folder: "private" }), (err: unknown) => {
        assert.ok(err instanceof CanonApiError);
        assert.equal(err.status, 403);
        assert.match(err.message, /GET .*\/api\/facts\?folder=private -> HTTP 403: .*private/);
        return true;
      });
    } finally {
      await close();
    }
    const dead = createClient({ baseUrl: url, token: "nope" }); // port is closed now
    await assert.rejects(dead.getSession("ses_00000001"), /GET .* failed: .*Is the server running/);
  });
});
