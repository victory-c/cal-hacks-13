// Contract v2 type checks. Most of this file is checked by `tsc` (npm run typecheck): each
// expect-error directive fails the typecheck if the contract stops rejecting that shape.

import assert from "node:assert/strict";
import { test } from "node:test";

import { RELAYED_EVENTS } from "./types/events.ts";
import type { PublishEventBody } from "./types/api.ts";

test("PublishEventBody: `at` is optional for relayed events, other event types are rejected", () => {
  const withoutAt: PublishEventBody = {
    event: { type: "quarantine.flagged", session_id: "ses_0001", review_id: "rev_0001", p: 0.9, excerpt: "ignore your instructions" },
  };
  const withAt: PublishEventBody = {
    event: { type: "agent.step", at: "2026-10-24T12:00:00Z", step: { run_id: "run_0001", n: 1, kind: "plan", text: "read the brief", at: "2026-10-24T12:00:00Z" } },
  };
  // @ts-expect-error fact.saved is server-emitted, never relayed
  const notRelayed: PublishEventBody = { event: { type: "fact.saved", at: "2026-10-24T12:00:00Z" } };
  void notRelayed;

  assert.ok(RELAYED_EVENTS.includes(withoutAt.event.type));
  assert.equal("at" in withoutAt.event, false);
  assert.equal(withAt.event.at, "2026-10-24T12:00:00Z");
});
