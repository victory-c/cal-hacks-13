import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { JEV_URL, JevJudge } from "./jev.ts";
import { captureWarnings, readBody, serve, withEnv } from "../test-helpers.ts";
import type { Question } from "../types/judge.ts";

const questions: Question[] = [
  { id: "keep:0", type: "noul", text: "Worth keeping hot?" },
  { id: "group:0", type: "choice", text: "Which group?", options: ["unsure", "deal/falcon", "market/public"] },
  { id: "quality", type: "score", text: "Specificity", min: 0, max: 10 },
  { id: "enough", type: "noul", text: "Enough to answer?" },
];

describe("JevJudge", () => {
  test("posts TypeSafe's /v1/systemone shape and maps its answers back to our ids", async () => {
    let seen: { auth: string | undefined; body: Record<string, unknown> } | undefined;
    const { url, close } = await serve(async (req, res) => {
      seen = { auth: req.headers.authorization, body: JSON.parse(await readBody(req)) };
      res.writeHead(200, { "content-type": "application/json" });
      // The response shape from docs.typesafe.ai/api/system-one.md; q3 is left out on purpose.
      res.end(
        JSON.stringify({
          model: "jev-1.13",
          answers: {
            q0: { type: "noul", noul: 0.93 },
            q1: { type: "choice", choice: "deal/falcon", confidence: 0.7, probabilities: { unsure: 0.1, "deal/falcon": 0.7, "market/public": 0.2 } },
            q2: { type: "score", score: 9.5, confidence: 0.6, legend: {}, probabilities: {} },
          },
          usage: { input_tokens: 140, output_tokens: 15 },
        }),
      );
    });
    try {
      const judge = new JevJudge({ apiKey: "jev-test-key", url: `${url}/v1/systemone` });
      assert.equal(judge.name, "jev");
      const { result: answers, warnings } = await captureWarnings(() => judge.ask("some state", questions));

      assert.equal(seen?.auth, "Bearer jev-test-key");
      assert.deepEqual(seen?.body, {
        model: "jev-latest",
        state: "some state",
        questions: {
          q0: { type: "noul", instructions: "Worth keeping hot?" },
          q1: { type: "choice", instructions: "Which group?", criteria: { unsure: null, "deal/falcon": null, "market/public": null } },
          q2: { type: "score", instructions: "Specificity", criteria: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].map((_, i) => String((10 * i) / 9)) },
          q3: { type: "noul", instructions: "Enough to answer?" },
        },
      });
      assert.deepEqual(answers, [
        { id: "keep:0", type: "noul", p: 0.93 },
        { id: "group:0", type: "choice", choice: "deal/falcon", p: 0.7, distribution: { unsure: 0.1, "deal/falcon": 0.7, "market/public": 0.2 } },
        { id: "quality", type: "score", value: 10 }, // level index 9.5 of 0…9, clamped into [min, max]
        { id: "enough", type: "noul", p: 0.5 }, // missing → neutral default
      ]);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /jev: no usable answer for enough/);
    } finally {
      await close();
    }
  });

  test("a choice outside the options, or past the 255 sent, falls back to the safe first option", async () => {
    const many: Question = { id: "relto:0", type: "choice", text: "Closest fact?", options: ["none", ...Array.from({ length: 300 }, (_, i) => `fct_${String(i).padStart(8, "0")}`)] };
    let sent = 0;
    const { url, close } = await serve(async (req, res) => {
      const body = JSON.parse(await readBody(req)) as { questions: Record<string, { criteria: Record<string, null> }> };
      sent = Object.keys(body.questions.q0.criteria).length;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers: { q0: { type: "choice", choice: "fct_00000299", confidence: 0.9, probabilities: {} } } }));
    });
    try {
      const { result, warnings } = await captureWarnings(() => new JevJudge({ apiKey: "k", url }).ask("s", [many]));
      assert.equal(sent, 255);
      assert.deepEqual(result, [{ id: "relto:0", type: "choice", choice: "none", p: 0.5 }]);
      assert.ok(warnings.some((w) => /only the first 255 options sent for relto:0/.test(w)));
    } finally {
      await close();
    }
  });

  test("retries 429 and 529, then surfaces HTTP errors and bodies without answers clearly", async () => {
    const statuses = [429, 529, 200];
    let hits = 0;
    const { url, close } = await serve((_req, res) => {
      const status = statuses[Math.min(hits++, statuses.length - 1)];
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200 ? JSON.stringify({ answers: { q0: { type: "noul", noul: 0.2 } } }) : '{"detail":"busy"}');
    });
    try {
      const judge = new JevJudge({ apiKey: "k", url, retryWaitsMs: [1, 1] });
      assert.deepEqual(await judge.ask("s", [questions[0]]), [{ id: "keep:0", type: "noul", p: 0.2 }]);
      assert.equal(hits, 3);
    } finally {
      await close();
    }

    let status = 401;
    let body = '{"detail":"bad key"}';
    const errs = await serve((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    try {
      const judge = new JevJudge({ apiKey: "k", url: errs.url, retryWaitsMs: [] });
      await assert.rejects(judge.ask("s", questions), /JevJudge: HTTP 401 from .*bad key/);
      status = 429;
      await assert.rejects(judge.ask("s", questions), /JevJudge: HTTP 429/, "no retries left");
      status = 200;
      body = '{"ok":true}';
      await assert.rejects(judge.ask("s", questions), /no "answers" map/);
      body = "<html>";
      await assert.rejects(judge.ask("s", questions), /non-JSON response/);
    } finally {
      await errs.close();
    }
  });

  test("needs a key; the URL defaults to TypeSafe's endpoint; TYPESAFE_API_KEY works too", async () => {
    await withEnv({ JEV_API_KEY: undefined, TYPESAFE_API_KEY: undefined, JEV_API_URL: undefined }, () => {
      assert.throws(() => new JevJudge(), /JEV_API_KEY is not set/);
      assert.equal(new JevJudge({ apiKey: "k" }).name, "jev");
    });
    await withEnv({ JEV_API_KEY: undefined, TYPESAFE_API_KEY: "from-env", JEV_API_URL: undefined }, () => {
      assert.equal(new JevJudge().name, "jev");
    });
    assert.equal(JEV_URL, "https://api.typesafe.ai/v1/systemone");
  });

  test("asks nothing when there are no questions", async () => {
    const judge = new JevJudge({ apiKey: "k", url: "http://127.0.0.1:9/never-called" });
    assert.deepEqual(await judge.ask("s", []), []);
  });
});
