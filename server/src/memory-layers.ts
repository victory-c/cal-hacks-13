// Memory layers: what is top of mind for a person or agent, and what sits in the background.
//
// Every fact inside a scope is in one of three layers:
//
//   top of mind  current, and used or learned recently. A candidate for every request, as before.
//   background   past its date (Jev: no longer current as of today), unused for a long while
//                (recency decay), or moved there by the person. Served only when a request
//                specifically asks about it. Never hidden: the person still sees it, greyed.
//   archive      retired or superseded (tier cold). Never served; unchanged by this module.
//
// What it borrows, and from where:
//   - Bi-temporal validity (Zep / Graphiti): a fact that stopped being true is not deleted; it is
//     marked as no longer current and stays retrievable. Here Jev answers "is this still current
//     as of today?" once a day per fact, with the fact's own dates in front of it, so a past
//     deadline or a finished event drops to the background on the day it passes.
//   - Access-based decay (Mem0's memory decay, Generative Agents' recency): salience is the fact's
//     importance (Jev's keep score) times a recency factor that halves every HALF_LIFE_DAYS since
//     the fact was last used or learned. Every fact served is a use, so what people keep asking
//     about stays top of mind. Decay is a soft floor (0.3), never zero: nothing is forgotten.
//   - Tiers with recall on demand (Letta / MemGPT): background facts are not in the default
//     context, but a request that names them brings them back. Jev decides that too ("does the
//     request specifically ask about this?"), in the same batched ask as relevance.
//   - Top of mind vs background, with a person's own override (ChatGPT memory): each person can
//     keep a memory top of mind or move it to the background; "auto" hands it back to Bullwark.
//
// Layers only ever narrow what a request gets inside a scope. They never widen a scope, and a
// layer decision never names or counts anything outside it.

import type { Fact, Principal, Question } from "@canon/shared";

import { factText } from "./scope-judge.ts";

export const LAYERS = {
  /** Days for the recency factor to halve without a use. */
  HALF_LIFE_DAYS: 14,
  /** Below this salience a fact sits in the background (fresh important facts score ~0.6 to 0.9). */
  BACKGROUND_BELOW: 0.3,
  /** Jev's P(still current) below this: past its date, so background. A neutral answer stays top. */
  STALE_BELOW: 0.4,
  /** Jev's P(the request specifically asks about it) a background fact needs to be served. */
  SPECIFIC: 0.7,
  /** Importance for a fact without a keep score (a moderator's or a seed fact). */
  DEFAULT_IMPORTANCE: 0.7,
} as const;

export type Layer = "top" | "background";
/** Why a fact is in its layer, in the words the member view uses. */
export type LayerReason = "current" | "pinned" | "moved" | "past_date" | "idle";
export type LayerPin = Layer;

export interface LayerUsage {
  uses: number;
  last_used: string;
}

/** Jev's answer to "is this still current?" for one fact, on one day. */
export interface Currency {
  /** YYYY-MM-DD the answer is for. */
  on: string;
  /** P(still current). */
  p: number;
}

/** The layer state ScopeState keeps and persists (world/memory.json). */
export interface LayerState {
  /** `${principal}\u0000${factId}` → uses. Per person and per agent: their own habits. */
  usage: Map<string, LayerUsage>;
  /** `${person}\u0000${factId}` → their override. An agent follows its creator's. */
  pins: Map<string, LayerPin>;
  /** factId → today's currency. About the fact itself, so shared by everyone who holds it. */
  currency: Map<string, Currency>;
}

export function emptyLayerState(): LayerState {
  return { usage: new Map(), pins: new Map(), currency: new Map() };
}

const key = (principal: string, factId: string) => `${principal}\u0000${factId}`;
const DAY_MS = 86_400_000;

/** Whose overrides apply: a person's own; an agent works for its creator, so theirs. */
export function pinOwner(who: Pick<Principal, "id" | "kind" | "created_by">): string {
  return who.kind === "agent" && who.created_by ? who.created_by : who.id;
}

/** YYYY-MM-DD in UTC, the day a currency answer is for. */
export function dayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Importance × recency. Importance is Jev's keep score from triage; recency halves every
 * HALF_LIFE_DAYS since the later of the fact's last use (by this principal) and when it was
 * learned, floored at 0.3 of the importance so decay ranks rather than forgets.
 */
export function salience(fact: Pick<Fact, "jev_keep" | "updated">, usage: LayerUsage | undefined, now: number): number {
  const importance = typeof fact.jev_keep === "number" && Number.isFinite(fact.jev_keep) ? Math.min(1, Math.max(0, fact.jev_keep)) : LAYERS.DEFAULT_IMPORTANCE;
  const learned = Date.parse(`${fact.updated}T00:00:00Z`);
  const used = usage ? Date.parse(usage.last_used) : NaN;
  const touched = Math.max(Number.isFinite(learned) ? learned : now, Number.isFinite(used) ? used : -Infinity);
  const days = Math.max(0, (now - touched) / DAY_MS);
  const recency = 0.5 ** (days / LAYERS.HALF_LIFE_DAYS);
  return importance * (0.3 + 0.7 * recency);
}

export interface LayerView {
  layer: Layer;
  reason: LayerReason;
  uses: number;
  last_used: string | null;
  salience: number;
}

/** One fact's layer for one principal, now. */
export function layerOf(state: LayerState, who: Pick<Principal, "id" | "kind" | "created_by">, fact: Fact, now: number): LayerView {
  const usage = state.usage.get(key(who.id, fact.id));
  const s = salience(fact, usage, now);
  const base = { uses: usage?.uses ?? 0, last_used: usage?.last_used ?? null, salience: Math.round(s * 1000) / 1000 };
  const pin = state.pins.get(key(pinOwner(who), fact.id));
  if (pin === "top") return { ...base, layer: "top", reason: "pinned" };
  if (pin === "background") return { ...base, layer: "background", reason: "moved" };
  const current = state.currency.get(fact.id);
  if (current && current.p < LAYERS.STALE_BELOW) return { ...base, layer: "background", reason: "past_date" };
  if (s < LAYERS.BACKGROUND_BELOW) return { ...base, layer: "background", reason: "idle" };
  return { ...base, layer: "top", reason: "current" };
}

/** Records that these facts were served to `principal`: each is a use, which keeps it top of mind. */
export function recordUse(state: LayerState, principal: string, factIds: readonly string[], now: number): void {
  const at = new Date(now).toISOString();
  for (const id of factIds) {
    const k = key(principal, id);
    state.usage.set(k, { uses: (state.usage.get(k)?.uses ?? 0) + 1, last_used: at });
  }
}

/** A person's override for one fact; "auto" removes it. */
export function setPin(state: LayerState, person: string, factId: string, pin: LayerPin | "auto"): void {
  if (pin === "auto") state.pins.delete(key(person, factId));
  else state.pins.set(key(person, factId), pin);
}

/** The facts whose currency has not been asked about today. */
export function needsCurrency(state: LayerState, facts: readonly Fact[], today: string): Fact[] {
  return facts.filter((f) => state.currency.get(f.id)?.on !== today);
}

/** "Is this still current as of today?", with the fact's own dates in front of the judge. */
export function currentQ(id: string, fact: Fact, today: string): Question {
  const dates = [fact.happened ? `happened ${fact.happened}` : "", `learned ${fact.updated}`].filter(Boolean).join(", ");
  return { id, type: "noul", text: `Today is «${today}». Is this fact still current and worth bringing up, rather than a past deadline, a finished event or a superseded figure? Fact ${fact.id} (${dates}): ${factText(fact)}` };
}

/** "Does the request specifically ask about this?": what brings a background fact back. */
export function specificQ(id: string, fact: Fact, request: string): Question {
  return { id, type: "noul", text: `Request: «${request}». Does the request specifically ask about what this fact covers? Fact ${fact.id}: ${factText(fact)}` };
}

export function serializeLayers(state: LayerState): { usage: [string, LayerUsage][]; pins: [string, LayerPin][]; currency: [string, Currency][] } {
  return { usage: [...state.usage], pins: [...state.pins], currency: [...state.currency] };
}

export function restoreLayers(raw: unknown): LayerState {
  const state = emptyLayerState();
  if (!raw || typeof raw !== "object") return state;
  const r = raw as Record<string, unknown>;
  for (const [k, v] of Array.isArray(r.usage) ? r.usage : []) if (typeof k === "string" && v && typeof v.uses === "number" && typeof v.last_used === "string") state.usage.set(k, { uses: v.uses, last_used: v.last_used });
  for (const [k, v] of Array.isArray(r.pins) ? r.pins : []) if (typeof k === "string" && (v === "top" || v === "background")) state.pins.set(k, v);
  for (const [k, v] of Array.isArray(r.currency) ? r.currency : []) if (typeof k === "string" && v && typeof v.on === "string" && typeof v.p === "number") state.currency.set(k, { on: v.on, p: v.p });
  return state;
}
