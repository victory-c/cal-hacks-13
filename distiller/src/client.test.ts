import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PostReviewBody, TriageDecision } from "@canon/shared";
import { CanonApiError, createClient, isMissingRoute } from "./client.ts";
import type { RelayedEvent } from "./client.ts";
import { fakeFact, loadFixture, quiet, readBody, serve } from "./test-helpers.ts";
import { loadContext, onceWarner } from "./worker.ts";

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

describe("createClient v2 routes", () => {
  const decision: TriageDecision = {
    outcome: "fact",
    keep_p: 0.9,
    confidential_p: 0.9,
    deal: "deal_falcon",
    deal_p: 0.9,
    injection_p: 0.02,
    relation: "unrelated",
    wall: "deal_falcon",
    wall_reason: "jev: deal_falcon 0.90, confidential 0.90",
    judge: "fake",
  };

  test("deals, lists, review and event relay hit the contract routes with bearer auth", async () => {
    const seen: Array<{ method: string; url: string; auth?: string; body?: string }> = [];
    let reviewReply = JSON.stringify({ id: "rev_00a1", kind: "label_unsure", state: "open" });
    const { url, close } = await serve(async (req, res) => {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/deals") res.end(JSON.stringify({ deals: [{ id: "deal_falcon", code_name: "Project Falcon", aliases: [], companies: [], status: "confidential", status_changed_at: "x" }] }));
      else if (req.url === "/api/lists") res.end(JSON.stringify({ restricted: [{ company: "Nimbus Logistics", added_at: "x" }], watch: [{ company: "Corvid Freight", added_at: "x" }] }));
      else if (req.url === "/api/review") res.end(reviewReply);
      else res.end(""); // /api/events: an empty 200 is fine
    });
    try {
      const client = createClient({ baseUrl: url, token: "dev-distiller" });
      const deals = await client.getDeals();
      assert.deepEqual(deals.map((d) => d.id), ["deal_falcon"]);
      const lists = await client.getLists();
      assert.deepEqual(lists.restricted.map((e) => e.company), ["Nimbus Logistics"]);
      assert.deepEqual(lists.watch?.map((e) => e.company), ["Corvid Freight"]);

      const item: PostReviewBody = { kind: "label_unsure", summary: "Unsure label", session_id: "ses_0000f001", fact_id: "fct_aaaa0001", proposed_wall: "deal_falcon", p: 0.4 };
      assert.equal(await client.postReview(item), "rev_00a1");
      reviewReply = JSON.stringify({ item: { id: "rev_00a2" } });
      assert.equal(await client.postReview(item), "rev_00a2");
      reviewReply = "";
      assert.equal(await client.postReview(item), undefined, "an empty reply is accepted, with no id");

      const event: RelayedEvent = { type: "triage.decided", at: "2026-10-24T05:00:00.000Z", session_id: "ses_0000f001", statement: "s", decision, fact_id: "fct_aaaa0001" };
      await client.publishEvent(event);

      assert.deepEqual(
        seen.map((s) => [s.method, s.url]),
        [
          ["GET", "/api/deals"],
          ["GET", "/api/lists"],
          ["POST", "/api/review"],
          ["POST", "/api/review"],
          ["POST", "/api/review"],
          ["POST", "/api/events"],
        ],
      );
      assert.ok(seen.every((s) => s.auth === "Bearer dev-distiller"));
      assert.deepEqual(JSON.parse(seen[2].body ?? "{}"), item);
      assert.deepEqual(JSON.parse(seen[5].body ?? "{}"), { event }, "PublishEventBody wraps the event");
    } finally {
      await close();
    }
  });

  test("deals as a bare Deal[] are accepted; missing aliases / companies / status are filled in, empty list entries dropped", async () => {
    const { url, close } = await serve((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/deals") res.end(JSON.stringify([{ id: "deal_falcon", code_name: "Project Falcon" }]));
      else res.end(JSON.stringify({ restricted: [{ company: "Nimbus Logistics", ticker: "NMBL", added_at: "x" }, { ticker: "ACMF", added_at: "x" }, { added_at: "x" }, "junk"], watch: null }));
    });
    try {
      const client = createClient({ baseUrl: url, token: "dev-distiller" });
      assert.deepEqual(await client.getDeals(), [{ id: "deal_falcon", code_name: "Project Falcon", aliases: [], companies: [], status: "confidential", status_changed_at: "" }]);
      assert.deepEqual(await client.getLists(), {
        restricted: [
          { company: "Nimbus Logistics", ticker: "NMBL", added_at: "x" },
          { company: "ACMF", ticker: "ACMF", added_at: "x" },
        ],
      });
      const ctx = await quiet(() => loadContext(client, onceWarner()));
      assert.equal(ctx.result.labelPublic, true);
    } finally {
      await close();
    }
  });

  test("a deals or lists body the client cannot use throws, so the worker labels nothing public (fail closed)", async () => {
    let deals: unknown = { deals: [] };
    let lists: unknown = { restricted: [] };
    const { url, close } = await serve((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/deals") res.end(JSON.stringify(deals));
      else if (req.url === "/api/lists") res.end(JSON.stringify(lists));
      else res.end(JSON.stringify({ facts: [] }));
    });
    try {
      const client = createClient({ baseUrl: url, token: "dev-distiller" });
      const labelPublic = async () => (await quiet(() => loadContext(client, onceWarner()))).result.labelPublic;
      assert.equal(await labelPublic(), true, "well-formed and empty is fine: the server has no deals");

      const badDeals: unknown[] = [
        { items: [] }, // neither { deals } nor Deal[]
        { deals: "deal_falcon" },
        { deals: [{ id: "Falcon", code_name: "Project Falcon" }] }, // not a wall id: refused, not dropped
        { deals: [{ id: "deal_falcon" }] }, // no code name
        null,
      ];
      for (const body of badDeals) {
        deals = body;
        await assert.rejects(client.getDeals(), /GET \/api\/deals/);
        assert.equal(await labelPublic(), false, JSON.stringify(body));
      }
      deals = { deals: [] };

      for (const body of [{ restricted: "Nimbus" }, { watch: [] }, [], { restricted: [], watch: "x" }]) {
        lists = body;
        await assert.rejects(client.getLists(), /GET \/api\/lists/);
        assert.equal(await labelPublic(), false, JSON.stringify(body));
      }
    } finally {
      await close();
    }
  });

  test("only RELAYED_EVENTS are published; nothing else leaves the process", async () => {
    let requests = 0;
    const { url, close } = await serve((_req, res) => {
      requests++;
      res.writeHead(200).end("");
    });
    try {
      const client = createClient({ baseUrl: url, token: "dev-distiller" });
      const notRelayed = { type: "fact.saved", at: "x" } as unknown as RelayedEvent;
      await assert.rejects(client.publishEvent(notRelayed), /"fact\.saved" is not a relayed event/);
      assert.equal(requests, 0);
    } finally {
      await close();
    }
  });

  test("a v1 server's 404 is a CanonApiError that isMissingRoute recognises", async () => {
    const { url, close } = await serve((req, res) => {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: `no route for ${req.method} ${req.url}` }));
    });
    try {
      const client = createClient({ baseUrl: url, token: "dev-distiller" });
      for (const call of [() => client.getDeals(), () => client.getLists(), () => client.postReview({ kind: "quarantine", summary: "x" })]) {
        await assert.rejects(call(), (err: unknown) => {
          assert.ok(err instanceof CanonApiError);
          assert.equal(err.status, 404);
          assert.ok(isMissingRoute(err));
          return true;
        });
      }
      assert.equal(isMissingRoute(new Error("boom")), false);
      assert.equal(isMissingRoute(new CanonApiError("GET", "u", 500, "")), false);
    } finally {
      await close();
    }
  });
});
