// OfflineClient: an in-process stand-in for Henry's v2 routes over a tiny synthetic world, so
// `npm run dispatch -w distiller -- --by dan "<task>"` runs end to end with no server and no keys.
// Everything here is SIMULATED and says so: the permission filter, the keyword relevance, the
// code-only exit check. The real ones live in server/ (lane A). The walls logic reuses routing.ts
// (canSee / hasLiveEntitlement), so the offline demo applies the same deny-by-default rule.
//
// All data is synthetic: Harbor Lane Partners, Project Falcon (its client acquiring Nimbus
// Logistics), Maya in compliance, Dan the banker on Falcon, Priya in research, Leo on the desk.

import { randomBytes } from "node:crypto";

import { NEUTRAL_REFUSALS, PUBLIC_WALL, cutToBudget, estimateTokens, factTokens, isDealWall } from "@canon/shared";
import type {
  ContextFact,
  Deal,
  DealStatus,
  Entitlement,
  ExitCheckBody,
  ExitCheckResult,
  Fact,
  HandoffBody,
  HandoffCandidate,
  HandoffResult,
  Principal,
  Wall,
} from "@canon/shared";
import type { DispatchClient, RelayedEvent } from "./client.ts";
import { canSee, hasLiveEntitlement } from "./routing.ts";

export interface OfflineWorld {
  deals: Deal[];
  entitlements: Entitlement[];
  principals: Principal[];
  facts: Fact[];
}

const SRC = (session: string, client = "ingest") => ({ client, session });
const DAY = "2026-10-24";

/** Harbor Lane Partners on the morning of the demo. Synthetic. */
export function demoWorld(): OfflineWorld {
  return {
    deals: [
      {
        id: "deal_falcon",
        code_name: "Project Falcon",
        aliases: ["Falcon", "Nimbus"],
        companies: ["Nimbus Logistics"],
        status: "confidential",
        status_changed_at: "2026-10-20T09:00:00Z",
      },
    ],
    entitlements: [{ principal: "dan", deal: "deal_falcon", granted_by: "maya", granted_at: "2026-10-20T09:00:00Z", reason: "Banker on Project Falcon" }],
    principals: [
      { id: "maya", kind: "person", name: "Maya", desk: "compliance" },
      { id: "dan", kind: "person", name: "Dan", desk: "deal" },
      { id: "priya", kind: "person", name: "Priya", desk: "research" },
      { id: "leo", kind: "person", name: "Leo", desk: "trading" },
    ],
    facts: [
      fact("fct_fa1c0001", "deal_falcon", "Project Falcon: Harbor Lane's client plans to acquire Nimbus Logistics; the board reviews the approach next week.", "ses_fa1c0001"),
      fact("fct_fa1c0002", "deal_falcon", "Falcon valuation work uses public logistics comparables as the base case; Dan keeps the model with the deal team.", "ses_fa1c0001"),
      fact("fct_fa1c0003", "deal_falcon", "Dan owns the Falcon board materials; Maya reviews them before they go out.", "ses_fa1c0002", "chatgpt"),
      fact("fct_0b1c0001", PUBLIC_WALL, "Harbor Lane's logistics sector note covers freight demand, fuel costs and warehouse capacity.", "ses_0b1c0001"),
      fact("fct_0b1c0002", PUBLIC_WALL, "Sector notes follow the house template: summary, drivers, risks, what to watch.", "ses_0b1c0001"),
      fact("fct_0b1c0003", PUBLIC_WALL, "Priya owns the monthly logistics sector note in research.", "ses_0b1c0002"),
      // Unlabeled (the lawyers' email, held for review): reaches nobody but compliance.
      fact("fct_0e1c0001", undefined, "Outside counsel's email asks that the deal terms be forwarded to research.", "ses_0e1c0001"),
    ],
  };
}

function fact(id: string, wall: Wall | undefined, statement: string, session: string, client = "ingest"): Fact {
  const f: Fact = { id, statement, folder: "team", tier: "hot", jev_keep: 0.8, source: SRC(session, client), updated: DAY };
  if (wall) f.wall = wall;
  return f;
}

const hex = () => randomBytes(4).toString("hex");

export class OfflineClient implements DispatchClient {
  readonly simulated = true;
  readonly world: OfflineWorld;
  readonly events: RelayedEvent[] = [];
  readonly handoffs: Array<{ body: HandoffBody; result: HandoffResult }> = [];
  readonly exitChecks: Array<{ body: ExitCheckBody; result: ExitCheckResult }> = [];

  constructor(world: OfflineWorld = demoWorld()) {
    this.world = world;
  }

  /** Compliance's button, offline: returns the change for routing. */
  setDealStatus(dealId: string, to: DealStatus): { deal: string; from: DealStatus; to: DealStatus } {
    const deal = this.world.deals.find((d) => d.id === dealId);
    if (!deal) throw new Error(`offline world has no deal ${dealId}`);
    const from = deal.status;
    deal.status = to;
    deal.status_changed_at = new Date().toISOString();
    return { deal: dealId, from, to };
  }

  async getDeals(): Promise<Deal[]> {
    return structuredClone(this.world.deals);
  }

  async getEntitlements(): Promise<Entitlement[]> {
    return structuredClone(this.world.entitlements);
  }

  async registerPrincipal(principal: Principal): Promise<void> {
    const i = this.world.principals.findIndex((p) => p.id === principal.id);
    if (i >= 0) this.world.principals[i] = principal;
    else this.world.principals.push(principal);
  }

  async publishEvent(event: RelayedEvent): Promise<void> {
    this.events.push(event);
  }

  /** Simulated pipeline: restricted-list refusal → permission filter → keyword relevance → budget. */
  async handoff(body: HandoffBody): Promise<HandoffResult> {
    const t0 = performance.now();
    const who = this.world.principals.find((p) => p.id === body.principal);
    const audit_id = `aud_${hex()}`;
    if (!who) {
      const result: HandoffResult = { refused: true, message: NEUTRAL_REFUSALS.watch_list, audit_id };
      this.handoffs.push({ body, result });
      return result;
    }
    const view = { deals: this.world.deals, entitlements: this.world.entitlements };
    const viewer = this.viewer(who);
    // A public-side request naming a restricted company is refused with the rule, nothing else.
    const restricted = this.world.deals.find(
      (d) => d.status !== "announced" && !viewer.cleared(d.id) && d.companies.some((c) => wordIn(body.task, c)),
    );
    if (restricted) {
      const result: HandoffResult = { refused: true, message: NEUTRAL_REFUSALS.restricted_list, audit_id };
      this.handoffs.push({ body, result });
      return result;
    }

    const candidates: HandoffCandidate[] = [];
    const scored: Array<{ f: Fact; score: number }> = [];
    for (const f of this.world.facts.filter((x) => x.tier === "hot")) {
      if (!viewer.sees(f.wall, view)) {
        candidates.push({ fact_id: f.id, wall: f.wall ?? "unlabeled", cut: "wall" });
        continue;
      }
      scored.push({ f, score: overlap(body.task, f.statement) });
    }
    scored.sort((a, b) => b.score - a.score);
    const relevant = scored.filter((s) => s.score > 0);
    for (const s of scored.filter((x) => x.score === 0)) candidates.push({ fact_id: s.f.id, wall: s.f.wall ?? "unlabeled", cut: "relevance", p: 0.2 });
    const budget = body.budget_tokens ?? 1500;
    const { kept } = cutToBudget(
      relevant.map((s) => s.f),
      budget,
    );
    for (const s of relevant) {
      const isKept = kept.includes(s.f);
      candidates.push({ fact_id: s.f.id, wall: s.f.wall ?? "unlabeled", cut: isKept ? null : "budget", p: 0.8, tokens: factTokens(s.f) });
    }
    const facts: ContextFact[] = kept.map((f) => ({
      id: f.id,
      statement: f.statement,
      folder: f.folder,
      updated: f.updated,
      source: f.source,
      relevance: 0.8,
      ...(f.wall ? { wall: f.wall } : {}),
    }));
    const profile = `${who.name} (${who.kind}, ${who.desk} desk). Side: ${viewer.side}. Cleared for: ${viewer.clearances.join(", ") || "public only"}. Simulated offline profile.`;
    const result: HandoffResult = {
      refused: false,
      facts,
      profile,
      tokens: facts.reduce((n, f) => n + factTokens(f), 0) + estimateTokens(profile),
      latency_ms: Math.round(performance.now() - t0),
      inject_nothing: facts.length === 0,
      candidates,
      audit_id,
    };
    this.handoffs.push({ body, result });
    return result;
  }

  /** Simulated, code only: names of deals this principal is not cleared for (no Jev offline). */
  async exitCheck(body: ExitCheckBody): Promise<ExitCheckResult> {
    const who = this.world.principals.find((p) => p.id === body.principal);
    const viewer = who ? this.viewer(who) : undefined;
    const hits: string[] = [];
    for (const d of this.world.deals) {
      if (d.status === "announced") continue;
      if (viewer?.cleared(d.id) && (viewer.side === d.id || who?.kind === "person")) continue;
      for (const name of [d.code_name, ...d.aliases, ...d.companies]) if (wordIn(body.text, name)) hits.push(name);
    }
    const result: ExitCheckResult = { blocked: hits.length > 0, hits: [...new Set(hits)] };
    if (result.blocked) result.review_id = `rev_${hex()}`;
    this.exitChecks.push({ body, result });
    return result;
  }

  /** The deny-by-default view for a person or an agent. */
  private viewer(p: Principal) {
    const ents = this.world.entitlements;
    if (p.kind === "agent") {
      const run = { side: p.side ?? PUBLIC_WALL, acts_for: p.acts_for ?? "" };
      return {
        side: run.side,
        clearances: isDealWall(run.side) && hasLiveEntitlement(ents, run.acts_for, run.side) ? [run.side] : [],
        cleared: (deal: string) => run.side === deal && hasLiveEntitlement(ents, run.acts_for, deal),
        sees: (wall: Wall | undefined, view: Parameters<typeof canSee>[2]) => canSee(run, wall, view),
      };
    }
    const cleared = (deal: string) => p.desk === "compliance" || hasLiveEntitlement(ents, p.id, deal);
    return {
      side: p.desk === "deal" ? "deal side" : "public",
      clearances: this.world.deals.filter((d) => cleared(d.id)).map((d) => d.id),
      cleared,
      sees: (wall: Wall | undefined, view: Parameters<typeof canSee>[2]) =>
        wall === PUBLIC_WALL || (wall !== undefined && (view.deals.find((d) => d.id === wall)?.status === "announced" || cleared(wall))),
    };
  }
}

const STOP = new Set(["the", "and", "for", "our", "with", "this", "that", "from", "into", "short", "update", "prep", "write", "draft"]);

function words(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !STOP.has(w)));
}

function overlap(a: string, b: string): number {
  const wb = words(b);
  let n = 0;
  for (const w of words(a)) if (wb.has(w)) n++;
  return n;
}

function wordIn(text: string, name: string): boolean {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return escaped !== "" && new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}
