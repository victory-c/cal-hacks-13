// The demo world (task A2 on PRD v4.1): Edan's Axe Capital / Project Stonewall fixtures in
// fixtures/world/ (C20), read into the server's own types. world.json holds the people, groups,
// labels and scope rules; items/*.json the source items; expected.json the answer key, whose
// stable fact ids are what the benchmark cases in bench/tasks/finance/ point at.
//
// The answer key is seeded as the store's facts, so a scope build or a handoff runs on exactly the
// facts the cases expect, with the triage and fact-writer steps out of the measurement. Scopes are
// never copied from a fixture: the server builds the 0:00 ones with the real pipeline at startup
// (`initial_scopes`), and the rest are built live, as in the demo timeline.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT, validateFact } from "@canon/shared";
import type { CapturedSession, Fact, Group, Principal, ScopeRule, SourceKind } from "@canon/shared";

import type { WorldFixtures } from "./scopes.ts";

export const DEMO_WORLD_DIR = join(REPO_ROOT, "fixtures", "world");

/**
 * Which facts to seed. `seed`: the items loaded before the demo starts (the 0:25 items arrive live
 * through capture). `all`: every item that is not quarantined, the world the benchmark cases are
 * written against.
 */
export type WorldMoment = "seed" | "all";

export interface DemoWorld {
  fixtures: WorldFixtures;
  /** The answer key's facts, hot, in their groups, authored by their item's author. */
  facts: Fact[];
  /** One raw session per seeded item, for the cold archive the facts' sources point at. */
  sessions: CapturedSession[];
  /** Facts Wags refiles from deal/stonewall to market/public when the bid is announced (1:20). */
  announced: string[];
  /** Where announced facts are refiled to. */
  announcedGroup: string;
}

interface WorldJson {
  demo_date: string;
  principals: Array<{ id: string; kind: "person" | "agent"; name: string; tier?: "moderator" | "member"; creator?: string }>;
  groups: Array<{ id: string; description: string; display?: string; code_names?: string[] }>;
  scope_rules: Array<{ principal: string; set_by: string; task: string; exclusions: { groups: string[]; labels: string[]; text: string[] }; demo_beat?: string }>;
  timeline: Array<{ at: string; items?: string[] }>;
}

interface ExpectedJson {
  items: Record<string, { quarantine: boolean; facts: string[] }>;
  facts: Record<string, { group: string; labels?: string[]; announced?: boolean; statement: string; fact_id: string }>;
}

interface ItemJson {
  id: string;
  kind: string;
  source: string;
  author: string;
  captured_at: string;
  text: string;
}

const readJson = <T>(path: string): T => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    throw new Error(`demo world ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

/** A rule is built at 0:00 unless the timeline builds it live (Ben at 0:40, the agents created at 1:00). */
const builtAtStart = (beat: string | undefined): boolean => beat === undefined || beat === "0:00";

/** `deal/*` in the fixture means the group and everything under it, which is how the server matches `deal`. */
const groupPrefix = (g: string): string => g.replace(/\/\*$/, "");

/** Stable per item, so re-seeding writes the same session and the facts' sources keep resolving. */
export const itemSessionId = (itemId: string): string => `ses_${createHash("sha1").update(itemId).digest("hex").slice(0, 8)}`;

const ITEM_KINDS: Record<string, SourceKind> = { session: "ai_session", memo: "memo", chat: "chat", transcript: "transcript", email: "email", note: "note" };

export function loadDemoWorld(opts: { dir?: string; moment?: WorldMoment } = {}): DemoWorld {
  const dir = opts.dir ?? DEMO_WORLD_DIR;
  const moment = opts.moment ?? "seed";
  const world = readJson<WorldJson>(join(dir, "world.json"));
  const expected = readJson<ExpectedJson>(join(dir, "expected.json"));
  const items = new Map<string, ItemJson>();
  for (const file of readdirSync(join(dir, "items")).filter((f) => f.endsWith(".json")).sort()) {
    const item = readJson<ItemJson>(join(dir, "items", file));
    items.set(item.id, item);
  }

  // People, and the agents that already exist at 0:00. Agents created live are left out: their
  // creators make them through POST /api/agents, which builds the scope inside the creator's.
  const beats = new Map(world.scope_rules.map((r) => [r.principal, r.demo_beat]));
  const principals: Principal[] = world.principals
    .filter((p) => p.kind === "person" || builtAtStart(beats.get(p.id)))
    .map((p) => ({
      id: p.id,
      kind: p.kind,
      name: p.name,
      ...(p.kind === "person" && p.tier ? { tier: p.tier } : {}),
      ...(p.kind === "agent" && p.creator ? { created_by: p.creator } : {}),
    }));
  const present = new Set(principals.map((p) => p.id));

  const groups: Group[] = world.groups.map((g) => ({
    id: g.id,
    description: g.description,
    ...(g.display ? { display: g.display } : {}),
    ...(g.code_names && g.code_names.length > 0 ? { aliases: g.code_names } : {}),
  }));

  const updatedAt = `${world.demo_date}T08:00:00.000Z`;
  const rules: ScopeRule[] = world.scope_rules
    .filter((r) => present.has(r.principal))
    .map((r) => {
      const rule: ScopeRule = {
        principal: r.principal,
        task: r.task,
        exclude: { groups: r.exclusions.groups.map(groupPrefix), labels: [...r.exclusions.labels] },
        set_by: r.set_by,
        updated_at: updatedAt,
      };
      if (r.exclusions.text.length > 0) rule.exclude.text = r.exclusions.text.join("; ");
      return rule;
    });
  // People before agents, so an agent's build finds its creator's scope already there.
  const kindOf = new Map(principals.map((p) => [p.id, p.kind]));
  const initial = rules
    .filter((r) => builtAtStart(beats.get(r.principal)))
    .map((r) => r.principal)
    .sort((a, b) => (kindOf.get(a) === kindOf.get(b) ? 0 : kindOf.get(a) === "person" ? -1 : 1));

  // Facts from the items this moment holds. A quarantined item never becomes facts. Several items
  // can state the same fact (the memo and the chat that repeats it); the first item listed is its source.
  const seedItems = new Set(world.timeline.find((t) => t.at === "seed")?.items ?? []);
  const facts: Fact[] = [];
  const seen = new Set<string>();
  const sessions: CapturedSession[] = [];
  for (const [itemId, entry] of Object.entries(expected.items)) {
    if (entry.quarantine || (moment === "seed" && !seedItems.has(itemId))) continue;
    const item = items.get(itemId);
    if (!item) throw new Error(`demo world: expected.json names item ${itemId}, which items/ does not have`);
    const session = itemSessionId(itemId);
    sessions.push({
      id: session,
      client: "ingest",
      started_at: item.captured_at,
      ended_at: item.captured_at,
      title: item.source,
      messages: [{ role: "user", content: item.text, at: item.captured_at }],
      principal: item.author,
      kind: ITEM_KINDS[item.kind] ?? "note",
      meta: { item_id: itemId },
    });
    for (const key of entry.facts) {
      const f = expected.facts[key];
      if (!f) throw new Error(`demo world: item ${itemId} lists fact ${key}, which expected.json does not define`);
      if (seen.has(key)) continue;
      seen.add(key);
      const v = validateFact({
        id: f.fact_id,
        statement: f.statement,
        folder: f.group,
        tier: "hot",
        jev_keep: 0.9,
        source: { client: "ingest", session },
        updated: item.captured_at.slice(0, 10),
        ...(f.labels && f.labels.length > 0 ? { labels: f.labels } : {}),
        author: item.author,
      });
      if (!v.ok) throw new Error(`demo world: fact ${key} (${f.fact_id}): ${v.errors.join("; ")}`);
      facts.push(v.fact);
    }
  }

  return {
    fixtures: { groups, principals, rules, scopes: [], quarantine: [], audit: [], initial_scopes: initial },
    facts,
    sessions,
    announced: Object.values(expected.facts).filter((f) => f.announced).map((f) => f.fact_id),
    announcedGroup: "market/public",
  };
}
