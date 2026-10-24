// Dashboard entrypoint: settings → EventSource on /events → reduce → render, plus a REST snapshot
// (facts, grants, health, bench) on every (re)connect so nothing missed during a gap stays missed.
// The server names SSE events by type (`event: fact.saved`), so we listen once per CanonEventType.

import { ROUTES } from "@canon/shared";
import type { CanonEvent, GrantsResponse, HealthResponse, ListFactsResponse } from "@canon/shared";

import { fetchBench } from "./bench.ts";
import { KEYS, resolveRate, resolveServerUrl, safeStorage } from "./config.ts";
import { byId } from "./dom.ts";
import { refreshTimes, renderAll, renderConnection } from "./render.ts";
import type { RenderContext } from "./render.ts";
import { EVENT_TYPES, initFromFacts, initialState, reduce } from "./state.ts";
import type { State } from "./state.ts";

const storage = safeStorage();
const ctx: RenderContext = {
  server: resolveServerUrl(location.search, storage),
  rate: resolveRate(location.search, storage),
  now: Date.now(),
};
let state: State = initialState();
let frame = 0;

/** One render per animation frame: a replay burst of 100 events paints once. */
function scheduleRender(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    ctx.now = Date.now();
    renderAll(state, ctx);
  });
}

function apply(raw: string): void {
  let ev: unknown;
  try {
    ev = JSON.parse(raw);
  } catch {
    console.warn("[web] event is not JSON:", raw.slice(0, 120));
    return;
  }
  if (!isEvent(ev)) {
    console.warn("[web] event without type/at:", raw.slice(0, 120));
    return;
  }
  try {
    state = reduce(state, ev);
  } catch (err) {
    console.warn("[web] could not apply event:", err);
    return;
  }
  scheduleRender();
}

function isEvent(x: unknown): x is CanonEvent {
  return typeof x === "object" && x !== null && typeof (x as { type?: unknown }).type === "string" && typeof (x as { at?: unknown }).at === "string";
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(ctx.server + path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function loadSnapshot(): Promise<void> {
  const [facts, grants, health, bench] = await Promise.allSettled([
    getJson<ListFactsResponse>(ROUTES.facts),
    getJson<GrantsResponse>(ROUTES.grants),
    getJson<HealthResponse>(ROUTES.health),
    // Same-origin: serve.mjs maps /bench/ to bench/results/. The Canon server has no bench route.
    fetchBench(),
  ]);
  if (facts.status === "fulfilled" && Array.isArray(facts.value.facts)) state = initFromFacts(facts.value.facts, state);
  else console.warn("[web] facts snapshot failed:", facts.status === "rejected" ? facts.reason : "response has no facts[]");
  if (grants.status === "fulfilled" && Array.isArray(grants.value.grants)) {
    ctx.grants = grants.value.grants;
    delete ctx.grantsError;
  } else {
    ctx.grantsError = `Could not load ${ROUTES.grants} from ${ctx.server}. Is the server running? (npm run dev -w server)`;
  }
  if (health.status === "fulfilled") ctx.health = health.value;
  if (bench.status === "fulfilled") ctx.bench = bench.value;
  scheduleRender();
}

function connect(): void {
  renderConnection("connecting");
  const es = new EventSource(ctx.server + ROUTES.events);
  for (const type of EVENT_TYPES) es.addEventListener(type, (ev) => apply((ev as MessageEvent<string>).data));
  // An event sent without an `event:` line still carries `type` in its JSON.
  es.addEventListener("message", (ev) => apply((ev as MessageEvent<string>).data));
  es.onopen = () => {
    renderConnection("live");
    void loadSnapshot();
  };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      // The browser stops retrying after a non-200 or a wrong content-type. We do not.
      renderConnection("closed");
      setTimeout(connect, 3000);
    } else {
      renderConnection("reconnecting");
    }
  };
}

function wireHeader(): void {
  byId<HTMLButtonElement>("server-url").addEventListener("click", () => {
    const next = prompt("Canon server URL", ctx.server);
    if (!next || next === ctx.server) return;
    storage.setItem(KEYS.server, next);
    // Reload through the query so resolveServerUrl() validates and remembers it.
    location.href = `${location.pathname}?server=${encodeURIComponent(next)}`;
  });
  const resume = byId<HTMLAnchorElement>("resume-link");
  resume.href = `./resume.html?server=${encodeURIComponent(ctx.server)}`;
}

wireHeader();
renderAll(state, ctx);
connect();
setInterval(() => refreshTimes(Date.now()), 30_000);
