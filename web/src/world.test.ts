// Checks the synthetic demo world in fixtures/world/ against itself, so a typo in a memo or the
// answer key fails `npm run check` instead of a live demo. Lives in web/ because the console
// mocks are built from this world; it reads plain JSON and imports nothing from other packages.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const WORLD = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/world");
const ITEM_KINDS = ["memo", "chat", "email", "transcript", "note", "session"];

interface Item { id: string; kind: string; source: string; author: string; captured_at: string; text: string }
interface FactKey { group: string; labels: string[]; announced: boolean; statement: string; key: string[] }

const read = <T>(path: string): T => JSON.parse(readFileSync(join(WORLD, path), "utf8")) as T;
const world = read<any>("world.json");
const expected = read<any>("expected.json");
const items: Item[] = readdirSync(join(WORLD, "items")).filter((f) => f.endsWith(".json")).map((f) => read<Item>(join("items", f)));
const byItem = new Map(items.map((i) => [i.id, i]));
const facts: Record<string, FactKey> = expected.facts;
const principals = new Set<string>(world.principals.map((p: { id: string }) => p.id));
const groups = new Set<string>(world.groups.map((g: { id: string }) => g.id));
const has = (text: string, phrase: string) => text.toLowerCase().includes(phrase.toLowerCase());

test("items follow the Item shape, with unique ids and known authors", () => {
  assert.equal(new Set(items.map((i) => i.id)).size, items.length);
  for (const i of items) {
    assert.ok(ITEM_KINDS.includes(i.kind), `${i.id}: kind ${i.kind}`);
    assert.ok(principals.has(i.author), `${i.id}: author ${i.author}`);
    assert.ok(!Number.isNaN(Date.parse(i.captured_at)), `${i.id}: captured_at`);
    assert.ok(i.source && i.text.length > 40, `${i.id}: source and text`);
  }
});

test("the answer key covers every item, and the timeline names only real items", () => {
  assert.deepEqual(Object.keys(expected.items).sort(), items.map((i) => i.id).sort());
  for (const step of world.timeline) for (const id of step.items ?? []) assert.ok(byItem.has(id), `timeline: ${id}`);
});

test("every expected fact is in a known group and its key phrase appears in its item", () => {
  for (const [itemId, entry] of Object.entries<any>(expected.items)) {
    const text = byItem.get(itemId)!.text;
    for (const factId of entry.facts) {
      const fact = facts[factId];
      assert.ok(fact, `${itemId}: unknown fact ${factId}`);
      assert.ok(groups.has(fact.group), `${factId}: group ${fact.group}`);
      assert.ok(fact.key.some((k) => has(text, k)), `${itemId} should mention ${factId} (${fact.key.join(" | ")})`);
    }
  }
});

test("only deal facts are announced, and the valuation and financing stay walled", () => {
  for (const [id, f] of Object.entries(facts)) if (f.announced) assert.equal(f.group, "deal/stonewall", id);
  for (const id of ["kf_multiple", "kf_walkaway", "kf_financing", "kf_standstill_ask"]) assert.equal(facts[id]!.announced, false, id);
});

test("no public-side item contains a deal leak marker", () => {
  const markers: string[] = [...expected.leak_markers.always, ...expected.leak_markers.until_announced];
  for (const [itemId, entry] of Object.entries<any>(expected.items)) {
    if (entry.quarantine) continue;
    const dealItem = entry.facts.some((id: string) => facts[id]!.group === "deal/stonewall");
    if (dealItem) continue;
    for (const m of markers) assert.ok(!has(byItem.get(itemId)!.text, m), `${itemId} leaks "${m}"`);
  }
});

test("the counsel email carries the planted instruction and is expected in quarantine", () => {
  const entry = expected.items.itm_counsel_email;
  assert.equal(entry.quarantine, true);
  assert.ok(has(byItem.get("itm_counsel_email")!.text, entry.planted));
});

test("scope rules and agents point at real principals and groups; agents have creators", () => {
  for (const rule of world.scope_rules) {
    assert.ok(principals.has(rule.principal), rule.principal);
    assert.ok(principals.has(rule.set_by), rule.set_by);
    for (const g of rule.exclusions.groups) assert.ok(g.endsWith("/*") || groups.has(g), `${rule.principal}: ${g}`);
  }
  for (const p of world.principals) if (p.kind === "agent") assert.ok(principals.has(p.creator), `${p.id}: creator`);
  const moderators = world.principals.filter((p: { tier?: string }) => p.tier === "moderator");
  assert.deepEqual(moderators.map((p: { id: string }) => p.id), ["wags"]);
});

test("the deal numbers reconcile", () => {
  const t = world.target;
  const offer = 52.75;
  assert.equal(Math.round((offer / t.share_price_30d_avg - 1) * 100), 28, "premium");
  assert.equal(Math.round((offer / t.consensus_eps_2027) * 10) / 10, 11, "multiple");
  assert.equal(Math.round((offer * t.shares_outstanding_millions) / 100) / 10, 3.2, "equity value, $bn");
  assert.equal(1.9 + 1.3, 3.2, "financing plus cash");
  assert.equal(Math.round((t.share_price_30d_avg / t.consensus_eps_2027) * 10) / 10, 8.6, "public multiple");
  assert.equal(Math.round(180_000 * (t.share_price_close_2026_10_23 - 39.1) / 10_000) * 10_000, 460_000, "desk P&L");
});

test("every email address uses a .example domain", () => {
  for (const i of items) for (const m of i.text.matchAll(/[\w.+-]+@([\w-]+\.)+[\w-]+/g)) assert.ok(m[0].endsWith(".example"), `${i.id}: ${m[0]}`);
});
