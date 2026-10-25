// Demo-only member page: the member view on browser-simulated data, playing any of the demo
// people (`?as=dollar-bill`, `axe` or `ben`) with their memory built from fixtures/world. Tabs on
// the same origin share what happens: an item pasted as Dollar Bill reaches Axe's tab if it fits
// his groups, and facts Compliance refiles on moderator.html?data=mock (the 1:20 announcement)
// reach every member tab. `?stage=announced` starts after the announcement. `?reset` clears the
// shared state. This bundle holds the whole world, deal facts included, so it is a separate entry
// point from member.js and is for recording the demo, not for deployment.

import world from "../../fixtures/world/world.json" with { type: "json" };
import expected from "../../fixtures/world/expected.json" with { type: "json" };
import axeChatgpt from "../../fixtures/world/items/itm_axe_chatgpt.json" with { type: "json" };
import chatDeal from "../../fixtures/world/items/itm_chat_deal.json" with { type: "json" };
import chatDesk from "../../fixtures/world/items/itm_chat_desk.json" with { type: "json" };
import chatGeneral from "../../fixtures/world/items/itm_chat_general.json" with { type: "json" };
import chatResearch from "../../fixtures/world/items/itm_chat_research.json" with { type: "json" };
import deskNotes from "../../fixtures/world/items/itm_desk_notes.json" with { type: "json" };
import researchDraft from "../../fixtures/world/items/itm_research_draft.json" with { type: "json" };
import swMeeting from "../../fixtures/world/items/itm_sw_meeting.json" with { type: "json" };
import swTerms from "../../fixtures/world/items/itm_sw_terms.json" with { type: "json" };
import swValuation from "../../fixtures/world/items/itm_sw_valuation.json" with { type: "json" };
import tmcLetter from "../../fixtures/world/items/itm_tmc_q3_letter.json" with { type: "json" };

import type { AgentRun, DocType, Fact, ItemKind, Schedule } from "./member/contract.ts";
import type { SourceItem } from "./member/fixture.ts";
import { MockCanon } from "./member/mock.ts";

interface RawItem { id: string; kind: string; source: string; author: string; captured_at: string }
interface KeyFact { group: string; labels: string[]; statement: string; fact_id: string; announced: boolean }

const SHARED = "bullwark.demo.shared";
const PUBLIC = "market/public";

/** Whose view, which groups their memory holds, and their agent. */
const PEOPLE: Record<string, { groups: string[]; agent: { id: string; name: string; task: string; docs: DocType[]; schedule: Schedule } }> = {
  "dollar-bill": {
    groups: [PUBLIC, "desk/dollar-bill", "firm/ops"],
    agent: { id: "desk-assistant", name: "Desk assistant", task: "Answer my questions about our positions and public news.", docs: ["summary", "snapshot"], schedule: "Only when I press Run" },
  },
  axe: {
    groups: ["deal/stonewall", PUBLIC, "firm/ops"],
    agent: { id: "deal-analyst", name: "Deal analyst", task: "Draft the Stonewall bid memo: offer terms, valuation, financing and timing.", docs: ["memo", "compare", "dates"], schedule: "Only when I press Run" },
  },
  ben: {
    groups: ["research/asset-managers", PUBLIC, "firm/ops"],
    agent: { id: "research-analyst", name: "Research analyst", task: "Update our asset management sector note.", docs: ["memo", "trends", "compare", "dates"], schedule: "Every Monday, 8:00 AM" },
  },
};

const q = new URLSearchParams(location.search);
const who = PEOPLE[q.get("as") ?? ""] ? q.get("as")! : "dollar-bill";
const person = PEOPLE[who]!;
const principal = world.principals.find((p) => p.id === who)!;
if (q.has("reset")) try { localStorage.removeItem(SHARED); } catch { /* storage blocked */ }

const ITEMS = new Map<string, RawItem>([axeChatgpt, chatDeal, chatDesk, chatGeneral, chatResearch, deskNotes, researchDraft, swMeeting, swTerms, swValuation, tmcLetter].map((i) => [i.id, i as RawItem]));
const KEY = expected.facts as Record<string, KeyFact>;
const KEY_ITEMS = expected.items as Record<string, { facts: string[] }>;
// Only this person's groups: a member is never told what other groups exist.
const groupNames = Object.fromEntries(world.groups.filter((g) => person.groups.includes(g.id)).map((g) => [g.id, g.display]));

/** Simulated triage for the demo: desk notes stay on the desk, prices and letters are public. */
function demoClassify(s: string): string {
  const l = s.toLowerCase();
  if (/stonewall|tender offer|takeover|walk-away|standstill/.test(l)) return "deal/stonewall";
  if (/desk note|our position|the tmc position|sizing|shares at an average|trimmed|basket/.test(l)) return "desk/dollar-bill";
  if (/office|offsite|expense|invoice|payroll/.test(l)) return "firm/ops";
  if (/closed at|letter|filing|announc|press release|shareholder|buyback/.test(l)) return PUBLIC;
  if (/asset manager|outflow|fee|multiple|sector/.test(l)) return "research/asset-managers";
  return PUBLIC;
}
const announced = q.get("stage") === "announced";

// Every fact the world holds before the demo, plus the two deal items that arrive at 0:25 (Axe's view needs them).
const worldFacts: Fact[] = [];
for (const itemId of [...ITEMS.keys()]) {
  const item = ITEMS.get(itemId)!;
  for (const key of KEY_ITEMS[itemId]?.facts ?? []) {
    const f = KEY[key]!;
    if (worldFacts.some((x) => x.id === f.fact_id)) continue;
    worldFacts.push({
      id: f.fact_id, statement: f.statement, group: announced && f.announced ? PUBLIC : f.group, labels: [...f.labels],
      source: item.id, author: item.author, happened_at: item.captured_at, learned_at: item.captured_at, status: "hot",
      source_kind: item.kind as ItemKind, source_title: item.source,
    });
  }
}

function sharedFacts(): Fact[] {
  try { return (JSON.parse(localStorage.getItem(SHARED) ?? "{}") as { facts?: Fact[] }).facts ?? []; } catch { return []; }
}

const allowed = (f: Fact) => person.groups.includes(f.group);
// Facts shared by other tabs (pasted items, refiles) replace or join the world's.
const merged = new Map(worldFacts.map((f) => [f.id, f]));
for (const f of sharedFacts()) merged.set(f.id, f);
const facts = [...merged.values()].filter(allowed);

const items: SourceItem[] = [...ITEMS.values()].map((i) => ({ id: i.id, kind: i.kind as ItemKind, title: i.source, author: i.author, captured_at: i.captured_at }));
const agent: AgentRun = {
  id: person.agent.id, creator: who, name: person.agent.name, status: "ready", steps: [], files: [], inbox: [],
  task: person.agent.task, leave_out: "", docs: person.agent.docs, schedule: person.agent.schedule,
  outputs: [], finished_at: null, fact_count: 0, pending: 0,
};

const api = new MockCanon({
  seed: { me: { id: who, kind: "person", name: principal.name, tier: "member", firm: world.firm.name }, facts, agents: [agent], items, groupNames },
  classify: demoClassify,
  onFacts: (fresh) => {
    try {
      const all = new Map(sharedFacts().map((f) => [f.id, f]));
      for (const f of fresh) all.set(f.id, f);
      localStorage.setItem(SHARED, JSON.stringify({ facts: [...all.values()] }));
    } catch { /* storage blocked: tabs don't sync */ }
  },
});

// Another tab pasted an item or Compliance refiled facts: absorb whatever now fits this person.
const seen = new Set(facts.map((f) => f.id));
window.addEventListener("storage", (e) => {
  if (e.key !== SHARED) return;
  const shared = sharedFacts();
  api.regroup(shared.filter((f) => seen.has(f.id)));
  const fresh = shared.filter((f) => allowed(f) && !seen.has(f.id));
  for (const f of fresh) seen.add(f.id);
  if (fresh.length) api.absorb(fresh);
});

Object.assign(globalThis, { __bullwarkMemberApi: api, __bullwarkDemoWho: principal.name });
await import("./member.ts");
