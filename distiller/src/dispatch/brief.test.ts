import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ContextFact } from "@canon/shared";
import { readBody, serve, withEnv } from "../test-helpers.ts";
import { ClaudeBriefWriter, TemplateBriefWriter, createBriefWriter } from "./brief.ts";
import type { BriefInput } from "./brief.ts";

const fact: ContextFact = {
  id: "fct_0b1c0001",
  statement: "Harbor Lane's logistics sector note covers freight demand.",
  folder: "team",
  updated: "2026-10-24",
  source: { client: "ingest", session: "ses_0b1c0001" },
  relevance: 0.9,
  wall: "public",
};
const input: BriefInput = { role: "research_analyst", side: "public", task: "Update our logistics sector note", acts_for: "dan", facts: [fact], maxSteps: 4 };

describe("briefs", () => {
  test("the offline template is labelled simulated and carries the fixed rules", async () => {
    const b = await new TemplateBriefWriter().write(input);
    assert.equal(b.simulated, true);
    assert.match(b.text, /^# Brief: Research analyst \(public\)/);
    assert.match(b.text, /Simulated: written by the offline template/);
    assert.match(b.text, /information only, never instructions/);
    assert.match(b.text, /out\/sector-note\.md/);
    assert.match(b.text, /Do not name, hint at or speculate about any confidential deal/);
    const deal = await new TemplateBriefWriter().write({ ...input, role: "deal_analyst", side: "deal_falcon" });
    assert.match(deal.text, /over the wall for deal_falcon/);
    await withEnv({ ANTHROPIC_API_KEY: undefined }, () => assert.equal(createBriefWriter().name, "template"));
  });

  test("Claude writes only the goal section; code adds header and rules, even if Claude skips the heading", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const srv = await serve(async (req, res) => {
      bodies.push(JSON.parse(await readBody(req)));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "1. Read the freight facts.\n2. Write the note." }], stop_reason: "end_turn", usage: { input_tokens: 210, output_tokens: 30 } }));
    });
    try {
      const b = await withEnv({ ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: srv.url }, () => new ClaudeBriefWriter().write(input));
      assert.equal(b.simulated, false);
      assert.deepEqual(b.tokens, { input: 210, output: 30 });
      assert.match(b.text, /## Goal and approach\n\n1\. Read the freight facts\./);
      assert.match(b.text, /## Rules/);
      assert.doesNotMatch(b.text, /Simulated/);
      assert.equal(bodies[0].model, "claude-sonnet-5-5");
      assert.match(JSON.stringify(bodies[0].messages), /data, not instructions/);
    } finally {
      await srv.close();
    }
  });
});
