import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentRun, Fact } from "./contract.ts";
import { GROUP_NAMES, seedAgents, seedFacts } from "./fixture.ts";
import {
  ALL_GROUPS, NO_FILTERS, agentPlanLine, agentStatusLine, countShown, feedText, filtersActive, fmtDay, groupLabel,
  groupOrder, kindLabel, viewMemory, agentPhase, boldRuns, docBlocks, elapsed, fileLabel, friendlyStep,
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

test("friendlyStep: Canon's runtime lines in the creator's words, with the memory it reads", () => {
  const statements: Record<string, string> = { fct_570013: "TMC's assets under management were $38.4 billion at the end of Q3 2026, down 3% from $39.6 billion" };
  const say = (text: string, kind?: string) => friendlyStep({ text, kind }, (id) => statements[id]);
  assert.equal(say("facts/ holds 4 fact file(s) from the agent's scope"), "Gathered 4 memories it may use");
  assert.equal(say("facts/ holds 1 fact file(s) from the agent's scope"), "Gathered 1 memory it may use");
  assert.equal(say("brief.md written by claude from the handoff (3 fact(s), 51 tokens est.)"), "Wrote itself a brief");
  assert.equal(say("list_files facts"), "Looking through its memories");
  assert.match(say("read_file facts/fct_570013.md"), /^Reading “TMC's assets under management were \$38\.4 billion at the end of Q3 2026, down 3% from…”$/, "a long statement is cut at a word");
  assert.equal(say("read_file facts/fct_99999999.md"), "Reading a memory", "a fact the page does not hold is never guessed at");
  assert.equal(say("wrote out/plan.md (503 chars)"), "Made a plan");
  assert.equal(say("wrote out/tmc_brief.md (888 chars)"), "Writing tmc brief");
  assert.equal(say("wrote out/memories/progress.md (120 chars)"), "Writing a note for your memory");
  assert.equal(say("saved out/memories/progress.md to dollar-bill's memory"), "Saved a note to your memory");
  assert.equal(say("saved out/tmc_brief.md to dollar-bill's memory"), "Saved tmc brief to your memory");
  assert.equal(say("Restart 1: the old folder was discarded; a fresh folder is built from the current scope"), "Its memory changed, so it started again");
  assert.equal(say("Done: 1 file(s) saved as dollar-bill's memory (session ses_38f4aa58)."), "Finished");
  assert.equal(say("write_file refused: writes are allowed only under out/", "error"), "Tried something it isn’t allowed to, and carried on");
  assert.equal(say("Read brief and facts; wrote plan.", "message"), "Read brief and facts; wrote plan.", "the agent's own words stay as written");
});

test("agentPhase follows a run from getting ready to saving", () => {
  const step = (text: string, kind = "tool") => ({ id: text, text, kind, status: "done" as const, at: "" });
  assert.equal(agentPhase({ status: "building", steps: [] }), "Getting its memory ready");
  assert.equal(agentPhase({ status: "running", steps: [] }), "Starting");
  assert.equal(agentPhase({ status: "running", steps: [step("brief.md written by claude", "brief")] }), "Getting ready");
  assert.equal(agentPhase({ status: "running", steps: [step("read_file brief.md")] }), "Planning");
  assert.equal(agentPhase({ status: "running", steps: [step("wrote out/plan.md (5 chars)", "file"), step("read_file facts/fct_1.md")] }), "Working");
  assert.equal(agentPhase({ status: "running", steps: [step("wrote out/plan.md (5 chars)", "file"), step("wrote out/brief.md (9 chars)", "file")] }), "Writing");
  assert.equal(agentPhase({ status: "running", steps: [step("saved out/brief.md to ben's memory", "file")] }), "Saving to your memory");
});

test("elapsed reads like a stopwatch", () => {
  const t0 = Date.parse("2026-10-25T09:00:00Z");
  assert.equal(elapsed("2026-10-25T09:00:00Z", t0 + 8_400), "8s");
  assert.equal(elapsed("2026-10-25T09:00:00Z", t0 + 65_000), "1m 05s");
  assert.equal(elapsed(null, t0), "");
  assert.equal(elapsed("2026-10-25T09:00:10Z", t0), "", "a clock ahead of ours shows nothing");
});

test("docBlocks: headings, lists and paragraphs; everything else stays text", () => {
  const md = "# TMC brief\n\n**Purpose:** our position.\nSecond line of it.\n\n## Public data\n- AUM $38.4bn\n2. Buyback paused\n<script>alert(1)</script>";
  assert.deepEqual(docBlocks(md), [
    { type: "heading", level: 1, text: "TMC brief" },
    { type: "para", text: "**Purpose:** our position. Second line of it." },
    { type: "heading", level: 2, text: "Public data" },
    { type: "item", text: "AUM $38.4bn" },
    { type: "item", text: "Buyback paused" },
    { type: "para", text: "<script>alert(1)</script>" },
  ]);
  assert.deepEqual(boldRuns("**Purpose:** our position"), ["", "Purpose:", " our position"]);
  assert.equal(fileLabel("out/tmc_brief-v2.md"), "tmc brief v2");
});
