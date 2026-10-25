import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ClaudeJudge } from "./claude.ts";
import { captureWarnings, readBody, serve, withEnv } from "../test-helpers.ts";
import type { Question } from "../types/judge.ts";

const questions: Question[] = [
  { id: "keep", type: "noul", text: "Worth keeping hot?" },
  { id: "folder", type: "choice", text: "Which folder?", options: ["career/projects", "team"] },
  { id: "quality", type: "score", text: "Specificity", min: 0, max: 10 },
];

/** A Messages API response as the real API shapes it: blocks read by type, not position. */
function messageResponse(answers: unknown[], stop_reason = "tool_use") {
  return {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    stop_reason,
    stop_details: null,
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: "toolu_01", name: "answer", input: { answers } },
    ],
    usage: { input_tokens: 120, output_tokens: 40 },
  };
}

describe("ClaudeJudge", () => {
  test("sends one forced tool call to /v1/messages with the right headers and maps the tool input", async () => {
    let seen: { headers: Record<string, unknown>; body: Record<string, unknown>; path: string } | undefined;
    const { url, close } = await serve(async (req, res) => {
      seen = { headers: req.headers, body: JSON.parse(await readBody(req)), path: req.url ?? "" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(messageResponse([{ id: "keep", p: 0.85 }, { id: "folder", choice: "career/projects", p: 0.6 }])));
    });
    try {
      await withEnv({ ANTHROPIC_BASE_URL: `${url}/` }, async () => {
        const judge = new ClaudeJudge({ apiKey: "test-key" });
        assert.equal(judge.name, "claude");
        const { result: answers, warnings } = await captureWarnings(() => judge.ask("STATE TEXT", questions));

        assert.ok(seen);
        assert.equal(seen.path, "/v1/messages");
        assert.equal(seen.headers["x-api-key"], "test-key");
        assert.equal(seen.headers["anthropic-version"], "2026-10-21");
        assert.equal(seen.headers["content-type"], "application/json");
        assert.equal(seen.body.model, "claude-haiku-5-5");
        assert.equal(seen.body.max_tokens, 1024);
        assert.deepEqual(seen.body.tool_choice, { type: "tool", name: "answer" });
        const tools = seen.body.tools as Array<{ name: string; input_schema: { required: string[] } }>;
        assert.equal(tools.length, 1);
        assert.equal(tools[0].name, "answer");
        assert.deepEqual(tools[0].input_schema.required, ["answers"]);
        assert.ok(String(seen.body.system).includes("calibrated"));
        const messages = seen.body.messages as Array<{ role: string; content: string }>;
        assert.equal(messages.length, 1);
        assert.equal(messages[0].role, "user");
        assert.ok(messages[0].content.includes("STATE TEXT") && messages[0].content.includes('"id": "folder"'));
        assert.equal("temperature" in seen.body, false);

        assert.deepEqual(answers, [
          { id: "keep", type: "noul", p: 0.85 },
          { id: "folder", type: "choice", choice: "career/projects", p: 0.6 },
          { id: "quality", type: "score", value: 5, unavailable: true }, // missing → midpoint
        ]);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /claude: no usable answer for quality/);
      });
    } finally {
      await close();
    }
  });

  test("a refusal, an HTTP error and a response without the tool call each fail with a clear message", async () => {
    let reply: { status: number; body: unknown } = { status: 200, body: { ...messageResponse([], "refusal"), content: [], stop_details: { type: "refusal", category: "general_harms" } } };
    const { url, close } = await serve((_req, res) => {
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
    try {
      await withEnv({ ANTHROPIC_BASE_URL: url }, async () => {
        const judge = new ClaudeJudge({ apiKey: "test-key", model: "claude-haiku-5-5" });
        await assert.rejects(judge.ask("s", questions), /Claude declined to answer \(category: general_harms\)/);

        reply = { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "max_tokens: must be > 0" } } };
        await assert.rejects(judge.ask("s", questions), /ClaudeJudge: HTTP 400: max_tokens: must be > 0/);

        reply = { status: 200, body: { ...messageResponse([]), content: [{ type: "text", text: "I would rather chat." }], stop_reason: "end_turn" } };
        await assert.rejects(judge.ask("s", questions), /no "answer" tool call in the response \(stop_reason: end_turn\)/);
      });
    } finally {
      await close();
    }
  });

  test("needs an API key, from opts or env, and never calls out with zero questions", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
      assert.throws(() => new ClaudeJudge(), /ANTHROPIC_API_KEY is not set/);
    });
    await withEnv({ ANTHROPIC_API_KEY: "from-env", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }, async () => {
      const judge = new ClaudeJudge();
      assert.deepEqual(await judge.ask("s", []), []);
    });
  });
});
