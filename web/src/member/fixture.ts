// Ben Carter's view of the demo world, for the member view's mock data. It holds only what Ben's
// scope holds at 0:00: no Stonewall fact, no desk note, nothing that names them. That is why it is
// copied here instead of importing fixtures/world/expected.json, which carries the whole answer
// key and would ship deal facts inside the browser bundle. fixture.test.ts checks every value
// against fixtures/world, so the two cannot drift.

import type { AgentRun, Fact, ItemKind, Me } from "./contract.ts";

export const ME: Me = { id: "ben", kind: "person", name: "Ben Carter", tier: "member", firm: "Axe Capital" };

export interface SourceItem {
  id: string;
  kind: ItemKind;
  title: string;
  author: string;
  captured_at: string;
}

export const ITEMS: readonly SourceItem[] = [
  { id: "itm_tmc_q3_letter", kind: "memo", title: "Taylor Mason Capital Q3 2026 shareholder letter (public)", author: "ben", captured_at: "2026-10-21T13:00:00.000Z" },
  { id: "itm_research_draft", kind: "note", title: "Ben Carter: asset management sector note, working draft", author: "ben", captured_at: "2026-10-22T23:10:00.000Z" },
  { id: "itm_chat_research", kind: "chat", title: "Team chat #research, Oct 19–23", author: "ben", captured_at: "2026-10-23T22:00:00.000Z" },
  { id: "itm_chat_general", kind: "chat", title: "Team chat #general, Oct 19–23", author: "wags", captured_at: "2026-10-23T22:00:00.000Z" },
];

/** The groups in Ben's scope, with their display names from world.json. */
export const GROUP_NAMES: Record<string, string> = {
  "research/asset-managers": "Asset manager research",
  "market/public": "Public market",
  "firm/ops": "Firm operations",
};

/** [fact_id, answer-key id, group, labels, statement, source item]. */
const ROWS: readonly [string, string, string, string[], string, string][] = [
  ["fct_570013", "kf_aum", "market/public", ["taylor-mason"], "TMC's assets under management were $38.4 billion at the end of Q3 2026, down 3% from $39.6 billion", "itm_tmc_q3_letter"],
  ["fct_570014", "kf_outflows", "market/public", ["taylor-mason"], "TMC had $0.9 billion of net outflows in Q3, mostly from long/short equity funds", "itm_tmc_q3_letter"],
  ["fct_570015", "kf_fre", "market/public", ["taylor-mason"], "TMC's fee-related earnings were $118 million in Q3", "itm_tmc_q3_letter"],
  ["fct_570016", "kf_buyback", "market/public", ["taylor-mason"], "TMC paused its share buyback in Q3", "itm_tmc_q3_letter"],
  ["fct_570017", "kf_q4_letter_date", "market/public", ["taylor-mason"], "TMC publishes its Q4 investor letter on November 16, 2026", "itm_tmc_q3_letter"],
  ["fct_570018", "kf_sector_outflows", "research/asset-managers", [], "Listed active managers had net outflows for a third straight quarter", "itm_research_draft"],
  ["fct_570019", "kf_peer_multiples", "research/asset-managers", [], "Listed alternative managers trade at 9x to 12x forward earnings", "itm_research_draft"],
  ["fct_57001a", "kf_tmc_multiple", "research/asset-managers", ["taylor-mason"], "TMC trades at about 8.6x 2027 consensus earnings of $4.80", "itm_research_draft"],
  ["fct_57001b", "kf_fee_pressure", "research/asset-managers", [], "Average management fees across listed managers are down about 4 basis points a year", "itm_research_draft"],
  ["fct_57001c", "kf_note_date", "research/asset-managers", [], "Ben's monthly asset manager note goes out on October 30", "itm_research_draft"],
  ["fct_570020", "kf_offsite", "firm/ops", [], "Axe Capital's Q4 offsite moved to December 7–9", "itm_chat_general"],
  ["fct_570021", "kf_expenses", "firm/ops", [], "September expense reports were due October 23", "itm_chat_general"],
  ["fct_570022", "kf_office_closed", "firm/ops", [], "The office is closed on November 2 for a network upgrade", "itm_chat_general"],
];

/** Answer-key id per fact id, for fixture.test.ts. */
export const ANSWER_KEY: Record<string, string> = Object.fromEntries(ROWS.map((r) => [r[0], r[1]]));

export function seedFacts(): Fact[] {
  return ROWS.map(([id, , group, labels, statement, itemId]) => {
    const item = ITEMS.find((i) => i.id === itemId)!;
    return {
      id, statement, group, labels: [...labels], source: itemId, author: item.author,
      happened_at: item.captured_at, learned_at: item.captured_at, status: "hot",
      source_kind: item.kind, source_title: item.title,
    };
  });
}

/** Ben's research analyst (world.json principal `research-analyst`, created by Ben). */
export function seedAgents(): AgentRun[] {
  return [{
    id: "research-analyst", creator: "ben", name: "Research analyst", status: "ready",
    steps: [], files: [], inbox: [],
    task: "Update our asset management sector note.", leave_out: "",
    docs: ["memo", "trends", "compare", "dates"], schedule: "Every Monday, 8:00 AM",
    outputs: [], finished_at: null, fact_count: 0, pending: 0,
  }];
}
