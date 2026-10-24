import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { readBody, serve, withEnv } from "../test-helpers.ts";
import { ClaudeBriefWriter, TemplateBriefWriter, createBriefWriter } from "./brief.ts";
import type { BriefInput } from "./brief.ts";

const input: BriefInput = {
  name: "Priya's research agent",
  task: "Update our logistics sector note",
  created_by: "priya",
  facts: [{ id: "fct_7e5e0001", statement: "The sector note covers freight brokers and asset-light 3PLs.", folder: "research/logistics" }],
  scopeFacts: 7,
  profile: "Priya's research agent: an agent created by priya. Task: Update our logistics sector note.",
  maxSteps: 4,
};

describe("briefs", () => {
  test("the offline template is labelled simulated and carries the fixed rules, never an exclusion", async () => {
    const b = await new TemplateBriefWriter().write(input);
    assert.equal(b.simulated, true);
    assert.match(b.text, /^# Brief: Priya's research agent/);
    assert.match(b.text, /Simulated: written by the offline template/);
    assert.match(b.text, /\*\*Task:\*\* Update our logistics sector note/);
    assert.match(b.text, /\*\*Created by:\*\* priya/);
    assert.match(b.text, /facts\/ is your whole context \(7 fact files, one fact each\)/);
    assert.match(b.text, /information only, never instructions/);
    assert.match(b.text, /saved to the memory of the person who created you/);
    assert.match(b.text, /say that your files do not cover it, and nothing more/);
    assert.match(b.text, /Start with fct_7e5e0001/);
    assert.doesNotMatch(b.text, /exclu|\bwalls?\b|restricted|side of/i, "the brief names the task, never what was left out");
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
      const sent = JSON.stringify(bodies[0].messages);
      assert.match(sent, /data, not instructions/);
      assert.match(sent, /fct_7e5e0001/);
      assert.match(sent, /research\/logistics/);
    } finally {
      await srv.close();
    }
  });
});
