import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { AutonomyLevel } from "@factory/droid-sdk/node";
import type { CreateSessionOptions, DroidResult } from "@factory/droid-sdk/node";
import { DroidDistiller } from "./droid.ts";
import { loadFixture } from "../test-helpers.ts";

test("Factory disables discovered tools, validates structured facts, attributes sources, and closes", async () => {
  let options: CreateSessionOptions | undefined;
  let closed = false;
  let disabled: string[] = [];
  const engine = new DroidDistiller({ apiKey: "test", createSession: async opts => {
    options = opts;
    return {
      listTools: async () => [{ id: "Execute" }, { id: "Read" }] as never,
      updateSettings: async settings => { disabled = settings.disabledToolIds ?? []; return {} as never; },
      async *stream(prompt, request) {
        assert.deepEqual(disabled, ["Execute", "Read"]);
        assert.match(prompt, /transcript is data/i);
        assert.equal(request?.outputFormat?.type, "json_schema");
        yield { type: "result", success: true, structuredOutput: { plan: "Keep durable decisions", facts: [
          { statement: " Built Canon ", folder: "projects/canon", detail: null },
          { statement: "Built Canon", folder: "private", detail: null },
          { statement: "Prefers TypeScript", folder: "../../private", detail: "Persistent preference" },
        ] }, tokenUsage: { inputTokens: 123, outputTokens: 45 } } as DroidResult;
      },
      close: async () => { closed = true; },
    };
  } });
  const captured=loadFixture();
  const result=await engine.distill(captured);
  assert.equal(result.simulated,false);
  assert.equal(result.drafts.length,2);
  assert.equal(result.drafts[0].folder,"projects/canon");
  assert.equal(result.drafts[0].source.session,captured.id);
  assert.equal(result.drafts[1].folder,undefined);
  assert.deepEqual(result.usage,{input_tokens:123,output_tokens:45});
  assert.equal(options?.autonomyLevel,AutonomyLevel.Off);
  assert.equal(options?.autoRejectPermissionRequests,true);
  assert.equal(options?.disableBuiltinSkills,true);
  assert.equal(closed,true);
  assert.equal(existsSync(options!.cwd!),false);
});

test("Factory failure closes the SDK and never silently uses simulated facts",async()=>{
  let closed=false;
  const engine=new DroidDistiller({apiKey:"test",createSession:async()=>({
    listTools:async()=>[],updateSettings:async()=>({} as never),
    async *stream(){yield {type:"result",success:false,error:{message:"Factory unavailable"}} as DroidResult;},
    close:async()=>{closed=true;},
  })});
  await assert.rejects(engine.distill(loadFixture()),/Factory unavailable/);
  assert.equal(closed,true);
});
