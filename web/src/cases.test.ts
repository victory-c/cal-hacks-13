// Checks the finance benchmark cases in bench/tasks/finance/ (C6) against the case format lane A's
// evaluator loads and against the demo world in fixtures/world/: every needed fact exists, every
// answer phrase is actually in the material, and every leak probe exists only behind the wall.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CASES = join(ROOT, "bench/tasks/finance");
const WORLD = join(ROOT, "fixtures/world");

const CASE_FILE_RE = /^(task|attack)-(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;
const FACT_ID_RE = /^fct_[0-9a-f]{4,}$/;
const SESSION_ID_RE = /^ses_[0-9a-f]{4,}$/;
const STYLES = ["direct", "paraphrase", "code-name", "indirect", "planted-instruction", "agent-escalation"];
const TASK_KEYS = ["title", "principal", "question", "needed_fact_ids", "answer_key", "notes"];
const ATTACK_KEYS = ["title", "principal", "question", "attack_style", "leak_probes", "agent", "setup_sessions", "answer_key", "notes"];

const json = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const world = json(join(WORLD, "world.json"));
const expected = json(join(WORLD, "expected.json"));
const itemText = new Map<string, string>(
  readdirSync(join(WORLD, "items")).map((f) => {
    const item = json(join(WORLD, "items", f));
    return [item.id as string, item.text as string];
  }),
);
const files = readdirSync(CASES).filter((f) => f.endsWith(".json")).sort();
const cases = files.map((f) => ({ file: f, kind: f.startsWith("task") ? "task" : "attack", c: json(join(CASES, f)) }));
const tasks = cases.filter((x) => x.kind === "task");
const attacks = cases.filter((x) => x.kind === "attack");

const factByFid = new Map<string, any>(Object.entries<any>(expected.facts).map(([key, f]) => [f.fact_id, { ...f, name: key }]));
const itemsOfFact = (key: string) => Object.entries<any>(expected.items).filter(([, e]) => e.facts.includes(key)).map(([id]) => id);
const lower = (s: string) => s.toLowerCase();
const has = (text: string, phrase: string) => lower(text).includes(lower(phrase));

const ruleOf = (p: string) => world.scope_rules.find((r: any) => r.principal === p);
const excludesDeals = (p: string) => (ruleOf(p)?.exclusions.groups ?? []).some((g: string) => g === "deal/*" || g === "deal/stonewall");
const isDealItem = (id: string) => expected.items[id].quarantine || expected.items[id].facts.some((k: string) => expected.facts[k].group === "deal/stonewall");
const dealText = [...itemText].filter(([id]) => isDealItem(id)).map(([, t]) => t).join("\n");
const publicText = [...itemText].filter(([id]) => !isDealItem(id)).map(([, t]) => t).join("\n");

test("file names, counts and styles match the PRD targets", () => {
  for (const f of files) assert.match(f, CASE_FILE_RE);
  assert.equal(tasks.length, 30);
  assert.equal(attacks.length, 60);
  for (const s of STYLES) assert.equal(attacks.filter((a) => a.c.attack_style === s).length, 10, s);
  assert.equal(new Set(files.map((f) => f.slice(0, f.indexOf("-", f.indexOf("-") + 1)))).size, files.length, "numbers are unique per kind");
});

test("every case uses only the fields its kind allows", () => {
  for (const { file, kind, c } of cases) {
    const allowed = kind === "task" ? TASK_KEYS : ATTACK_KEYS;
    for (const k of Object.keys(c)) assert.ok(allowed.includes(k), `${file}: ${k}`);
    for (const k of ["title", "principal", "question"]) assert.ok(typeof c[k] === "string" && c[k].trim(), `${file}: ${k}`);
    assert.ok(world.principals.some((p: any) => p.id === c.principal && p.kind === "person"), `${file}: principal ${c.principal}`);
  }
});

test("tasks name real facts, and their answer phrases are in those facts' items", () => {
  for (const { file, c } of tasks) {
    assert.ok(Array.isArray(c.needed_fact_ids), file);
    assert.ok(c.answer_key?.must_include?.length, `${file}: must_include`);
    const text = c.needed_fact_ids
      .map((fid: string) => {
        assert.match(fid, FACT_ID_RE, `${file}: ${fid}`);
        const fact = factByFid.get(fid);
        assert.ok(fact, `${file}: unknown fact ${fid}`);
        if (excludesDeals(c.principal)) assert.notEqual(fact.group, "deal/stonewall", `${file}: ${c.principal} can't be given ${fact.name}`);
        return itemsOfFact(fact.name).map((id) => itemText.get(id)).join("\n");
      })
      .join("\n");
    if (c.needed_fact_ids.length === 0) continue;
    for (const p of c.answer_key.must_include) assert.ok(has(text, p), `${file}: "${p}" is not in the needed facts' items`);
    for (const p of c.answer_key.must_not_include ?? []) assert.ok(!has(text, p), `${file}: forbidden "${p}" is in the needed facts' items`);
  }
});

test("attacks come from members whose scope excludes the deal", () => {
  for (const { file, c } of attacks) assert.ok(excludesDeals(c.principal), `${file}: ${c.principal}`);
});

test("leak probes exist only behind the wall, never in the attacker's own text", () => {
  for (const { file, c } of attacks) {
    assert.ok(c.leak_probes.length > 0, file);
    const own = [c.question, c.agent?.name ?? "", c.agent?.rule.task ?? "", ...(c.setup_sessions ?? []).flatMap((s: any) => s.messages.map((m: any) => m.content))].join("\n");
    for (const p of c.leak_probes) {
      assert.ok(!has(own, p), `${file}: probe "${p}" is in the attack's own text`);
      assert.ok(has(dealText, p), `${file}: probe "${p}" is not in any deal item`);
      assert.ok(!has(publicText, p), `${file}: probe "${p}" appears in public material`);
    }
  }
});

test("style-specific fields are present exactly where they belong", () => {
  const sessionIds = new Set<string>();
  for (const { file, c } of attacks) {
    const s = c.attack_style;
    assert.equal(c.agent !== undefined, s === "agent-escalation", `${file}: agent`);
    assert.equal(c.setup_sessions !== undefined, s === "planted-instruction", `${file}: setup_sessions`);
    if (c.agent) assert.ok(c.agent.name && c.agent.rule.task && Array.isArray(c.agent.rule.exclude.groups) && Array.isArray(c.agent.rule.exclude.labels), file);
    for (const session of c.setup_sessions ?? []) {
      assert.match(session.id, SESSION_ID_RE, file);
      assert.ok(!sessionIds.has(session.id), `${file}: duplicate ${session.id}`);
      sessionIds.add(session.id);
      assert.ok(!Number.isNaN(Date.parse(session.started_at)) && session.messages.length > 0, file);
    }
  }
});
