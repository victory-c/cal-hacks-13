import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ClaudeJudge, FakeJudge, JevJudge, createJudge, timed } from "./index.ts";
import { withEnv } from "../test-helpers.ts";

// Every case clears the four variables first so the developer's own shell cannot leak in.
const clean = { JUDGE_PROVIDER: undefined, JEV_API_KEY: undefined, JEV_API_URL: undefined, ANTHROPIC_API_KEY: undefined };

describe("createJudge provider selection (no network: only constructors run)", () => {
  test("no keys → fake", async () => {
    await withEnv(clean, () => {
      const j = createJudge();
      assert.equal(j.name, "fake");
      assert.ok(j instanceof FakeJudge);
    });
  });

  test("JEV_API_KEY set → jev, even when ANTHROPIC_API_KEY is also set", async () => {
    await withEnv({ ...clean, JEV_API_KEY: "jev-test", JEV_API_URL: "http://127.0.0.1:9/jev", ANTHROPIC_API_KEY: "ant-test" }, () => {
      const j = createJudge();
      assert.equal(j.name, "jev");
      assert.ok(j instanceof JevJudge);
    });
  });

  test("only ANTHROPIC_API_KEY set → claude", async () => {
    await withEnv({ ...clean, ANTHROPIC_API_KEY: "ant-test" }, () => {
      const j = createJudge();
      assert.equal(j.name, "claude");
      assert.ok(j instanceof ClaudeJudge);
    });
  });

  test("JUDGE_PROVIDER overrides key detection; opts.provider overrides JUDGE_PROVIDER", async () => {
    await withEnv({ ...clean, JUDGE_PROVIDER: "fake", JEV_API_KEY: "jev-test", JEV_API_URL: "http://127.0.0.1:9/jev", ANTHROPIC_API_KEY: "ant-test" }, () => {
      assert.equal(createJudge().name, "fake");
      assert.equal(createJudge({ provider: "claude" }).name, "claude");
    });
  });

  test("an unknown JUDGE_PROVIDER fails with a clear message", async () => {
    await withEnv({ ...clean, JUDGE_PROVIDER: "gpt" }, () => {
      assert.throws(() => createJudge(), /JUDGE_PROVIDER must be one of jev\|claude\|fake \(got "gpt"\)/);
    });
  });

  test("a provider without its key fails at construction, naming the variable", async () => {
    await withEnv({ ...clean, JUDGE_PROVIDER: "jev" }, () => assert.throws(() => createJudge(), /JEV_API_KEY is not set/));
    await withEnv({ ...clean, JUDGE_PROVIDER: "jev", JEV_API_KEY: "k" }, () => assert.throws(() => createJudge(), /JEV_API_URL is not set/));
    await withEnv({ ...clean, JUDGE_PROVIDER: "claude" }, () => assert.throws(() => createJudge(), /ANTHROPIC_API_KEY is not set/));
  });
});

test("timed returns the result and a non-negative integer ms", async () => {
  const { result, ms } = await timed(async () => {
    await new Promise((r) => setTimeout(r, 5));
    return "ok";
  });
  assert.equal(result, "ok");
  assert.ok(Number.isInteger(ms) && ms >= 0, String(ms));
});
