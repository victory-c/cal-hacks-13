import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ClaudeDistiller, DroidDistiller, HeuristicDistiller, createDistiller, resolveEngine } from "./index.ts";
import { quiet, withEnv } from "../test-helpers.ts";

const clean = { DISTILLER: undefined, FACTORY_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };

describe("createDistiller", () => {
  test("no keys → heuristic, logged as simulated", async () => {
    await withEnv(clean, async () => {
      const { result, lines } = await quiet(() => createDistiller());
      assert.ok(result instanceof HeuristicDistiller);
      assert.equal(result.name, "heuristic");
      assert.ok(lines.some((l) => l.includes("engine: heuristic (simulated)")), lines.join("\n"));
    });
  });

  test("ANTHROPIC_API_KEY → claude; FACTORY_API_KEY alone never picks droid (v2: it is the dispatcher's key)", async () => {
    await withEnv({ ...clean, ANTHROPIC_API_KEY: "test-anthropic" }, async () => {
      const { result } = await quiet(() => createDistiller());
      assert.ok(result instanceof ClaudeDistiller);
    });
    await withEnv({ ...clean, ANTHROPIC_API_KEY: "test-anthropic", FACTORY_API_KEY: "test-factory" }, async () => {
      const { result } = await quiet(() => createDistiller());
      assert.ok(result instanceof ClaudeDistiller);
    });
    await withEnv({ ...clean, FACTORY_API_KEY: "test-factory" }, async () => {
      assert.equal(resolveEngine(), "heuristic");
    });
  });

  test("DISTILLER overrides key detection; an explicit option overrides DISTILLER", async () => {
    await withEnv({ ...clean, DISTILLER: "heuristic", FACTORY_API_KEY: "test-factory" }, async () => {
      assert.equal(resolveEngine(), "heuristic");
      const { result } = await quiet(() => createDistiller({ engine: "droid" }));
      assert.ok(result instanceof DroidDistiller);
    });
  });

  test("a bad DISTILLER value and a missing key for an explicit engine both fail with the variable name", async () => {
    await withEnv({ ...clean, DISTILLER: "gpt" }, () => {
      assert.throws(() => createDistiller(), /DISTILLER must be one of droid\|claude\|heuristic \(got "gpt"\)/);
    });
    await withEnv(clean, async () => {
      assert.throws(() => new DroidDistiller(), /FACTORY_API_KEY is not set/);
      assert.throws(() => new ClaudeDistiller(), /ANTHROPIC_API_KEY is not set/);
    });
  });

});
