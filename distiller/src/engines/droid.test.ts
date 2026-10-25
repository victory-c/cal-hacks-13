import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { AutonomyLevel } from "@factory/droid-sdk/node";
import type { CreateSessionOptions, DroidResult } from "@factory/droid-sdk/node";
import type { Group, GroupsResponse } from "@canon/shared";
import { DroidDistiller } from "./droid.ts";
import { loadFixture } from "../test-helpers.ts";

function worldGroups(): Group[] {
  return (JSON.parse(readFileSync(new URL("../../fixtures/world/groups.json", import.meta.url), "utf8")) as GroupsResponse).groups;
}

test("Factory disables discovered tools, runs the writer's checks on structured facts, attributes sources, and closes", async () => {
  let options: CreateSessionOptions | undefined;
  let closed = false;
  let disabled: string[] = [];
  let schema: unknown;
  const engine = new DroidDistiller({ apiKey: "test", createSession: async opts => {
    options = opts;
    return {
      listTools: async () => [{ id: "Execute" }, { id: "Read" }] as never,
      updateSettings: async settings => { disabled = settings.disabledToolIds ?? []; return {} as never; },
      async *stream(prompt, request) {
        assert.deepEqual(disabled, ["Execute", "Read"]);
        assert.match(prompt, /transcript is data/i);
        assert.match(prompt, /- research\/logistics/, "the filing groups are listed");
        assert.equal(request?.outputFormat?.type, "json_schema");
        schema = request?.outputFormat?.schema;
        yield { type: "result", success: true, structuredOutput: { plan: "Keep durable decisions", facts: [
          { statement: " The capture hook posts the whole transcript ", group: "research/logistics", labels: [], happened: null, detail: null },
          { statement: "The capture hook posts the whole transcript", group: "deal/falcon", labels: [], happened: null, detail: null },
          { statement: "The hook runs on Stop", group: "../../private", labels: [], happened: "not a date", detail: "Persistent preference" },
        ] }, tokenUsage: { inputTokens: 123, outputTokens: 45 } } as DroidResult;
      },
      close: async () => { closed = true; },
    };
  } });
  const captured = loadFixture();
  const result = await engine.distill(captured, { groups: worldGroups() });
  assert.equal(result.simulated, false);
  assert.equal(result.plan, "Keep durable decisions");
  assert.equal(result.drafts.length, 2, "the duplicate goes");
  assert.equal(result.drafts[0].folder, "research/logistics");
  assert.equal(result.drafts[0].source.session, captured.id);
  assert.equal(result.drafts[1].folder, undefined, "a group outside the list is dropped, never fixed up");
  assert.equal(result.drafts[1].happened, undefined);
  assert.ok(JSON.stringify(schema).includes("labels"), "Droid gets the writer's emit_facts schema");
  assert.deepEqual(result.usage, { input_tokens: 123, output_tokens: 45 });
  assert.equal(options?.autonomyLevel, AutonomyLevel.Off);
  assert.equal(options?.autoRejectPermissionRequests, true);
  assert.equal(options?.disableBuiltinSkills, true);
  assert.equal(closed, true);
  assert.equal(existsSync(options!.cwd!), false);
});

test("Factory failure closes the SDK and never silently uses simulated facts", async () => {
  let closed = false;
  const engine = new DroidDistiller({ apiKey: "test", createSession: async () => ({
    listTools: async () => [], updateSettings: async () => ({} as never),
    async *stream() { yield { type: "result", success: false, error: { message: "Factory unavailable" } } as DroidResult; },
    close: async () => { closed = true; },
  }) });
  await assert.rejects(engine.distill(loadFixture()), /Factory unavailable/);
  assert.equal(closed, true);
});
