// Renders State into the fixed panels of index.html. Idempotent: run it after every event. Lists
// go through syncList (only changed rows are rebuilt); the hero only rewrites text nodes.
//
// Labels are deliberate: token counts say "est." (≈4 chars/token, see shared/tokens.ts), the
// fake judge and the heuristic distiller say "simulated", and anything we do not know is "—".

import { THRESHOLDS } from "@canon/shared";
import type { DistillEngine, Folder, Grant, HealthResponse } from "@canon/shared";

import { BENCH_URL, benchText } from "./bench.ts";
import type { BenchResult } from "./bench.ts";
import { byId, h, syncList } from "./dom.ts";
import { DASH, clientLabel, fmtCost, fmtMs, fmtTokens, folderTop, pct, relativeTime, truncate } from "./format.ts";
import { lastServed, newestFirst } from "./state.ts";
import type { DeniedRow, DistillRow, FactRow, ServedRow, SessionRow, State } from "./state.ts";

export interface RenderContext {
  server: string;
  /** USD per million tokens, user-supplied. null → cost column shows "—". */
  rate: number | null;
  bench?: BenchResult;
  health?: HealthResponse;
  grants?: Grant[];
  grantsError?: string;
  now: number;
}

export type Connection = "connecting" | "live" | "reconnecting" | "closed";

const ENGINE_LABEL: Record<DistillEngine, string> = { droid: "Factory Droid", claude: "Claude", heuristic: "heuristic" };

/** Rows younger than this get the highlight: they happened while you were watching. */
const FRESH_MS = 4000;

export function renderAll(state: State, ctx: RenderContext): void {
  renderCounter(state, ctx);
  renderSessions(state, ctx);
  renderFacts(state, ctx);
  renderDistills(state, ctx);
  renderAccess(state, ctx);
  renderGrants(ctx);
  renderServer(ctx);
}

export function renderConnection(status: Connection): void {
  byId("conn-dot").className = `dot ${status}`;
  byId("conn-text").textContent = status;
}

export function renderServer(ctx: RenderContext): void {
  byId("server-url").textContent = ctx.server;
  const meta = byId("server-meta");
  const hl = ctx.health;
  if (!hl) {
    meta.textContent = "";
    return;
  }
  const judge = hl.judge === "fake" ? "fake (simulated)" : hl.judge;
  const retriever = hl.retriever === "keyword" ? "keyword (stub)" : hl.retriever;
  meta.textContent = `${hl.facts} facts · ${hl.sessions} sessions · judge ${judge} · retriever ${retriever}`;
}

// ---------------------------------------------------------------------------------------------
// Counter hero: the last context.served

export function renderCounter(state: State, ctx: RenderContext): void {
  const s = lastServed(state);
  const tokens = byId("counter-tokens");
  tokens.textContent = s ? fmtTokens(s.tokens) : DASH;
  tokens.title = s ? `${s.tokens.toLocaleString()} tokens, estimated at ~4 chars per token` : "No canon_context call yet";
  document.title = s ? `Bullwark · ${fmtTokens(s.tokens)} est. tokens` : "Bullwark · live";

  const when = byId("counter-when");
  when.textContent = s ? relativeTime(s.at, ctx.now) : "";
  if (s) when.dataset.at = s.at;
  else delete when.dataset.at;

  const sub = byId("counter-sub");
  if (!s) {
    sub.replaceChildren(h("span", { class: "dim" }, "Waiting for the first canon_context call…"));
  } else {
    sub.replaceChildren(
      h("span", { class: `chip client ${clientClass(s.client)}` }, clientLabel(s.client)),
      h("span", { class: "task", title: s.task }, `“${truncate(s.task, 110)}”`),
      h("span", { class: `verdict ${s.enough ? "ok" : "short"}`, title: "Jev's “enough to answer?” verdict" }, s.enough ? "enough to answer" : "asked for more"),
    );
  }

  const latency = byId("stat-latency");
  latency.textContent = s ? fmtMs(s.latency_ms) : DASH;
  latency.title = s ? "Wall-clock of the canon_context call, measured by the server" : "";
  byId("stat-breakdown").textContent = s ? breakdown(s) : "";

  const kept = byId("stat-kept");
  kept.textContent = s ? `${s.candidates} → ${s.fact_ids.length}` : DASH;
  kept.title = `Retrieval candidates → facts Jev kept (P(relevant) > ${THRESHOLDS.RELEVANT}), within the token budget`;

  const cost = byId("stat-cost");
  if (ctx.rate === null) {
    cost.textContent = DASH;
    cost.title = "set a rate: add ?rate=<USD per 1M tokens> to the URL";
  } else {
    cost.textContent = s ? fmtCost(s.tokens, ctx.rate) : DASH;
    cost.title = `est. tokens × your rate of $${ctx.rate} per 1M tokens`;
  }

  const bench = byId("stat-bench");
  bench.textContent = benchText(ctx.bench);
  bench.title =
    ctx.bench?.status === "ok"
      ? `Bullwark ${fmtTokens(ctx.bench.comparison.canonTokens)} vs full history ${fmtTokens(ctx.bench.comparison.fullTokens)} tokens, from ${BENCH_URL} (bench/results/latest.json)${ctx.bench.comparison.simulated ? ". SIMULATED run: not quotable" : ""}`
      : `Filled from ${BENCH_URL} (bench/results/latest.json) after npm run run -w bench. Never a typed-in number.`;
}

function breakdown(s: ServedRow): string {
  const parts: string[] = [];
  if (s.retrieval_ms !== undefined) parts.push(`retrieval ${fmtMs(s.retrieval_ms)}`);
  if (s.judge_ms !== undefined) parts.push(`judge ${fmtMs(s.judge_ms)}`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------------------------
// Live sessions

export function renderSessions(state: State, ctx: RenderContext): void {
  const rows = newestFirst(state.sessions.values());
  const live = rows.filter((r) => !r.ended).length;
  byId("sessions-count").textContent = rows.length ? `${live} live · ${rows.length} total` : "";
  syncList(
    byId("sessions-list"),
    rows.map((r) => ({
      key: r.id,
      version: [r.messages, r.ended, r.title ?? "", r.at].join("|"),
      fresh: isFresh(r.at, ctx.now),
      build: () => sessionRow(r, ctx),
    })),
    () => h("li", { class: "empty" }, "No sessions yet. Start a Claude Code session, or open ChatGPT with the extension on."),
  );
}

function sessionRow(r: SessionRow, ctx: RenderContext): HTMLElement {
  const status = r.ended ? "ended" : "live";
  return h(
    "li",
    { class: `row session ${status}` },
    h("span", { class: `chip client ${clientClass(r.client)}` }, clientLabel(r.client)),
    h("span", { class: "title", title: r.id }, r.title ?? r.id),
    h("span", { class: "num dim" }, `${r.messages} msg${r.messages === 1 ? "" : "s"}`),
    h("span", { class: `status ${status}` }, status),
    time(r.at, ctx.now),
  );
}

// ---------------------------------------------------------------------------------------------
// Facts feed

export function renderFacts(state: State, ctx: RenderContext): void {
  const rows = newestFirst(state.facts.values());
  const tally = { hot: 0, cold: 0, inbox: 0, retired: 0 };
  for (const r of rows) {
    if (r.retired) tally.retired++;
    else tally[tierOf(r)]++;
  }
  byId("facts-count").textContent = rows.length
    ? `${tally.hot} hot · ${tally.cold} cold · ${tally.inbox} inbox${tally.retired ? ` · ${tally.retired} retired` : ""}`
    : "";
  syncList(
    byId("facts-list"),
    rows.map((r) => ({
      key: r.fact.id,
      version: [r.at, r.fact.updated, r.fact.tier, r.fact.folder, r.fact.statement, r.decision?.action ?? "", r.decision?.judge ?? "", r.retired?.by ?? ""].join("|"),
      fresh: isFresh(r.at, ctx.now),
      build: () => factRow(r, ctx),
    })),
    () => h("li", { class: "empty" }, "No facts yet. The distiller turns captured sessions into facts; Jev decides hot or cold."),
  );
}

function tierOf(r: FactRow): "hot" | "cold" | "inbox" {
  if (r.fact.folder === "inbox") return "inbox";
  return r.decision?.tier ?? r.fact.tier;
}

function factRow(r: FactRow, ctx: RenderContext): HTMLElement {
  const { fact, decision } = r;
  const tier = tierOf(r);
  const keep = decision?.keep_p ?? fact.jev_keep;
  return h(
    "li",
    { class: `row fact${r.retired ? " retired" : ""}` },
    h(
      "div",
      { class: "row-main" },
      folderChip(fact.folder),
      h("span", { class: `chip tier ${tier}` }, tier),
      h("span", { class: "statement", title: fact.detail ?? fact.id }, fact.statement),
    ),
    h(
      "div",
      { class: "row-meta" },
      h("span", { class: "bar", title: `jev_keep ${keep.toFixed(2)} · hot above ${THRESHOLDS.KEEP_HOT}` }, h("i", { style: `width:${pct(keep)}` })),
      h("span", { class: "num dim" }, pct(keep)),
      decision
        ? h("span", { class: `action ${decision.action}` }, decision.action + (decision.supersedes ? ` ${decision.supersedes}` : ""))
        : h("span", { class: "dim" }, "from store"),
      decision ? h("span", { class: "dim" }, `judge ${decision.judge}`) : null,
      decision?.judge === "fake" ? h("span", { class: "tag sim", title: "FakeJudge: no API key, keyword heuristic" }, "simulated") : null,
      h("span", { class: "dim" }, clientLabel(fact.source.client)),
      r.retired ? h("span", { class: "tag retired" }, `retired → ${r.retired.by}`) : null,
      time(r.at, ctx.now),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Distiller

export function renderDistills(state: State, ctx: RenderContext): void {
  const rows = newestFirst(state.distills.values());
  const running = rows.filter((r) => r.status === "running").length;
  byId("distiller-count").textContent = rows.length ? `${running} running · ${rows.length} total` : "";
  syncList(
    byId("distiller-list"),
    rows.map((d) => ({
      key: d.session_id,
      version: [d.status, d.engine, d.facts ?? "", d.duration_ms ?? "", d.plan ?? "", d.at].join("|"),
      fresh: isFresh(d.at, ctx.now),
      build: () => distillRow(d, ctx),
    })),
    () => h("li", { class: "empty" }, "Idle. Each captured session is distilled into facts; Droid's plan shows here."),
  );
}

function distillRow(d: DistillRow, ctx: RenderContext): HTMLElement {
  return h(
    "li",
    { class: `row distill ${d.status}` },
    h(
      "div",
      { class: "row-main" },
      h("span", { class: `chip engine e-${d.engine}` }, ENGINE_LABEL[d.engine]),
      d.engine === "heuristic" ? h("span", { class: "tag sim", title: "No Factory or Anthropic key: regex distiller" }, "simulated") : null,
      h("span", { class: "mono dim", title: d.session_id }, d.session_id),
      h("span", { class: `status ${d.status}` }, d.status === "running" ? "distilling…" : "finished"),
      d.facts !== undefined ? h("span", { class: "num dim" }, `${d.facts} fact${d.facts === 1 ? "" : "s"}`) : null,
      d.duration_ms !== undefined ? h("span", { class: "num dim", title: "measured by the distiller" }, fmtMs(d.duration_ms)) : null,
      time(d.at, ctx.now),
    ),
    d.plan ? h("pre", { class: "plan" }, d.plan) : null,
  );
}

// ---------------------------------------------------------------------------------------------
// Access log

export function renderAccess(state: State, ctx: RenderContext): void {
  byId("access-count").textContent = state.denied.length ? `${state.denied.length} refused` : "";
  syncList(
    byId("access-list"),
    state.denied.map((e) => ({
      key: [e.at, e.client, e.tool, e.folder].join("|"),
      version: "1",
      fresh: isFresh(e.at, ctx.now),
      build: () => deniedRow(e, ctx),
    })),
    () => h("li", { class: "empty" }, "No refusals yet. Ask ChatGPT something that lives in private/ to see one."),
  );
}

function deniedRow(e: DeniedRow, ctx: RenderContext): HTMLElement {
  return h(
    "li",
    { class: "row denied" },
    h("span", { class: `chip client ${clientClass(e.client)}` }, clientLabel(e.client)),
    h("span", { class: "dim" }, "asked"),
    h("code", null, e.tool),
    h("span", { class: "dim" }, "for"),
    folderChip(e.folder),
    h("strong", { class: "refused" }, "refused"),
    time(e.at, ctx.now),
  );
}

// ---------------------------------------------------------------------------------------------
// Grants table

export function renderGrants(ctx: RenderContext): void {
  const body = byId("grants-body");
  if (ctx.grantsError) {
    body.replaceChildren(h("tr", null, h("td", { colspan: 3, class: "empty" }, ctx.grantsError)));
    return;
  }
  if (!ctx.grants) {
    body.replaceChildren(h("tr", null, h("td", { colspan: 3, class: "empty" }, "loading…")));
    return;
  }
  const folders = (list: Folder[]) => (list.length ? list.map((f) => folderChip(f)) : h("span", { class: "dim" }, "none"));
  body.replaceChildren(
    ...ctx.grants.map((g) =>
      h(
        "tr",
        null,
        h("td", null, h("span", { class: `chip client ${clientClass(g.client)}` }, clientLabel(g.client))),
        h("td", null, folders(g.read)),
        h("td", null, folders(g.write)),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Shared bits

function folderChip(folder: string): HTMLElement {
  return h("span", { class: `chip folder f-${folderTop(folder)}` }, folder);
}

function clientClass(client: string): string {
  return `c-${client.replace(/[^a-z0-9-]/gi, "").toLowerCase()}`;
}

function isFresh(iso: string, now: number): boolean {
  const t = Date.parse(iso);
  return !Number.isNaN(t) && now - t < FRESH_MS;
}

function time(iso: string, now: number): HTMLElement {
  return h("time", { class: "time", "data-at": iso, datetime: iso, title: iso }, relativeTime(iso, now));
}

/** Rewrites every relative timestamp; a 30 s ticker calls this so "just now" ages honestly. */
export function refreshTimes(now: number): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-at]")) {
    el.textContent = relativeTime(el.dataset.at, now);
  }
}
