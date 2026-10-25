// Member view entrypoint: Ben's agents, memory and feed. Data comes from a MemberApi: the
// in-browser mock by default, or Canon with `?data=canon&token=<token>` (and `?server=` as on the
// dashboard). Canon decides what exists; this page only lays it out (integration contract rule 1).

import { DOC_TYPES, SCHEDULES } from "./member/contract.ts";
import type { AgentBody, AgentRun, DocType, Fact, Me, MemberApi, MemberEvent, Schedule } from "./member/contract.ts";
import { CanonClient } from "./member/canon.ts";
import { MockCanon } from "./member/mock.ts";
import {
  ALL_GROUPS, ALL_SOURCES, NO_FILTERS, SORTS, STATUS_LABELS, agentPlanLine, agentStatusLine, countShown, feedText,
  filtersActive, fmtDay, groupLabel, groupOrder, isBusy, kindLabel, plural, sourceTitle, viewMemory,
} from "./member/logic.ts";
import type { Filters, Sort } from "./member/logic.ts";
import { relativeTime } from "./format.ts";
import { resolveServerUrl, safeStorage } from "./config.ts";
import { byId, h, syncList } from "./dom.ts";

const storage = safeStorage();
const TOKEN_KEY = "canon.memberToken";

function pickApi(): MemberApi {
  const q = new URLSearchParams(location.search);
  if (q.get("data") !== "canon") return new MockCanon();
  const fromQuery = q.get("token");
  if (fromQuery) {
    storage.setItem(TOKEN_KEY, fromQuery);
    q.delete("token"); // keep the token out of the address bar and history
    history.replaceState(null, "", `${location.pathname}?${q}`);
  }
  return new CanonClient(resolveServerUrl(location.search, storage), storage.getItem(TOKEN_KEY) ?? "");
}

const api = pickApi();

interface FeedEntry { key: string; at: string; text: string; fresh: boolean }

const state = {
  me: null as Me | null,
  names: {} as Record<string, string>,
  facts: [] as Fact[],
  agents: [] as AgentRun[],
  feed: [] as FeedEntry[],
  filters: { ...NO_FILTERS } as Filters,
  editing: null as string | null,
  openDocs: new Set<string>(),
  agentForm: null as null | "new" | string,
  replaying: true,
};

const el = {
  firm: byId("firm"), greeting: byId("greeting"), notice: byId("notice"), modeLine: byId("mode-line"),
  agents: byId<HTMLUListElement>("agents"), newAgent: byId<HTMLButtonElement>("new-agent"),
  agentForm: byId<HTMLFormElement>("agent-form"), agentFormTitle: byId("agent-form-title"),
  aName: byId<HTMLInputElement>("a-name"), aTask: byId<HTMLTextAreaElement>("a-task"), aLeave: byId<HTMLInputElement>("a-leave"),
  docChoices: byId("doc-choices"), aSchedule: byId<HTMLSelectElement>("a-schedule"),
  deleteAgent: byId<HTMLButtonElement>("delete-agent"), cancelAgent: byId<HTMLButtonElement>("cancel-agent"),
  toggleFilters: byId<HTMLButtonElement>("toggle-filters"), filters: byId("filters"),
  fKeyword: byId<HTMLInputElement>("f-keyword"), fGroup: byId<HTMLSelectElement>("f-group"),
  fSource: byId<HTMLSelectElement>("f-source"), fSort: byId<HTMLSelectElement>("f-sort"),
  showLine: byId("show-line"), clearFilters: byId<HTMLButtonElement>("clear-filters"),
  toggleAdd: byId<HTMLButtonElement>("toggle-add"), addForm: byId<HTMLFormElement>("add-form"),
  nKind: byId<HTMLSelectElement>("n-kind"), nSource: byId<HTMLInputElement>("n-source"), nText: byId<HTMLTextAreaElement>("n-text"),
  cancelAdd: byId<HTMLButtonElement>("cancel-add"), memory: byId("memory"), feed: byId<HTMLUListElement>("feed"),
};

// ---------- small helpers

let noticeTimer = 0;
function notify(message: string): void {
  el.notice.textContent = message;
  el.notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => (el.notice.hidden = true), 6000);
}

type Outcome<T> = { ok: true; value: T } | { ok: false };

/** Runs a command; a failure shows in the notice line instead of vanishing. */
async function attempt<T>(what: string, fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    notify(`Couldn't ${what}: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false };
  }
}

function addFeed(key: string, at: string, text: string): void {
  if (state.feed.some((f) => f.key === key)) return; // a replay lands on the entry it already has
  state.feed.unshift({ key, at, text, fresh: !state.replaying });
  state.feed.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  state.feed.length = Math.min(state.feed.length, 200);
}

function local(text: string): void {
  const at = new Date().toISOString();
  addFeed(`local:${at}:${text}`, at, text);
  renderFeed();
}

function upsertAgent(run: AgentRun): void {
  const i = state.agents.findIndex((a) => a.id === run.id);
  if (i === -1) state.agents.push(run);
  else state.agents[i] = run;
}

async function refreshFacts(): Promise<void> {
  const res = await attempt("load your memory", () => api.facts());
  if (res.ok) state.facts = res.value;
  renderMemory();
}

async function refreshAgents(): Promise<void> {
  const res = await attempt("load your agents", () => api.agents());
  if (res.ok) state.agents = res.value;
  renderAgents();
}

// ---------- events

function onEvent(ev: MemberEvent): void {
  const meId = state.me?.id;
  switch (ev.type) {
    case "fact.saved":
      if (!state.facts.some((f) => f.id === ev.fact.id)) state.facts.unshift(ev.fact);
      renderMemory();
      break;
    case "scope.changed":
      if (ev.principal === meId) void refreshFacts();
      else void refreshAgents();
      break;
    case "scope.build":
      if (ev.stage === "done") void refreshAgents();
      break;
    case "item.captured":
      break;
    default:
      upsertAgent(ev.run);
      renderAgents();
  }
  const text = feedText(ev, (id) => state.agents.find((a) => a.id === id)?.name);
  if (text) {
    const id = "fact" in ev ? ev.fact.id : "run" in ev ? `${ev.run.id}:${ev.run.status}:${ev.run.steps.length}` : "item_id" in ev ? ev.item_id : "build_id" in ev ? ev.build_id : "";
    addFeed(`${ev.type}:${id}:${ev.at}`, ev.at, text);
    renderFeed();
  }
}

// ---------- agents

function agentCard(run: AgentRun): HTMLElement {
  const busy = isBusy(run);
  const dotClass = busy ? "dot on" : run.status === "done" ? "dot ok" : "dot";
  return h("li", { class: "agent" },
    h("div", { class: "ahead" },
      h("div", { style: "flex: 1; min-width: 220px" },
        h("div", { class: "aname" }, run.name),
        h("div", { class: "atask" }, run.task)),
      h("span", { class: run.status === "failed" ? "pill failed" : "pill" }, STATUS_LABELS[run.status]),
      run.status === "running"
        ? h("button", { class: "ghost", type: "button", onclick: () => void attempt("stop the agent", () => api.stopAgent(run.id)) }, "Stop")
        : h("button", { class: "btn", type: "button", disabled: busy, onclick: () => void attempt("start the agent", () => api.runAgent(run.id)) }, "Run"),
      h("button", { class: "mini", type: "button", "aria-label": `Edit ${run.name}`, onclick: () => openAgentForm(run.id) }, "Edit")),
    h("div", { class: "live", "aria-live": "polite" }, h("span", { class: dotClass, "aria-hidden": "true" }), agentStatusLine(run, Date.now())),
    h("div", { class: "hint plan" }, agentPlanLine(run), ` · ${plural(run.fact_count, "memory", "memories")}`),
    run.outputs.length > 0 && h("div", { class: "output" },
      h("div", { class: "bar", style: "align-items: center" },
        h("h3", { class: "sub" }, "Output"),
        h("span", { class: "hint" }, run.finished_at ? `Finished ${relativeTime(run.finished_at)}` : "")),
      h("ul", { class: "list" }, run.outputs.map((o) => {
        const key = `${run.id}:${o.type}`;
        const open = state.openDocs.has(key);
        return h("li", { class: "docrow" },
          h("div", { class: "ahead" },
            h("span", { class: "doctitle" }, o.title),
            h("span", { class: "hint" }, plural(o.lines.length, "line")),
            h("button", {
              class: "mini", type: "button", "aria-expanded": String(open),
              onclick: () => { if (open) state.openDocs.delete(key); else state.openDocs.add(key); renderAgents(); },
            }, open ? "Close" : "Open")),
          open && h("div", { class: "preview" },
            h("ul", null, o.lines.map((l) => h("li", null, l.text, l.source && h("span", { class: "from" }, `from ${l.source}`)))),
            h("div", { class: "hint", style: "margin-top: 8px" }, api.mode === "mock" ? "Simulated draft built from this agent’s memory" : "Written from this agent’s memory")));
      }))));
}

function renderAgents(): void {
  syncList(el.agents, state.agents.map((run) => {
    const open = run.outputs.map((o) => state.openDocs.has(`${run.id}:${o.type}`) ? "1" : "0").join("");
    return { key: run.id, version: `${JSON.stringify(run)}|${open}|${agentStatusLine(run, Date.now())}`, build: () => agentCard(run) };
  }), () => h("li", { class: "empty" }, "No agents yet. Create one to turn your memory into summaries, plans and drafts."));
}

function buildDocChoices(): void {
  el.docChoices.replaceChildren(...DOC_TYPES.map((d) =>
    h("label", { class: "doc" },
      h("input", { type: "checkbox", name: "docs", value: d.id }),
      h("span", null, h("b", null, d.label), h("span", { class: "hint" }, d.hint)))));
  el.aSchedule.replaceChildren(...SCHEDULES.map((s) => h("option", { value: s }, s)));
}

function openAgentForm(target: "new" | string): void {
  const run = target === "new" ? null : state.agents.find((a) => a.id === target);
  state.agentForm = target;
  el.agentFormTitle.textContent = run ? `Edit ${run.name}` : "New agent";
  el.aName.value = run?.name ?? "";
  el.aTask.value = run?.task ?? "";
  el.aLeave.value = run?.leave_out ?? "";
  const docs = new Set<string>(run?.docs ?? ["summary"]);
  for (const box of el.docChoices.querySelectorAll<HTMLInputElement>("input[name=docs]")) box.checked = docs.has(box.value);
  el.aSchedule.value = run?.schedule ?? SCHEDULES[0];
  el.deleteAgent.hidden = !run;
  el.agentForm.hidden = false;
  el.aName.focus();
}

function closeAgentForm(): void {
  state.agentForm = null;
  el.agentForm.hidden = true;
}

async function saveAgent(e: Event): Promise<void> {
  e.preventDefault();
  const name = el.aName.value.trim(), task = el.aTask.value.trim();
  if (!name || !task) return;
  const leave = el.aLeave.value.trim();
  const docs = [...el.docChoices.querySelectorAll<HTMLInputElement>("input[name=docs]:checked")].map((b) => b.value as DocType);
  const body: AgentBody = { name, task, exclusions: { groups: [], labels: [], text: leave ? [leave] : [] }, docs, schedule: el.aSchedule.value as Schedule };
  const target = state.agentForm;
  if (target === "new") {
    if ((await attempt("create the agent", () => api.createAgent(body))).ok) local(`You created an agent: ${name}`);
  } else if (target) {
    if ((await attempt("save the agent", () => api.updateAgent(target, body))).ok) local(`You updated an agent: ${name}`);
  }
  closeAgentForm();
  await refreshAgents();
}

async function deleteAgent(): Promise<void> {
  const target = state.agentForm;
  const run = state.agents.find((a) => a.id === target);
  if (!run) return;
  if (!confirm(`Delete ${run.name}? Its documents go with it.`)) return;
  if ((await attempt("delete the agent", () => api.deleteAgent(run.id))).ok) {
    state.agents = state.agents.filter((a) => a.id !== run.id);
    local(`You deleted ${run.name}`);
  }
  closeAgentForm();
  renderAgents();
}

// ---------- memory

function fillSelect(select: HTMLSelectElement, options: readonly string[], value: string): void {
  const same = select.options.length === options.length && options.every((o, i) => select.options[i]!.value === o);
  if (!same) select.replaceChildren(...options.map((o) => h("option", { value: o }, o)));
  select.value = options.includes(value) ? value : options[0]!;
}

function memoryRow(f: Fact, index: number): HTMLElement {
  const cls = `mem ${index >= 0 ? `g${Math.min(index, 3)}` : ""}`;
  if (state.editing === f.id) {
    const box = h("textarea", { rows: 2, "aria-label": "Memory" }) as HTMLTextAreaElement;
    box.value = f.statement;
    queueMicrotask(() => box.focus());
    return h("li", { class: cls },
      h("form", {
        class: "panel", "aria-label": "Edit memory",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const statement = box.value.trim();
          if (!statement || statement === f.statement) { state.editing = null; renderMemory(); return; }
          const saved = await attempt("save the memory", () => api.editFact(f.id, statement));
          if (saved.ok) { Object.assign(f, saved.value); local(`You edited a memory: ${statement}`); }
          state.editing = null;
          renderMemory();
        },
      },
        h("label", { class: "fld" }, "Memory", box),
        h("div", { class: "row" },
          h("button", {
            class: "danger", type: "button",
            onclick: async () => {
              if (!(await attempt("retire the memory", () => api.retireFact(f.id))).ok) return;
              state.facts = state.facts.filter((x) => x.id !== f.id);
              state.editing = null;
              local(`You retired a memory: ${f.statement}`);
              renderMemory();
              void refreshAgents();
            },
          }, "Retire"),
          h("button", { class: "ghost", type: "button", onclick: () => { state.editing = null; renderMemory(); } }, "Cancel"),
          h("button", { class: "btn", type: "submit" }, "Save")),
        h("div", { class: "hint" }, "Retiring takes it out of your memory and your agents’ memory. It stays in the archive.")));
  }
  return h("li", { class: cls },
    h("div", { class: "fact" },
      h("span", { class: "st" },
        h("span", { class: "kind" }, kindLabel(f.source_kind)),
        f.statement,
        h("span", { class: "trail" }, sourceTitle(f))),
      h("span", { class: "date" }, fmtDay(f.learned_at)),
      h("button", { class: "mini", type: "button", "aria-label": "Edit memory", onclick: () => { state.editing = f.id; renderMemory(); } }, "Edit")));
}

function renderMemory(): void {
  const order = groupOrder(state.facts);
  const groupNames = order.map((g) => groupLabel(g, state.names));
  const sources = [...new Set(state.facts.map(sourceTitle))];
  fillSelect(el.fGroup, [ALL_GROUPS, ...groupNames], state.filters.group);
  fillSelect(el.fSource, [ALL_SOURCES, ...sources], state.filters.source);
  fillSelect(el.fSort, SORTS, state.filters.sort);
  state.filters.group = el.fGroup.value;
  state.filters.source = el.fSource.value;

  const groups = viewMemory(state.facts, state.filters, state.names, order);
  const shown = countShown(groups), total = state.facts.filter((f) => f.status === "hot").length;
  el.showLine.textContent = shown === total ? `All ${plural(total, "memory", "memories")}` : `Showing ${shown} of ${plural(total, "memory", "memories")}`;
  const active = filtersActive(state.filters);
  el.clearFilters.hidden = !active;
  const open = !el.filters.hidden;
  el.toggleFilters.textContent = open ? "Hide filters" : active ? "Filter (on)" : "Filter";
  el.toggleFilters.setAttribute("aria-expanded", String(open));

  // Sections keyed by group so an open edit box survives a fact arriving elsewhere.
  syncList(el.memory, groups.map((g) => ({
    key: `grp:${g.label}`,
    version: `grp:${g.label}`,
    build: () => h("section", null, g.label && h("h3", { class: "grp" }, g.label), h("ul", { class: "list" })),
  })), () => h("p", { class: "empty" }, total ? "Nothing in your memory matches these filters." : "Your memory is empty. Add something to get started."));
  groups.forEach((g, i) => {
    const ul = el.memory.children[i]?.querySelector("ul");
    if (!ul) return;
    syncList(ul as HTMLElement, g.facts.map((f) => ({
      key: f.id,
      version: `${f.statement}|${f.learned_at}|${g.index}|${state.editing === f.id}`,
      build: () => memoryRow(f, g.index),
      fresh: Date.now() - Date.parse(f.learned_at) < 10_000,
    })));
  });
}

async function addItem(e: Event): Promise<void> {
  e.preventDefault();
  const text = el.nText.value.trim();
  if (!text) return;
  const done = await attempt("add it", () => api.addItem({ kind: el.nKind.value as "note", source: el.nSource.value.trim(), text }));
  if (!done.ok) return;
  el.nText.value = "";
  el.nSource.value = "";
  el.addForm.hidden = true;
  el.toggleAdd.setAttribute("aria-expanded", "false");
}

// ---------- feed

function renderFeed(): void {
  const now = Date.now();
  syncList(el.feed, state.feed.map((f) => ({
    key: f.key,
    version: `${f.text}|${relativeTime(f.at, now)}`,
    fresh: f.fresh,
    build: () => h("li", null, h("span", { class: "when" }, relativeTime(f.at, now)), f.text),
  })), () => h("li", { class: "empty" }, "Nothing yet."));
  for (const f of state.feed) f.fresh = false;
}

// ---------- wiring

function wire(): void {
  buildDocChoices();
  el.newAgent.addEventListener("click", () => openAgentForm("new"));
  el.cancelAgent.addEventListener("click", closeAgentForm);
  el.deleteAgent.addEventListener("click", () => void deleteAgent());
  el.agentForm.addEventListener("submit", (e) => void saveAgent(e));

  el.toggleFilters.addEventListener("click", () => {
    el.filters.hidden = !el.filters.hidden;
    renderMemory();
    if (!el.filters.hidden) el.fKeyword.focus();
  });
  el.fKeyword.addEventListener("input", () => { state.filters.keyword = el.fKeyword.value; renderMemory(); });
  el.fGroup.addEventListener("change", () => { state.filters.group = el.fGroup.value; renderMemory(); });
  el.fSource.addEventListener("change", () => { state.filters.source = el.fSource.value; renderMemory(); });
  el.fSort.addEventListener("change", () => { state.filters.sort = el.fSort.value as Sort; renderMemory(); });
  el.clearFilters.addEventListener("click", () => {
    state.filters = { ...NO_FILTERS };
    el.fKeyword.value = "";
    renderMemory();
  });

  el.toggleAdd.addEventListener("click", () => {
    el.addForm.hidden = !el.addForm.hidden;
    el.toggleAdd.setAttribute("aria-expanded", String(!el.addForm.hidden));
    if (!el.addForm.hidden) el.nText.focus();
  });
  el.cancelAdd.addEventListener("click", () => { el.addForm.hidden = true; el.toggleAdd.setAttribute("aria-expanded", "false"); });
  el.addForm.addEventListener("submit", (e) => void addItem(e));

  // Relative times ("2 min ago") and idle agent lines age without events.
  setInterval(() => { renderFeed(); renderAgents(); }, 30_000);
}

async function start(): Promise<void> {
  wire();
  el.modeLine.textContent = api.mode === "mock"
    ? "Demo data: Ben Kim’s view of the synthetic Axe Capital world. Triage, relevance and agent runs are simulated in the browser."
    : "Connected to Canon.";
  const res = await attempt("load your profile", () => api.me());
  if (!res.ok) return;
  const me = res.value;
  state.me = me;
  el.greeting.textContent = `Hi, ${me.name}`;
  el.firm.textContent = me.firm ?? "";
  document.title = me.firm ? `Bullwark · ${me.firm}` : "Bullwark";
  const names = await attempt("load group names", () => api.groupNames());
  state.names = names.ok ? names.value : {};
  await Promise.all([refreshFacts(), refreshAgents()]);
  api.subscribe(onEvent, (s) => {
    if (s === "reconnecting") notify("Lost the live connection; retrying…");
    if (s === "live" && !state.replaying) void Promise.all([refreshFacts(), refreshAgents()]);
  });
  state.replaying = false;
  renderFeed();
}

void start();
