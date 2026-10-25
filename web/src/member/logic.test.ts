import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentRun, Fact } from "./contract.ts";
import { GROUP_NAMES, seedAgents, seedFacts } from "./fixture.ts";
import {
  ALL_GROUPS, NO_FILTERS, agentPlanLine, agentStatusLine, countShown, feedText, filtersActive, fmtDay, groupLabel,
  groupOrder, kindLabel, viewMemory,
} from "./logic.ts";

const facts = seedFacts();
const order = groupOrder(facts);

test("groups show their display name, unknown ids a readable fallback", () => {
  assert.equal(groupLabel("market/public", GROUP_NAMES), "Public market");
  assert.equal(groupLabel("research/sector-notes", {}), "Sector notes");
});

test("by group: stable order, every hot fact once", () => {
  const groups = viewMemory(facts, NO_FILTERS, GROUP_NAMES, order);
  assert.deepEqual(groups.map((g) => g.label), ["Public market", "Asset manager research", "Firm operations"]);
  assert.equal(countShown(groups), facts.length);
  assert.deepEqual(groups.map((g) => g.index), [0, 1, 2]);
});

test("keyword, group and source filters combine", () => {
  const kw = viewMemory(facts, { ...NO_FILTERS, keyword: "outflows" }, GROUP_NAMES, order);
  assert.equal(countShown(kw), 2);
  const grp = viewMemory(facts, { ...NO_FILTERS, group: "Firm operations" }, GROUP_NAMES, order);
  assert.equal(countShown(grp), 3);
  const src = viewMemory(facts, { ...NO_FILTERS, source: "Taylor Mason Capital Q3 2026 shareholder letter (public)", keyword: "buyback" }, GROUP_NAMES, order);
  assert.equal(countShown(src), 1);
  assert.equal(countShown(viewMemory(facts, { ...NO_FILTERS, keyword: "zzz" }, GROUP_NAMES, order)), 0);
});

test("date sorts give one flat list, newest or oldest first", () => {
  const newest = viewMemory(facts, { ...NO_FILTERS, sort: "Newest first" }, GROUP_NAMES, order);
  assert.equal(newest.length, 1);
  assert.equal(newest[0]!.label, "");
  const dates = newest[0]!.facts.map((f) => Date.parse(f.learned_at));
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
  const oldest = viewMemory(facts, { ...NO_FILTERS, sort: "Oldest first" }, GROUP_NAMES, order)[0]!.facts;
  assert.equal(oldest[0]!.source, "itm_tmc_q3_letter");
});

test("retired facts never show", () => {
  const retired: Fact[] = facts.map((f, i) => (i === 0 ? { ...f, status: "cold" } : f));
  assert.equal(countShown(viewMemory(retired, NO_FILTERS, GROUP_NAMES, order)), facts.length - 1);
});

test("filtersActive notices any narrowing or reordering", () => {
  assert.equal(filtersActive(NO_FILTERS), false);
  assert.equal(filtersActive({ ...NO_FILTERS, keyword: "  " }), false);
  assert.equal(filtersActive({ ...NO_FILTERS, group: "Public market" }), true);
  assert.equal(filtersActive({ ...NO_FILTERS, sort: "Oldest first" }), true);
  assert.equal(NO_FILTERS.group, ALL_GROUPS);
});

test("labels and dates", () => {
  assert.equal(kindLabel("memo"), "Memo");
  assert.equal(kindLabel(undefined), "Note");
  assert.equal(fmtDay("2026-10-21T13:00:00.000Z", "UTC"), "Oct 21");
  assert.equal(fmtDay("nope"), "—");
});

test("agent lines: busy shows the step, idle shows the last result and waiting memories", () => {
  const base: AgentRun = seedAgents()[0]!;
  const now = Date.parse("2026-10-24T12:00:00Z");
  assert.equal(agentStatusLine(base, now), "Not run yet");
  assert.equal(agentStatusLine({ ...base, status: "building" }, now), "Picking what it needs from your memory…");
  const step = { id: "s1", text: "Writing market trends", status: "running" as const, at: "2026-10-24T11:59:59Z" };
  assert.equal(agentStatusLine({ ...base, status: "running", steps: [step] }, now), "Writing market trends");
  assert.equal(agentStatusLine({ ...base, status: "done", finished_at: "2026-10-24T11:58:00Z", pending: 2 }, now), "Finished 2 min ago · 2 new memories for the next run");
  assert.equal(agentPlanLine(base), "Every Monday, 8:00 AM · Makes draft note, market trends, peer comparison, key dates");
});

test("feed lines name only what the member sees", () => {
  const run = seedAgents()[0]!;
  const at = "2026-10-24T12:00:00Z";
  assert.equal(feedText({ type: "item.captured", at, item_id: "i", kind: "memo", source: "Q3 letter", author: "ben" }, () => undefined), "Your memo was added: Q3 letter");
  assert.equal(feedText({ type: "scope.build", at, build_id: "b", principal: run.id, stage: "judged", counts: {} }, () => run.name), null);
  assert.equal(feedText({ type: "scope.build", at, build_id: "b", principal: run.id, stage: "done", counts: {} }, () => run.name), "Research analyst’s memory is ready");
  assert.equal(feedText({ type: "agent.finished", at, run: { ...run, status: "stopped" } }, () => undefined), "You stopped Research analyst");
  assert.equal(feedText({ type: "scope.changed", at, principal: "ben", added: [], removed: ["x"] }, () => undefined), null);
});
