// The member mock's copy of Ben's view must match fixtures/world exactly, and must hold nothing
// from outside Ben's scope.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ANSWER_KEY, GROUP_NAMES, ITEMS, ME, seedAgents, seedFacts } from "./fixture.ts";

const WORLD = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/world");
const read = (p: string) => JSON.parse(readFileSync(join(WORLD, p), "utf8"));
const world = read("world.json");
const expected = read("expected.json");

test("every fact matches the answer key: id, group, labels, statement, source item", () => {
  for (const f of seedFacts()) {
    const key = expected.facts[ANSWER_KEY[f.id]!];
    assert.ok(key, f.id);
    assert.equal(key.fact_id, f.id);
    assert.equal(key.group, f.group, f.id);
    assert.deepEqual(key.labels, f.labels, f.id);
    assert.equal(key.statement, f.statement, f.id);
    assert.ok(expected.items[f.source].facts.includes(ANSWER_KEY[f.id]), `${f.id} from ${f.source}`);
  }
});

test("source items match fixtures/world/items", () => {
  for (const i of ITEMS) {
    const item = read(join("items", `${i.id}.json`));
    assert.deepEqual([item.kind, item.source, item.author, item.captured_at], [i.kind, i.title, i.author, i.captured_at]);
  }
});

test("nothing outside Ben's scope: no deal or desk group, no leak marker, no code name", () => {
  const blob = JSON.stringify({ facts: seedFacts(), items: ITEMS, groups: GROUP_NAMES, agents: seedAgents() }).toLowerCase();
  for (const f of seedFacts()) assert.ok(!f.group.startsWith("deal/") && !f.group.startsWith("desk/"), f.id);
  for (const g of world.groups) for (const name of g.code_names) assert.ok(!blob.includes(name.toLowerCase()), name);
  for (const marker of [...expected.leak_markers.always, ...expected.leak_markers.until_announced] as string[]) {
    assert.ok(!blob.includes(marker.toLowerCase()), marker);
  }
});

test("principal, group names and the seeded agent match world.json", () => {
  const ben = world.principals.find((p: { id: string }) => p.id === ME.id);
  assert.equal(ben.name, ME.name);
  assert.equal(world.firm.name, ME.firm);
  for (const [id, name] of Object.entries(GROUP_NAMES)) assert.equal(world.groups.find((g: { id: string }) => g.id === id).display, name);
  const agent = seedAgents()[0]!;
  const rule = world.scope_rules.find((r: { principal: string }) => r.principal === agent.id);
  assert.equal(rule.set_by, ME.id);
  assert.equal(rule.task, agent.task);
});
