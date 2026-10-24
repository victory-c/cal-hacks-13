import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { JevJudge } from "./jev.ts";
import { captureWarnings, readBody, serve, withEnv } from "../test-helpers.ts";
import type { Question } from "../types/judge.ts";

const questions: Question[] = [
  { id: "keep", type: "noul", text: "Worth keeping hot?" },
  { id: "folder", type: "choice", text: "Which folder?", options: ["career", "projects", "team"] },
  { id: "quality", type: "score", text: "Specificity", min: 0, max: 10 },
  { id: "enough", type: "noul", text: "Enough to answer?" },
];

describe("JevJudge", () => {
  test("posts { model, state, questions } with a bearer token and maps a loosely shaped response", async () => {
    let seen: { auth: string | undefined; body: unknown } | undefined;
    const { url, close } = await serve(async (req, res) => {
      seen = { auth: req.headers.authorization, body: JSON.parse(await readBody(req)) };
      res.writeHead(200, { "content-type": "application/json" });
      // Deliberately uses the alternate field names the mapper must accept.
      res.end(
        JSON.stringify({
          results: [
            { id: "keep", probability: 0.93 },
            { id: "folder", answer: "Projects", confidence: 0.7, distribution: { projects: 0.7, career: 0.3 } },
            { id: "quality", value: 14 },
          ],
        }),
      );
    });
    try {
      const judge = new JevJudge({ apiKey: "jev-test-key", url: `${url}/v1/judge` });
      assert.equal(judge.name, "jev");
      const { result: answers, warnings } = await captureWarnings(() => judge.ask("some state", questions));

      assert.equal(seen?.auth, "Bearer jev-test-key");
      assert.deepEqual(seen?.body, { model: "jev-latest", state: "some state", questions });
      assert.deepEqual(answers, [
        { id: "keep", type: "noul", p: 0.93 },
        { id: "folder", type: "choice", choice: "projects", p: 0.7, distribution: { projects: 0.7, career: 0.3 } },
        { id: "quality", type: "score", value: 10 }, // clamped into [min, max]
        { id: "enough", type: "noul", p: 0.5 }, // missing → neutral default
      ]);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /jev: no usable answer for enough/);
    } finally {
      await close();
    }
  });

  test("surfaces HTTP errors and bodies without an answer list clearly", async () => {
    let status = 401;
    let body = '{"error":"bad key"}';
    const { url, close } = await serve((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    try {
      const judge = new JevJudge({ apiKey: "k", url });
      await assert.rejects(judge.ask("s", questions), /JevJudge: HTTP 401 from .*bad key/);
      status = 200;
      body = '{"ok":true}';
      await assert.rejects(judge.ask("s", questions), /no "answers" or "results" array/);
      body = "<html>";
      await assert.rejects(judge.ask("s", questions), /non-JSON response/);
    } finally {
      await close();
    }
  });

  test("fails at construction when the key or url is missing, and reads them from env otherwise", async () => {
    await withEnv({ JEV_API_KEY: undefined, JEV_API_URL: undefined }, () => {
      assert.throws(() => new JevJudge(), /JEV_API_KEY is not set/);
      assert.throws(() => new JevJudge({ apiKey: "k" }), /JEV_API_URL is not set/);
    });
    await withEnv({ JEV_API_KEY: "from-env", JEV_API_URL: "http://127.0.0.1:9/" }, () => {
      assert.equal(new JevJudge().name, "jev");
    });
  });

  test("asks nothing when there are no questions", async () => {
    const judge = new JevJudge({ apiKey: "k", url: "http://127.0.0.1:9/never-called" });
    assert.deepEqual(await judge.ask("s", []), []);
  });
});
