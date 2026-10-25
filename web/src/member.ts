// Member view entrypoint: Ben's agents, memory and feed. Data comes from a MemberApi: the
// Canon by default, or labelled fixtures with `?data=mock` (and `?server=` as on the
// dashboard). Canon decides what exists; this page only lays it out (integration contract rule 1).

import { DOC_TYPES, SCHEDULES } from "./member/contract.ts";
import type { AgentBody, AgentDocument, AgentRun, DocType, Fact, Me, MemberApi, MemberEvent, Schedule } from "./member/contract.ts";
import { CanonClient } from "./member/canon.ts";
import { MockCanon } from "./member/mock.ts";
import {
  ALL_GROUPS, ALL_SOURCES, NO_FILTERS, SORTS, STATUS_LABELS, agentPhase, agentPlanLine, agentStatusLine, boldRuns, countShown,
  docBlocks, elapsed, feedText, filtersActive, fmtDay, friendlyStep, groupLabel, groupOrder, isBusy, kindLabel, layerOfFact,
  layerReasonLabel, plural, stripFactRefs, usageLine,
  sourceTitle, viewMemory,
} from "./member/logic.ts";
import type { Filters, Sort } from "./member/logic.ts";
import { relativeTime } from "./format.ts";
import { normalizeUrl, resolveServerUrl, safeStorage } from "./config.ts";
import { byId, h, syncList } from "./dom.ts";

const storage = safeStorage();
const TOKEN_KEY = "canon.memberToken";

function pickApi(): MemberApi {
  const q = new URLSearchParams(location.search);
  if (q.get("data") === "mock") return new MockCanon();
  const fromQuery = q.get("token");
  if (fromQuery) {
    storage.setItem(TOKEN_KEY, fromQuery);
    q.set("auth", "token");
    q.delete("token"); // keep the token out of the address bar and history
    history.replaceState(null, "", `${location.pathname}?${q}`);
  }
  const token = q.get("auth") === "token" ? storage.getItem(TOKEN_KEY) ?? "" : "";
  const server = q.has("server") || token ? resolveServerUrl(q.toString(), storage, location.origin) : location.origin;
  return new CanonClient(server, token);
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
  /** What the member has typed into each agent's "give it something to do" box. */
  assign: new Map<string, string>(),
  /** Which memory layer the list shows. Top of mind first, like a memory manager. */
  layerView: "top" as "top" | "background" | "all",
  /** When the member last pressed Run: the page checks on the agent until it reports in. */
  kicked: 0,
  replaying: true,
};

const el = {
  firm: byId("firm"), greeting: byId("greeting"), notice: byId("notice"), modeLine: byId("mode-line"),
  agents: byId<HTMLUListElement>("agents"), newAgent: byId<HTMLButtonElement>("new-agent"),
  agentForm: byId<HTMLFormElement>("agent-form"), agentFormTitle: byId("agent-form-title"),
  aName: byId<HTMLInputElement>("a-name"), aTask: byId<HTMLTextAreaElement>("a-task"), aLeave: byId<HTMLInputElement>("a-leave"),
  docChoices: byId("doc-choices"), aSchedule: byId<HTMLSelectElement>("a-schedule"),
  aGroups: byId("a-groups"), aGroupsField: byId("a-groups-field"), saveAgent: byId<HTMLButtonElement>("save-agent"),
  deleteAgent: byId<HTMLButtonElement>("delete-agent"), cancelAgent: byId<HTMLButtonElement>("cancel-agent"),
  toggleFilters: byId<HTMLButtonElement>("toggle-filters"), filters: byId("filters"),
  fKeyword: byId<HTMLInputElement>("f-keyword"), fGroup: byId<HTMLSelectElement>("f-group"),
  fSource: byId<HTMLSelectElement>("f-source"), fSort: byId<HTMLSelectElement>("f-sort"),
  showLine: byId("show-line"), clearFilters: byId<HTMLButtonElement>("clear-filters"),
  toggleAdd: byId<HTMLButtonElement>("toggle-add"), addForm: byId<HTMLFormElement>("add-form"),
  nKind: byId<HTMLSelectElement>("n-kind"), nSource: byId<HTMLInputElement>("n-source"), nText: byId<HTMLTextAreaElement>("n-text"),
  cancelAdd: byId<HTMLButtonElement>("cancel-add"), memory: byId("memory"), feed: byId<HTMLUListElement>("feed"),
  layerTabs: byId("layer-tabs"),
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
  const wasBusy = new Set(state.agents.filter(isBusy).map((a) => a.id));
  const res = await attempt("load your agents", () => api.agents());
  if (res.ok) state.agents = res.value;
  renderAgents();
  // A run that just ended may have left notes that are now memories. The live stream says so
  // too; this keeps My memory right when the stream is down.
  if (state.agents.some((a) => wasBusy.has(a.id) && !isBusy(a))) void refreshFacts();
}

// ---------- events

function onEvent(ev: MemberEvent): void {
  const meId = state.me?.id;
  switch (ev.type) {
    case "fact.saved":
      state.facts = [ev.fact, ...state.facts.filter((fact) => fact.id !== ev.fact.id)];
      renderMemory();
      break;
    case "scope.changed":
      if (ev.removed.length) {
        if (ev.principal === meId) state.facts = state.facts.filter((fact) => !ev.removed.includes(fact.id));
        for (const agent of state.agents.filter((agent) => ev.principal === meId || agent.id === ev.principal)) {
          agent.outputs = []; agent.files = []; agent.steps = []; agent.inbox = [];
        }
        renderMemory(); renderAgents();
      }
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
    // One "started" line per run, however many status updates the run sends while it works.
    const runKey = (run: AgentRun) => (ev.type === "agent.started" ? `${run.id}:${run.started_at ?? run.status}` : `${run.id}:${run.status}:${run.steps.length}`);
    const id = "fact" in ev ? ev.fact.id : "run" in ev ? runKey(ev.run) : "item_id" in ev ? ev.item_id : "build_id" in ev ? ev.build_id : "";
    addFeed(`${ev.type}:${id}:${ev.at}`, ev.at, text);
    renderFeed();
  }
}

// ---------- agents

/** What a fact id says, from this member's own memory (an agent reads only facts its creator holds). */
function statementOf(id: string): string | undefined {
  return state.facts.find((f) => f.id === id)?.statement;
}

/** The documents to show: what the agent wrote. Only a client that sends no documents falls back to outputs. */
function documentsOf(run: AgentRun): AgentDocument[] {
  if (run.documents) return run.documents;
  return run.outputs.map((o) => ({ file: o.type, title: o.title, text: o.lines.map((l) => `- ${l.text}`).join("\n"), at: run.finished_at ?? "" }));
}

/** A markdown document as text nodes only: whatever a model wrote can never become markup. */
function renderDoc(text: string): HTMLElement {
  const inline = (line: string) => boldRuns(stripFactRefs(line)).map((part, i) => (i % 2 ? h("b", null, part) : part));
  const out = h("div", { class: "doc-body" });
  let list: HTMLUListElement | null = null;
  for (const block of docBlocks(text)) {
    if (block.type === "item") {
      if (!list) out.append((list = h("ul", null)));
      list.append(h("li", null, inline(block.text)));
      continue;
    }
    list = null;
    out.append(block.type === "heading" ? h(block.level === 1 ? "h4" : "h5", null, inline(block.text)) : h("p", null, inline(block.text)));
  }
  return out;
}

/** The live "thinking" panel while an agent works: what it is on, its latest steps, the clock. */
function thinking(run: AgentRun): HTMLElement {
  const recent = run.steps.slice(-5);
  const assignment = run.run_task && run.run_task !== run.task ? run.run_task : "";
  return h("div", { class: "thinking", "aria-live": "polite" },
    h("div", { class: "think-head" },
      h("span", { class: "dots", "aria-hidden": "true" }, h("i", null), h("i", null), h("i", null)),
      h("b", null, agentPhase(run)),
      run.steps.length > 0 && h("span", { class: "hint" }, plural(run.steps.length, "step")),
      h("span", { class: "hint clock" }, elapsed(run.started_at, Date.now()))),
    assignment && h("div", { class: "hint" }, "On: ", h("span", { class: "assignment" }, assignment)),
    recent.length > 0 && h("ol", { class: "activity" }, recent.map((step, i) => {
      const live = i === recent.length - 1 && step.status === "running";
      return h("li", { class: live ? "now" : "done" }, friendlyStep(step, statementOf), live && h("span", { class: "ellipsis", "aria-hidden": "true" }));
    })));
}

function agentCard(run: AgentRun): HTMLElement {
  const busy = isBusy(run);
  const groups = run.memory_groups?.filter((g) => g.included) ?? [];
  const docs = documentsOf(run);
  const notes = run.memories ?? [];
  const assignBox = h("input", {
    type: "text", class: "assign-input", disabled: busy,
    placeholder: `Give it something to do now, or leave empty for: ${run.task}`,
    "aria-label": `What should ${run.name} do now?`,
    oninput: (e: Event) => state.assign.set(run.id, (e.target as HTMLInputElement).value),
    onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === "Enter") { e.preventDefault(); void startRun(run); } },
  }) as HTMLInputElement;
  assignBox.value = state.assign.get(run.id) ?? "";
  return h("li", { class: "agent", "data-status": run.status },
    h("div", { class: "ahead" },
      h("div", { style: "flex: 1; min-width: 220px" },
        h("div", { class: "aname" }, run.name),
        h("div", { class: "atask" }, run.task),
        h("div", { class: "remembers" },
          groups.length
            ? [h("span", { class: "hint" }, "Remembers"), groups.map((g) => h("span", { class: "chip" }, g.name))]
            : null,
          h("span", { class: "hint" }, plural(run.fact_count, "memory", "memories")))),
      h("span", { class: run.status === "failed" ? "pill failed" : busy ? "pill live" : "pill" }, STATUS_LABELS[run.status]),
      run.status === "running" && h("button", { class: "ghost", type: "button", onclick: () => void attempt("stop the agent", () => api.stopAgent(run.id)) }, "Stop"),
      h("button", { class: "mini", type: "button", "aria-label": `Edit ${run.name}`, onclick: () => openAgentForm(run.id) }, "Edit")),
    busy
      ? thinking(run)
      : [
        h("div", { class: "assign" }, assignBox, h("button", { class: "btn", type: "button", onclick: () => void startRun(run) }, "Run")),
        h("div", { class: "live" }, h("span", { class: run.status === "done" ? "dot ok" : "dot", "aria-hidden": "true" }), agentStatusLine(run, Date.now()),
          run.status === "done" && run.started_at && run.finished_at && h("span", { class: "hint" }, ` · took ${elapsed(run.started_at, Date.parse(run.finished_at))}`)),
        run.run_task && run.run_task !== run.task && (run.status === "done" || run.status === "failed") && h("div", { class: "hint" }, "Last asked: ", h("span", { class: "assignment" }, run.run_task)),
      ],
    api.mode === "mock" && h("div", { class: "hint plan" }, agentPlanLine(run)),
    run.refresh && h("div", { class: "hint refresh" }, "Its memory has changed since this run. Run it again for an up-to-date document."),
    notes.length > 0 && h("div", { class: "notes" },
      h("h3", { class: "sub" }, "Notes it left you"),
      h("ul", { class: "list" }, notes.map((n) => h("li", { class: "note" }, n.text.replace(/^#+\s*/gm, "")))),
      h("div", { class: "hint" }, "Each note is filed like anything you add: what fits your memory joins it.")),
    docs.length > 0 && h("div", { class: "output" },
      h("div", { class: "bar", style: "align-items: center" },
        h("h3", { class: "sub" }, "What it wrote"),
        h("span", { class: "hint" }, run.finished_at ? `Finished ${relativeTime(run.finished_at)}` : "")),
      h("ul", { class: "list" }, docs.map((d) => {
        const key = `${run.id}:${d.file}`;
        const open = state.openDocs.has(key);
        return h("li", { class: "docrow" },
          h("div", { class: "ahead" },
            h("span", { class: "doctitle" }, d.title),
            h("button", {
              class: "mini", type: "button", "aria-expanded": String(open),
              onclick: () => { if (open) state.openDocs.delete(key); else state.openDocs.add(key); renderAgents(); },
            }, open ? "Close" : "Open")),
          open && h("div", { class: "preview" },
            renderDoc(d.text),
            h("div", { class: "hint", style: "margin-top: 8px" }, api.mode === "mock" ? "Simulated draft built from this agent’s memory" : "Written from this agent’s memory, which is part of yours")));
      }))));
}

async function startRun(run: AgentRun): Promise<void> {
  const task = (state.assign.get(run.id) ?? "").trim();
  if (!(await attempt("start the agent", () => api.runAgent(run.id, task || undefined))).ok) return;
  state.kicked = Date.now();
  if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
  state.assign.delete(run.id);
  local(task ? `You asked ${run.name} to: ${task}` : `You started ${run.name}`);
  await refreshAgents();
}

function renderAgents(): void {
  const now = Date.now();
  syncList(el.agents, state.agents.map((run) => {
    const open = documentsOf(run).map((d) => (state.openDocs.has(`${run.id}:${d.file}`) ? "1" : "0")).join("");
    let version = `${JSON.stringify(run)}|${open}|${agentStatusLine(run, now)}|${isBusy(run) ? elapsed(run.started_at, now) : ""}`;
    // Someone typing an assignment keeps their card (and their caret) while the agent sits idle.
    // Any change of status (they pressed Run, or Enter) redraws it at once.
    const card = el.agents.querySelector<HTMLElement>(`[data-key="${CSS.escape(run.id)}"]`);
    const typing = card?.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement && !document.activeElement.disabled;
    if (typing && card?.dataset.status === run.status) version = card.dataset.version ?? version;
    return { key: run.id, version, build: () => agentCard(run) };
  }), () => h("li", { class: "empty" }, "No agents yet. Create one, give it a task and choose which of your memory it may use."));
}

function buildDocChoices(): void {
  el.docChoices.replaceChildren(...DOC_TYPES.map((d) =>
    h("label", { class: "doc" },
      h("input", { type: "checkbox", name: "docs", value: d.id }),
      h("span", null, h("b", null, d.label), h("span", { class: "hint" }, d.hint)))));
  el.aSchedule.replaceChildren(...SCHEDULES.map((s) => h("option", { value: s }, s)));
}

/**
 * "What it can remember": one box per group of the member's own memory. Only their groups are
 * listed (Canon's GET /api/groups for a member), so nothing they cannot see is ever offered.
 */
function buildGroupChoices(run: AgentRun | null | undefined): void {
  const fromRun = new Map((run?.memory_groups ?? []).map((g) => [g.id, g]));
  const ids = run?.memory_groups?.length ? run.memory_groups.map((g) => g.id) : Object.keys(state.names).filter((id) => id !== "inbox");
  el.aGroups.replaceChildren(...ids.map((id) => {
    const g = fromRun.get(id);
    const mine = state.facts.filter((f) => f.group === id && f.status === "hot").length;
    return h("label", { class: "doc" },
      h("input", { type: "checkbox", name: "groups", value: id, checked: g ? g.included : true }),
      h("span", null, h("b", null, g?.name ?? groupLabel(id, state.names)), h("span", { class: "hint" }, plural(mine, "memory", "memories"), " of yours")));
  }));
  el.aGroupsField.hidden = ids.length === 0;
}

function openAgentForm(target: "new" | string): void {
  const run = target === "new" ? null : state.agents.find((a) => a.id === target);
  state.agentForm = target;
  el.agentFormTitle.textContent = run ? `Edit ${run.name}` : "New agent";
  el.aName.value = run?.name ?? "";
  el.aName.disabled = api.mode === "canon" && !!run;
  el.aTask.value = run?.task ?? "";
  el.aLeave.value = run?.leave_out ?? "";
  buildGroupChoices(run);
  const docs = new Set<string>(run?.docs ?? ["summary"]);
  for (const box of el.docChoices.querySelectorAll<HTMLInputElement>("input[name=docs]")) box.checked = docs.has(box.value);
  el.aSchedule.value = run?.schedule ?? SCHEDULES[0];
  el.deleteAgent.hidden = !run;
  el.agentForm.hidden = false;
  (run ? el.aTask : el.aName).focus();
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
  const boxes = [...el.aGroups.querySelectorAll<HTMLInputElement>("input[name=groups]")];
  if (boxes.length && boxes.every((b) => !b.checked)) { notify("Tick at least one group, or the agent has nothing to work from."); return; }
  const body: AgentBody = {
    name, task,
    exclusions: { groups: [], labels: [], text: leave ? [leave] : [] },
    exclude_groups: boxes.filter((b) => !b.checked).map((b) => b.value),
    docs: api.mode === "mock" ? docs : [],
    schedule: api.mode === "mock" ? el.aSchedule.value as Schedule : "Only when I press Run",
  };
  const target = state.agentForm;
  el.saveAgent.disabled = true;
  el.saveAgent.textContent = "Building its memory…";
  try {
    if (target === "new") {
      if ((await attempt("create the agent", () => api.createAgent(body))).ok) local(`You created an agent: ${name}`);
    } else if (target) {
      if ((await attempt("save the agent", () => api.updateAgent(target, body))).ok) local(`You updated an agent: ${name}`);
    }
  } finally {
    el.saveAgent.disabled = false;
    el.saveAgent.textContent = "Save";
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
  const layer = layerOfFact(f);
  const reason = layerReasonLabel(f.layer_reason);
  const usage = usageLine(f, Date.now());
  const overridden = f.layer_reason === "pinned" || f.layer_reason === "moved";
  return h("li", { class: `${cls}${layer === "background" ? " bg" : ""}` },
    h("div", { class: "fact" },
      h("span", { class: "st" },
        h("span", { class: "kind" }, kindLabel(f.source_kind)),
        f.statement,
        h("span", { class: "trail" },
          sourceTitle(f),
          usage && h("span", { class: "usage" }, ` · ${usage}`),
          reason && h("span", { class: `why ${layer}` }, reason))),
      h("span", { class: "date" }, fmtDay(f.learned_at)),
      h("span", { class: "actions" },
        h("button", {
          class: "mini", type: "button",
          title: layer === "top" ? "Used only when you ask about it" : "Used in everyday answers again",
          onclick: () => void moveMemory(f, layer === "top" ? "background" : "top"),
        }, layer === "top" ? "Move to background" : "Bring back"),
        overridden && h("button", { class: "mini link", type: "button", title: "Bullwark decides from its date and how often it is used", onclick: () => void moveMemory(f, "auto") }, "Let Bullwark decide"),
        h("button", { class: "mini", type: "button", "aria-label": "Edit memory", onclick: () => { state.editing = f.id; renderMemory(); } }, "Edit"))));
}

/** A person's own layer override for one memory; the list redraws from Canon's answer. */
async function moveMemory(f: Fact, layer: "top" | "background" | "auto"): Promise<void> {
  const res = await attempt("move the memory", () => api.setLayer(f.id, layer));
  if (!res.ok) return;
  state.facts = state.facts.map((x) => (x.id === f.id ? { ...x, ...res.value } : x));
  local(layer === "background" ? `Moved to the background: ${f.statement}` : layer === "top" ? `Kept top of mind: ${f.statement}` : `Bullwark decides again for: ${f.statement}`);
  renderMemory();
}

/** Top of mind · Background · All, with counts, like a memory manager's tabs. */
function renderLayerTabs(): void {
  const hot = state.facts.filter((f) => f.status === "hot");
  const counts = { top: hot.filter((f) => layerOfFact(f) === "top").length, background: hot.filter((f) => layerOfFact(f) === "background").length, all: hot.length };
  const tabs: Array<[typeof state.layerView, string, string]> = [
    ["top", "Top of mind", "Used in everyday answers"],
    ["background", "Background", "Used only when you ask about it"],
    ["all", "All", "Everything in your memory"],
  ];
  el.layerTabs.replaceChildren(...tabs.map(([id, label, hint]) =>
    h("button", {
      type: "button", role: "tab", class: state.layerView === id ? "seg-btn on" : "seg-btn", "aria-selected": String(state.layerView === id), title: hint,
      onclick: () => { state.layerView = id; renderMemory(); },
    }, label, h("span", { class: "count" }, String(counts[id])))));
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

  renderLayerTabs();
  const inView = state.layerView === "all" ? state.facts : state.facts.filter((f) => layerOfFact(f) === state.layerView);
  const groups = viewMemory(inView, state.filters, state.names, order);
  const shown = countShown(groups), total = inView.filter((f) => f.status === "hot").length;
  const noun = state.layerView === "top" ? "top of mind" : state.layerView === "background" ? "in the background" : "";
  el.showLine.textContent = `${shown === total ? plural(total, "memory", "memories") : `Showing ${shown} of ${plural(total, "memory", "memories")}`}${noun ? ` ${noun}` : ""}`;
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
  })), () => h("p", { class: "empty" }, total ? "Nothing here matches these filters." : state.layerView === "background"
    ? "Nothing in the background. Memories land here when their date passes, when they go unused for a while, or when you move them."
    : "Your memory is empty. Add something to get started."));
  groups.forEach((g, i) => {
    const ul = el.memory.children[i]?.querySelector("ul");
    if (!ul) return;
    syncList(ul as HTMLElement, g.facts.map((f) => ({
      key: f.id,
      version: `${f.statement}|${f.learned_at}|${g.index}|${state.editing === f.id}|${f.layer}|${f.layer_reason}|${f.uses ?? 0}|${f.last_used ?? ""}`,
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
  // A working agent's clock ticks every second; idle cards are left alone. While one works (or was
  // just started and has not reported in yet) the page also re-reads Canon every 2 s, so the card
  // stays current even when the live stream has dropped.
  let tick = 0;
  setInterval(() => {
    if (!state.agents.some(isBusy) && Date.now() - state.kicked > 20_000) return;
    if (++tick % 2 === 0) void refreshAgents();
    else renderAgents();
  }, 1_000);
}

async function start(): Promise<void> {
  wire();
  const query = new URLSearchParams(location.search);
  if (api.mode === "canon" && query.get("auth") !== "token" && (!query.has("server") || normalizeUrl(query.get("server")) === location.origin)) {
    document.querySelector("header.top")!.append(h("a", { class: "mini", href: "/login" }, "Switch demo identity"));
  }
  el.docChoices.closest("fieldset")!.hidden = api.mode !== "mock";
  el.aSchedule.closest("label")!.hidden = api.mode !== "mock";
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
