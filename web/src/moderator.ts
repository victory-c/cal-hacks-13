// Moderator console entrypoint: people and scopes, agents, memory (with the inbox and
// quarantine), the feed, handoffs and audit. Data comes from a ModeratorApi: the in-browser mock
// by default, or Canon with `?data=canon&token=<moderator token>` (and `?server=`). Canon decides;
// this page lays it out and sends commands (integration contract rule 1).

import { resolveServerUrl, safeStorage } from "./config.ts";
import { byId, h, syncList } from "./dom.ts";
import { relativeTime } from "./format.ts";
import type { AgentRun, Fact } from "./member/contract.ts";
import {
  ALL_GROUPS, ALL_SOURCES, NO_FILTERS, SORTS, STATUS_LABELS, agentPlanLine, agentStatusLine, countShown, filtersActive,
  fmtDay, isBusy, kindLabel, plural, sourceTitle, viewMemory,
} from "./member/logic.ts";
import type { Filters, Sort } from "./member/logic.ts";
import { CanonModClient } from "./moderator/canon.ts";
import { INBOX } from "./moderator/contract.ts";
import type { AuditEntry, Group, Handoff, HeldItem, ModEvent, ModPrincipal, ModeratorApi } from "./moderator/contract.ts";
import { STAGES, excludedFrom, filterAudit, groupClass, groupName, includedGroups, modFeedText, peopleTree, stageDetail } from "./moderator/logic.ts";
import { DEMO_ITEMS, ModeratorMock } from "./moderator/mock.ts";

const storage = safeStorage();
const TOKEN_KEY = "canon.moderatorToken";
const NEW = "__new";

function pickApi(): ModeratorApi {
  const q = new URLSearchParams(location.search);
  if (q.get("data") !== "canon") return new ModeratorMock();
  const fromQuery = q.get("token");
  if (fromQuery) {
    storage.setItem(TOKEN_KEY, fromQuery);
    q.delete("token"); // keep the token out of the address bar and history
    history.replaceState(null, "", `${location.pathname}?${q}`);
  }
  return new CanonModClient(resolveServerUrl(location.search, storage), storage.getItem(TOKEN_KEY) ?? "");
}

const api = pickApi();

type NgTarget = { kind: "inbox"; id: string } | { kind: "bulk" } | { kind: "edit"; id: string } | { kind: "rule" };
interface FeedEntry { key: string; at: string; text: string; alert: boolean; fresh: boolean }

const S = {
  me: null as (ModPrincipal & { firm?: string }) | null,
  groups: [] as Group[],
  principals: [] as ModPrincipal[],
  facts: [] as Fact[],
  agents: [] as AgentRun[],
  held: [] as HeldItem[],
  handoffs: [] as Handoff[],
  audit: [] as AuditEntry[],
  feed: [] as FeedEntry[],
  filters: { ...NO_FILTERS } as Filters,
  sel: "",
  ruleOpen: false,
  rInc: new Set<string>(),
  builds: new Map<string, Map<string, Extract<ModEvent, { type: "scope.build" }>>>(),
  editing: null as string | null,
  editTo: "",
  selecting: false,
  picked: new Set<string>(),
  bulkTo: "",
  inboxTo: new Map<string, string>(),
  ng: null as NgTarget | null,
  openDocs: new Set<string>(),
  openHandoffs: new Set<string>(),
  replaying: true,
};

const el = {
  firm: byId("firm"), greeting: byId("greeting"), notice: byId("notice"), modeLine: byId("mode-line"),
  mTokens: byId("m-tokens"), mHandoffs: byId("m-handoffs"),
  togglePerson: byId<HTMLButtonElement>("toggle-person"), personForm: byId<HTMLFormElement>("person-form"),
  npName: byId<HTMLInputElement>("np-name"), npTier: byId<HTMLSelectElement>("np-tier"), cancelPerson: byId<HTMLButtonElement>("cancel-person"),
  people: byId<HTMLUListElement>("people"), selTitle: byId("sel-title"), selIn: byId("sel-in"), selUnbuilt: byId("sel-unbuilt"),
  toggleTier: byId<HTMLButtonElement>("toggle-tier"), toggleRule: byId<HTMLButtonElement>("toggle-rule"),
  ruleForm: byId<HTMLFormElement>("rule-form"), ruleTitle: byId("rule-title"), rTask: byId<HTMLTextAreaElement>("r-task"),
  gcards: byId("gcards"), ngRuleSlot: byId("ng-rule-slot"), cancelRule: byId<HTMLButtonElement>("cancel-rule"), saveRule: byId<HTMLButtonElement>("save-rule"),
  build: byId("build"), buildTitle: byId("build-title"), buildStages: byId("build-stages"), scopeFacts: byId("scope-facts"),
  agents: byId("agents"),
  toggleSelect: byId<HTMLButtonElement>("toggle-select"), toggleFilters: byId<HTMLButtonElement>("toggle-filters"), toggleAdd: byId<HTMLButtonElement>("toggle-add"),
  filters: byId("filters"), fKeyword: byId<HTMLInputElement>("f-keyword"), fGroup: byId<HTMLSelectElement>("f-group"),
  fSource: byId<HTMLSelectElement>("f-source"), fSort: byId<HTMLSelectElement>("f-sort"),
  showLine: byId("show-line"), clearFilters: byId<HTMLButtonElement>("clear-filters"),
  bulk: byId("bulk"), pickedLine: byId("picked-line"), bulkTo: byId<HTMLSelectElement>("bulk-to"),
  fileSelected: byId<HTMLButtonElement>("file-selected"), clearPicked: byId<HTMLButtonElement>("clear-picked"),
  ngMemorySlot: byId("ng-memory-slot"),
  addForm: byId<HTMLFormElement>("add-form"), nDemo: byId<HTMLSelectElement>("n-demo"), nKind: byId<HTMLSelectElement>("n-kind"),
  nSource: byId<HTMLInputElement>("n-source"), nFrom: byId<HTMLSelectElement>("n-from"), nText: byId<HTMLTextAreaElement>("n-text"),
  cancelAdd: byId<HTMLButtonElement>("cancel-add"),
  heldWrap: byId("held-wrap"), heldH: byId("held-h"), held: byId<HTMLUListElement>("held"),
  inboxWrap: byId("inbox-wrap"), inboxH: byId("inbox-h"), inbox: byId<HTMLUListElement>("inbox"), memory: byId("memory"),
  feed: byId<HTMLUListElement>("feed"),
  tabHandoffs: byId<HTMLButtonElement>("tab-handoffs"), tabAudit: byId<HTMLButtonElement>("tab-audit"),
  handoffsPanel: byId("handoffs-panel"), auditPanel: byId("audit-panel"), handoffs: byId("handoffs"),
  aWho: byId<HTMLSelectElement>("a-who"), aGroup: byId<HTMLSelectElement>("a-group"), auditLine: byId("audit-line"), audit: byId<HTMLUListElement>("audit"),
};

// The shared new-group form, cloned once from its template and moved to whichever slot opened it.
const ngForm = (byId<HTMLTemplateElement>("ng-template").content.firstElementChild as HTMLFormElement).cloneNode(true) as HTMLFormElement;
const ngName = ngForm.querySelector<HTMLInputElement>("#ng-name")!;
const ngDesc = ngForm.querySelector<HTMLInputElement>("#ng-desc")!;
const ngCreate = ngForm.querySelector<HTMLButtonElement>("#ng-create")!;
const ngHint = ngForm.querySelector<HTMLElement>("#ng-hint")!;

// ---------- helpers

let noticeTimer = 0;
function notify(message: string): void {
  el.notice.textContent = message;
  el.notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => (el.notice.hidden = true), 6000);
}

type Outcome<T> = { ok: true; value: T } | { ok: false };

async function attempt<T>(what: string, fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    notify(`Couldn't ${what}: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false };
  }
}

const nameOf = (id: string) => S.principals.find((p) => p.id === id)?.name ?? id;
const gname = (id: string) => groupName(id, S.groups);
const gcls = (id: string) => groupClass(id, S.groups);
const names = () => Object.fromEntries(S.groups.map((g) => [g.id, g.name]));
const selected = () => S.principals.find((p) => p.id === S.sel);
const isModerator = (p: ModPrincipal) => p.kind === "person" && p.tier === "moderator";

/** A group picker: optional "Choose a group" placeholder, every group, then "+ New group…". */
function fillGroupPicker(select: HTMLSelectElement, value: string, placeholder: boolean): void {
  const opts = [...(placeholder ? [["", "Choose a group"]] : []), ...S.groups.map((g) => [g.id, g.name]), [NEW, "+ New group…"]];
  const sig = opts.map((o) => o[0]).join("|");
  if (select.dataset.sig !== sig) {
    select.replaceChildren(...opts.map(([v, t]) => h("option", { value: v! }, t!)));
    select.dataset.sig = sig;
  }
  select.value = value;
}

function fillSelect(select: HTMLSelectElement, options: readonly (readonly [string, string])[], value: string): void {
  const sig = options.map((o) => o[0]).join("|");
  if (select.dataset.sig !== sig) {
    select.replaceChildren(...options.map(([v, t]) => h("option", { value: v }, t)));
    select.dataset.sig = sig;
  }
  select.value = options.some((o) => o[0] === value) ? value : options[0]![0];
}

function addFeed(key: string, at: string, text: string, alert: boolean): void {
  if (S.feed.some((f) => f.key === key)) return;
  S.feed.push({ key, at, text, alert, fresh: !S.replaying });
  S.feed.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  S.feed.length = Math.min(S.feed.length, 300);
}

// ---------- data

let refreshTimer = 0;
/** Re-reads every snapshot after a burst of events, then repaints once. */
function scheduleRefresh(): void {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refreshAll(), 40);
}

async function refreshAll(): Promise<void> {
  const res = await attempt("load the console", () => Promise.all([api.groups(), api.principals(), api.facts(), api.agents(), api.quarantine(), api.handoffs(), api.audit()]));
  if (!res.ok) return;
  [S.groups, S.principals, S.facts, S.agents, S.held, S.handoffs, S.audit] = res.value;
  for (const id of [...S.picked]) if (!S.facts.some((f) => f.id === id)) S.picked.delete(id);
  renderAll();
}

function onEvent(ev: ModEvent): void {
  if (ev.type === "scope.build") {
    if (!S.builds.has(ev.principal) || ev.stage === "exclusions") S.builds.set(ev.principal, new Map());
    S.builds.get(ev.principal)!.set(ev.stage, ev);
  }
  if ("run" in ev) {
    const i = S.agents.findIndex((a) => a.id === ev.run.id);
    if (i === -1) S.agents.push(ev.run);
    else S.agents[i] = ev.run;
  }
  const line = modFeedText(ev, nameOf, S.groups);
  if (line) {
    const id = "run" in ev ? `${ev.run.id}:${ev.run.status}:${ev.run.steps.length}` : "fact" in ev ? ev.fact.id : "item_id" in ev ? ev.item_id : "handoff" in ev ? ev.handoff.id : "build_id" in ev ? ev.build_id : "principal" in ev && typeof ev.principal === "string" ? `${ev.principal}:${ev.at}` : "";
    addFeed(`${ev.type}:${id}:${ev.at}`, ev.at, line.text, line.alert);
  }
  if (!S.replaying) {
    renderFeed();
    if ("run" in ev) renderAgents();
    if (ev.type === "scope.build") renderSelected();
    scheduleRefresh();
  }
}

// ---------- people & scopes

function renderPeople(): void {
  el.people.replaceChildren(...peopleTree(S.principals).map(({ p, depth }) => {
    const tag = p.kind === "agent" ? plural(p.fact_ids.length, "fact") : p.tier === "moderator" ? "Compliance" : "Member";
    return h("li", null, h("button", {
      class: `person${depth ? " agentrow" : ""}${S.sel === p.id ? " on" : ""}`, type: "button",
      "aria-current": S.sel === p.id ? "true" : "false",
      onclick: () => { S.sel = p.id; closeRule(); renderPeople(); renderSelected(); },
    }, h("span", null, depth ? h("span", { class: "shield", "aria-hidden": "true" }) : null, p.name), h("span", { class: "t" }, tag)));
  }));
}

function memRow(f: Fact): HTMLElement {
  return h("li", { class: `mem ${gcls(f.group)}` },
    h("div", { class: "fact" },
      h("span", { class: "st" }, h("span", { class: "kind" }, kindLabel(f.source_kind)), f.statement, h("span", { class: "trail" }, sourceTitle(f))),
      h("span", { class: "date" }, fmtDay(f.learned_at))));
}

function renderSelected(): void {
  const p = selected();
  if (!p) return;
  const mod = isModerator(p);
  const scope = S.facts.filter((f) => p.fact_ids.includes(f.id) && f.group !== INBOX);
  const inGroups = S.groups.filter((g) => scope.some((f) => f.group === g.id));
  el.selTitle.textContent = mod ? `${p.name} · Compliance`
    : `${p.name}${p.kind === "agent" ? ` · agent by ${nameOf(p.creator!)}` : ""} · ${plural(scope.length, "fact")}`;
  if (mod) el.selIn.replaceChildren("Sees all memory");
  else if (inGroups.length) el.selIn.replaceChildren("In:", ...inGroups.map((g) => h("span", { class: "chip" }, h("span", { class: `gdot ${gcls(g.id)}`, "aria-hidden": "true" }), g.name)));
  else el.selIn.replaceChildren(p.rule ? "In: no groups yet" : "");
  el.toggleTier.hidden = p.kind !== "person" || p.id === S.me?.id;
  el.toggleTier.textContent = p.tier === "moderator" ? "Make member" : "Make compliance";
  el.toggleRule.hidden = mod;
  el.toggleRule.textContent = S.ruleOpen ? "Close editor" : p.rule ? "Edit rule" : "Build scope";
  el.toggleRule.setAttribute("aria-expanded", String(S.ruleOpen));
  el.selUnbuilt.hidden = mod || !!p.rule;
  el.selUnbuilt.textContent = p.kind === "agent" ? "This agent has no rule yet." : `${p.name} has no scope yet, so their AI tools and agents get nothing. Describe their task to build one.`;

  const build = S.builds.get(p.id);
  el.build.hidden = !build;
  if (build) {
    el.buildTitle.textContent = `${build.has("done") ? "Built" : "Building"} ${p.name}’s scope`;
    el.buildStages.replaceChildren(...STAGES.map(({ stage, label }) => {
      const ev = build.get(stage);
      return h("div", { class: "stage" }, h("span", { class: "mk" }, ev ? "✓" : "…"), h("span", { style: "font-weight: 600" }, label), h("span", null, ev ? stageDetail(ev) : "Waiting"));
    }));
  }
  el.scopeFacts.replaceChildren(...S.groups.map((g) => {
    const fs = scope.filter((f) => f.group === g.id);
    return fs.length ? h("section", null, h("h4", { class: "grp" }, `${g.name} · ${fs.length}`), h("ul", { class: "list" }, fs.map(memRow))) : null;
  }).filter((x): x is HTMLElement => !!x));
  if (S.ruleOpen) renderGroupCards();
}

function renderGroupCards(): void {
  const p = selected();
  el.gcards.replaceChildren(...S.groups.map((g) => {
    const on = S.rInc.has(g.id);
    const box = h("input", { class: "gcheck", type: "checkbox", checked: on, onchange: () => { if (on) S.rInc.delete(g.id); else S.rInc.add(g.id); renderGroupCards(); } });
    return h("label", { class: `gcard${on ? " on" : ""}` }, box, h("span", { class: `gdot ${gcls(g.id)}`, "aria-hidden": "true" }), h("span", { class: "gname" }, g.name), h("span", { class: "gstate" }, on ? "✓ In scope" : "Not included"));
  }), h("button", { class: "gcard addcard", type: "button", onclick: () => openNg({ kind: "rule" }) }, h("span", { class: "gname", style: "text-align: center" }, "+ New group")));
  el.saveRule.disabled = !el.rTask.value.trim() || S.rInc.size === 0;
  el.ruleTitle.textContent = p ? `${p.rule ? "Edit" : "Build"} ${p.name}’s scope` : "";
}

function openRule(): void {
  const p = selected();
  if (!p) return;
  S.ruleOpen = true;
  // A new person starts with no groups selected; an agent starts with all of its creator's.
  const excluded = p.rule ? p.rule.exclusions.groups : p.kind === "person" ? S.groups.map((g) => g.id) : [];
  S.rInc = new Set(includedGroups(excluded, S.groups));
  el.rTask.value = p.rule?.task ?? "";
  el.ruleForm.hidden = false;
  renderSelected();
  el.rTask.focus();
}

function closeRule(): void {
  S.ruleOpen = false;
  el.ruleForm.hidden = true;
  if (S.ng?.kind === "rule") closeNg();
  renderSelected();
}

async function saveRule(e: Event): Promise<void> {
  e.preventDefault();
  const p = selected();
  const task = el.rTask.value.trim();
  if (!p || !task || !S.rInc.size) return;
  const rule = { task, exclusions: { groups: excludedFrom([...S.rInc], S.groups), labels: [], text: [] } };
  S.builds.delete(p.id);
  if ((await attempt("save the rule", () => api.setRule(p.id, rule))).ok) closeRule();
}

// ---------- new group (one form, many entry points)

function openNg(target: NgTarget): void {
  S.ng = target;
  ngName.value = "";
  ngDesc.value = "";
  ngCreate.disabled = true;
  const p = selected();
  ngHint.textContent = target.kind === "rule"
    ? `The new group is added to ${p?.name ?? "this"}’s scope when you save the rule; it stays out of everyone else’s.`
    : "A new group starts empty and is in no one’s scope until you add it to their rule. It will be picked here for you.";
  (target.kind === "rule" ? el.ngRuleSlot : el.ngMemorySlot).replaceChildren(ngForm);
  ngName.focus();
}

function closeNg(): void {
  S.ng = null;
  ngForm.remove();
}

async function createGroup(e: Event): Promise<void> {
  e.preventDefault();
  const target = S.ng;
  const res = await attempt("create the group", () => api.createGroup(ngName.value, ngDesc.value));
  if (!res.ok || !target) return;
  const id = res.value.id;
  if (!S.groups.some((g) => g.id === id)) S.groups.push(res.value);
  if (target.kind === "inbox") S.inboxTo.set(target.id, id);
  if (target.kind === "bulk") S.bulkTo = id;
  if (target.kind === "edit") S.editTo = id;
  if (target.kind === "rule") S.rInc.add(id);
  closeNg();
  await refreshAll();
}

// ---------- agents

function agentCard(run: AgentRun): HTMLElement {
  const busy = isBusy(run);
  return h("li", { class: "agent" },
    h("div", { class: "ahead" },
      h("div", { style: "flex: 1; min-width: 220px" }, h("div", { class: "aname" }, run.name), h("div", { class: "atask" }, run.task)),
      h("span", { class: run.status === "failed" ? "pill failed" : "pill" }, STATUS_LABELS[run.status]),
      run.status === "running"
        ? h("button", { class: "ghost", type: "button", onclick: () => void attempt("stop the agent", () => api.stopAgent(run.id)) }, "Stop")
        : h("button", { class: "btn", type: "button", disabled: busy || run.fact_count === 0, onclick: () => void attempt("start the agent", () => api.runAgent(run.id)) }, "Run"),
      h("button", { class: "mini", type: "button", onclick: () => { S.sel = run.id; closeRule(); renderPeople(); renderSelected(); el.people.scrollIntoView({ behavior: "smooth", block: "start" }); } }, "Scope")),
    h("div", { class: "live", "aria-live": "polite" }, h("span", { class: busy ? "dot on" : run.status === "done" ? "dot ok" : "dot", "aria-hidden": "true" }),
      run.fact_count === 0 && !busy ? "Waiting: its creator’s scope gives it nothing yet" : agentStatusLine(run, Date.now())),
    h("div", { class: "hint plan" }, agentPlanLine(run).replace(/^Only when I press Run · /, ""), ` · ${plural(run.fact_count, "fact")}`),
    run.outputs.length > 0 && h("div", { class: "output" },
      h("div", { class: "bar", style: "align-items: center" }, h("h3", { class: "sub" }, "Output"), h("span", { class: "files" }, run.files.join(" · "))),
      h("ul", { class: "list" }, run.outputs.map((o) => {
        const key = `${run.id}:${o.type}`;
        const open = S.openDocs.has(key);
        return h("li", { class: "docrow" },
          h("div", { class: "ahead" }, h("span", { class: "doctitle" }, o.title), h("span", { class: "hint" }, plural(o.lines.length, "line")),
            h("button", { class: "mini", type: "button", "aria-expanded": String(open), onclick: () => { if (open) S.openDocs.delete(key); else S.openDocs.add(key); renderAgents(); } }, open ? "Close" : "Open")),
          open && h("div", { class: "preview" },
            h("ul", null, o.lines.map((l) => h("li", null, l.text, l.source && h("span", { class: "from" }, `from ${l.source}`)))),
            h("div", { class: "hint", style: "margin-top: 8px" }, api.mode === "mock" ? "Simulated draft built from this agent’s scope" : "Written from this agent’s scope")));
      }))));
}

function renderAgents(): void {
  const creators = S.principals.filter((p) => p.kind === "person" && S.agents.some((a) => a.creator === p.id));
  syncList(el.agents, creators.map((c) => {
    const runs = S.agents.filter((a) => a.creator === c.id);
    const version = runs.map((r) => `${JSON.stringify(r)}|${r.outputs.map((o) => (S.openDocs.has(`${r.id}:${o.type}`) ? 1 : 0)).join("")}|${agentStatusLine(r, Date.now())}`).join("#");
    return { key: c.id, version, build: () => h("section", null, h("h3", { class: "creator" }, `${c.name}’s agents`), h("ul", { class: "list" }, runs.map(agentCard))) };
  }), () => h("p", { class: "empty" }, "No agents yet. Members create them from their own view."));
}

// ---------- memory

function editForm(f: Fact): HTMLElement {
  const box = h("textarea", { rows: 2, "aria-label": "Memory" }) as HTMLTextAreaElement;
  box.value = f.statement;
  const to = h("select", null) as HTMLSelectElement;
  fillGroupPicker(to, S.editTo || f.group, false);
  to.addEventListener("change", () => {
    if (to.value === NEW) { to.value = S.editTo || f.group; openNg({ kind: "edit", id: f.id }); return; }
    S.editTo = to.value;
  });
  queueMicrotask(() => box.focus());
  return h("form", {
    class: "panel", "aria-label": "Edit memory", style: "margin: 8px 0",
    onsubmit: async (e: Event) => {
      e.preventDefault();
      const statement = box.value.trim();
      if (!statement) return;
      if (statement !== f.statement) await attempt("save the memory", () => api.editFact(f.id, statement));
      if (to.value && to.value !== f.group) await attempt("file the memory", () => api.fileFacts([f.id], to.value));
      S.editing = null;
      S.editTo = "";
      await refreshAll();
    },
  },
    h("label", { class: "fld" }, "Memory", box),
    h("label", { class: "fld" }, "File to group", to),
    h("div", { class: "row" },
      h("button", { class: "danger", type: "button", onclick: async () => { if ((await attempt("retire the memory", () => api.retireFact(f.id))).ok) { S.editing = null; await refreshAll(); } } }, "Retire"),
      h("button", { class: "ghost", type: "button", onclick: () => { S.editing = null; S.editTo = ""; if (S.ng?.kind === "edit") closeNg(); renderMemory(); } }, "Cancel"),
      h("button", { class: "btn", type: "submit" }, "Save")),
    h("div", { class: "hint" }, "Filing to another group updates every scope that rule-matches it, live."));
}

function memoryRow(f: Fact, cls: string, byDate: boolean): HTMLElement {
  if (S.editing === f.id) return h("li", { class: `mem ${cls}` }, editForm(f));
  return h("li", { class: `mem ${cls}` },
    h("div", { class: "fact" },
      S.selecting && h("input", { class: "pickbox", type: "checkbox", checked: S.picked.has(f.id), "aria-label": "Select this fact", onchange: () => { if (S.picked.has(f.id)) S.picked.delete(f.id); else S.picked.add(f.id); renderMemory(); } }),
      h("span", { class: "st" }, h("span", { class: "kind" }, kindLabel(f.source_kind)), f.statement, h("span", { class: "trail" }, `${byDate ? `${gname(f.group)} · ` : ""}${sourceTitle(f)}`)),
      h("span", { class: "date" }, fmtDay(f.learned_at)),
      h("button", { class: "mini", type: "button", "aria-label": "Edit memory", onclick: () => { S.editing = f.id; S.editTo = ""; renderMemory(); } }, "Edit")));
}

function renderMemory(): void {
  const facts = S.facts.filter((f) => f.group !== INBOX);
  const nm = names();
  const order = S.groups.map((g) => g.id);
  fillSelect(el.fGroup, [[ALL_GROUPS, ALL_GROUPS], ...S.groups.map((g) => [g.name, g.name] as const)], S.filters.group);
  fillSelect(el.fSource, [[ALL_SOURCES, ALL_SOURCES], ...[...new Set(facts.map(sourceTitle))].map((s) => [s, s] as const)], S.filters.source);
  fillSelect(el.fSort, SORTS.map((s) => [s, s] as const), S.filters.sort);
  S.filters.group = el.fGroup.value;
  S.filters.source = el.fSource.value;
  const groups = viewMemory(facts, S.filters, nm, order);
  const byDate = S.filters.sort !== "By group";
  const shown = countShown(groups);
  el.showLine.textContent = shown === facts.length ? `All ${plural(facts.length, "fact")}` : `Showing ${shown} of ${plural(facts.length, "fact")}`;
  const active = filtersActive(S.filters);
  el.clearFilters.hidden = !active;
  el.toggleFilters.textContent = !el.filters.hidden ? "Hide filters" : active ? "Filter (on)" : "Filter";
  el.toggleFilters.setAttribute("aria-expanded", String(!el.filters.hidden));

  // Select mode
  el.toggleSelect.textContent = S.selecting ? "Done selecting" : "Select";
  el.toggleSelect.setAttribute("aria-pressed", String(S.selecting));
  el.bulk.hidden = !S.selecting;
  el.pickedLine.textContent = S.picked.size ? `${plural(S.picked.size, "fact")} selected` : "Tick facts, or a group to take all of it";
  fillGroupPicker(el.bulkTo, S.bulkTo, true);
  el.fileSelected.disabled = !S.bulkTo || S.picked.size === 0;

  // Held for review
  el.heldWrap.hidden = S.held.length === 0;
  el.heldH.textContent = `Held for review · ${S.held.length}`;
  el.held.replaceChildren(...S.held.map((it) => h("li", { class: "mem held" },
    h("div", { class: "fact" },
      h("span", { class: "st" }, h("span", { class: "kind warn" }, kindLabel(it.kind)), it.source, h("span", { class: "trail" }, `${it.reason} · from ${nameOf(it.author)}`)),
      h("span", { class: "date" }, fmtDay(it.at)),
      h("button", { class: "mini", type: "button", onclick: () => void attempt("release the item", () => api.release(it.id)) }, "Release")))));

  // Inbox
  const inbox = S.facts.filter((f) => f.group === INBOX);
  el.inboxWrap.hidden = inbox.length === 0;
  el.inboxH.textContent = `Inbox · ${inbox.length}`;
  syncList(el.inbox, inbox.map((f) => ({
    key: f.id,
    version: `${f.statement}|${S.inboxTo.get(f.id) ?? ""}|${S.groups.length}`,
    build: () => {
      const to = h("select", { "aria-label": "File to" }) as HTMLSelectElement;
      fillGroupPicker(to, S.inboxTo.get(f.id) ?? "", true);
      to.addEventListener("change", () => {
        if (to.value === NEW) { to.value = S.inboxTo.get(f.id) ?? ""; openNg({ kind: "inbox", id: f.id }); return; }
        S.inboxTo.set(f.id, to.value);
        renderMemory();
      });
      const target = S.inboxTo.get(f.id) ?? "";
      return h("li", { class: "mem inboxg" },
        h("div", { class: "fact" },
          h("span", { class: "st" }, h("span", { class: "kind" }, kindLabel(f.source_kind)), f.statement, h("span", { class: "trail" }, sourceTitle(f))),
          h("label", { class: "inline-label" }, "File to", to),
          h("button", { class: "mini", type: "button", disabled: !target, onclick: async () => { if ((await attempt("file it", () => api.fileFacts([f.id], target))).ok) { S.inboxTo.delete(f.id); await refreshAll(); } } }, "File")));
    },
  })));

  // Memory groups, keyed so an open edit box survives facts arriving elsewhere.
  syncList(el.memory, groups.map((g) => {
    const gid = S.groups.find((x) => x.name === g.label)?.id ?? "";
    const ids = g.facts.map((f) => f.id);
    const n = ids.filter((id) => S.picked.has(id)).length;
    const all = ids.length > 0 && n === ids.length;
    return {
      key: `grp:${g.label}`,
      version: `grp:${g.label}|${S.selecting}|${n}/${ids.length}`,
      build: () => h("section", null,
        g.label && h("div", { class: "grphead" },
          S.selecting && h("input", { class: "pickbox", type: "checkbox", checked: all, "aria-label": `Select all of ${g.label}`, onchange: () => { for (const id of ids) { if (all) S.picked.delete(id); else S.picked.add(id); } renderMemory(); } }),
          h("h3", { class: "grp" }, g.label),
          S.selecting && n > 0 && h("span", { class: "hint" }, `${n} of ${ids.length} selected`)),
        h("ul", { class: "list", "data-group": gid })),
    };
  }), () => h("p", { class: "empty" }, facts.length ? "Nothing in memory matches these filters." : "Memory is empty."));
  groups.forEach((g, i) => {
    const ul = el.memory.children[i]?.querySelector("ul");
    if (!ul) return;
    syncList(ul as HTMLElement, g.facts.map((f) => ({
      key: f.id,
      version: `${f.statement}|${f.group}|${f.learned_at}|${S.editing === f.id}|${S.selecting}|${S.picked.has(f.id)}|${byDate}|${S.groups.length}`,
      build: () => memoryRow(f, gcls(f.group), byDate),
      fresh: Date.now() - Date.parse(f.learned_at) < 10_000,
    })));
  });
}

async function addItem(e: Event): Promise<void> {
  e.preventDefault();
  const text = el.nText.value.trim();
  if (!text) return;
  const body = { kind: el.nKind.value as "note", source: el.nSource.value.trim(), text, author: el.nFrom.value };
  if (!(await attempt("add it", () => api.addItem(body))).ok) return;
  el.nText.value = "";
  el.nSource.value = "";
  el.nDemo.value = "";
  el.addForm.hidden = true;
  el.toggleAdd.setAttribute("aria-expanded", "false");
}

// ---------- feed, handoffs, audit

function renderFeed(): void {
  const now = Date.now();
  syncList(el.feed, S.feed.map((f) => ({
    key: f.key,
    version: `${f.text}|${relativeTime(f.at, now)}`,
    fresh: f.fresh,
    build: () => h("li", { class: f.alert ? "alert" : "" }, h("span", { class: "when" }, relativeTime(f.at, now)), f.text),
  })), () => h("li", { class: "empty" }, "Nothing yet."));
  for (const f of S.feed) f.fresh = false;
}

const DECISION: Record<Handoff["candidates"][number]["decision"], string> = { kept: "Kept", cut_relevance: "Cut: not relevant", cut_budget: "Cut: over budget" };

function renderHandoffs(): void {
  el.mTokens.textContent = String(S.handoffs.reduce((t, x) => t + x.tokens_est, 0));
  el.mHandoffs.textContent = String(S.handoffs.length);
  el.handoffs.replaceChildren(...(S.handoffs.length ? S.handoffs.map((ho) => {
    const open = S.openHandoffs.has(ho.id);
    const kept = ho.candidates.filter((c) => c.decision === "kept").length;
    const agent = S.principals.find((p) => p.id === ho.principal);
    return h("div", { class: "ho" },
      h("div", { class: "ahead" },
        h("div", { style: "flex: 1; min-width: 240px" },
          h("div", { style: "font-weight: 600" }, `${nameOf(ho.principal)}${agent?.creator ? ` (for ${nameOf(agent.creator)})` : ""}`),
          h("div", { class: "atask" }, `“${ho.request}”`)),
        h("span", { class: "hint" }, `${kept} kept · ${ho.candidates.length - kept} cut · ~${ho.tokens_est} tokens (est.)`),
        h("button", { class: "mini", type: "button", "aria-expanded": String(open), onclick: () => { if (open) S.openHandoffs.delete(ho.id); else S.openHandoffs.add(ho.id); renderHandoffs(); } }, open ? "Hide" : "Inspect")),
      open && h("div", { style: "overflow-x: auto" },
        h("table", { class: "tbl" },
          h("thead", null, h("tr", null, h("th", null, "Candidate (inside the scope)"), h("th", null, ho.simulated ? "Relevance (simulated)" : "Relevance"), h("th", null, "Result"), h("th", null, "Tokens (est.)"))),
          h("tbody", null, ho.candidates.map((c) => h("tr", null, h("td", null, c.statement), h("td", null, c.p.toFixed(2)), h("td", null, DECISION[c.decision]), h("td", null, c.tokens_est))))),
        h("div", { class: "hint", style: "margin-top: 6px" }, `Budget ${ho.budget_est} tokens (est.${ho.simulated ? ", demo setting" : ""}) · search ran only inside ${nameOf(ho.principal)}’s scope`)));
  }) : [h("p", { class: "hint" }, "No handoffs yet.")]));
}

function renderAudit(): void {
  fillSelect(el.aWho, [["", "Everyone"], ...S.principals.map((p) => [p.id, p.name] as const)], el.aWho.value);
  fillSelect(el.aGroup, [["", "All groups"], ...S.groups.map((g) => [g.id, g.name] as const)], el.aGroup.value);
  const rows = filterAudit(S.audit, el.aWho.value, el.aGroup.value);
  el.auditLine.textContent = `${plural(rows.length, "entry", "entries")}, newest first`;
  el.audit.replaceChildren(...rows.map((a) => h("li", null, h("span", { class: "at" }, `${fmtDay(a.at)} · ${relativeTime(a.at)}`), h("span", null, a.text))));
}

function renderAll(): void {
  renderPeople();
  renderSelected();
  renderAgents();
  renderMemory();
  renderFeed();
  renderHandoffs();
  renderAudit();
  ngCreate.disabled = !ngName.value.trim();
}

// ---------- wiring

function wire(): void {
  el.togglePerson.addEventListener("click", () => {
    el.personForm.hidden = !el.personForm.hidden;
    el.togglePerson.setAttribute("aria-expanded", String(!el.personForm.hidden));
    if (!el.personForm.hidden) el.npName.focus();
  });
  el.cancelPerson.addEventListener("click", () => { el.personForm.hidden = true; el.togglePerson.setAttribute("aria-expanded", "false"); });
  el.personForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = el.npName.value.trim();
    if (!name) return;
    const res = await attempt("add the person", () => api.addPerson(name, el.npTier.value as "member" | "moderator"));
    if (!res.ok) return;
    el.npName.value = "";
    el.personForm.hidden = true;
    S.sel = res.value.id;
    await refreshAll();
  });

  el.toggleTier.addEventListener("click", () => {
    const p = selected();
    if (p) void attempt("change the tier", () => api.setTier(p.id, p.tier === "moderator" ? "member" : "moderator"));
  });
  el.toggleRule.addEventListener("click", () => (S.ruleOpen ? closeRule() : openRule()));
  el.cancelRule.addEventListener("click", closeRule);
  el.rTask.addEventListener("input", () => { el.saveRule.disabled = !el.rTask.value.trim() || S.rInc.size === 0; });
  el.ruleForm.addEventListener("submit", (e) => void saveRule(e));

  ngForm.addEventListener("submit", (e) => void createGroup(e));
  ngName.addEventListener("input", () => {
    const n = ngName.value.trim().toLowerCase();
    ngCreate.disabled = !n || S.groups.some((g) => g.name.toLowerCase() === n);
  });
  ngForm.querySelector<HTMLButtonElement>("#ng-cancel")!.addEventListener("click", closeNg);

  el.toggleSelect.addEventListener("click", () => { S.selecting = !S.selecting; S.picked.clear(); S.bulkTo = ""; renderMemory(); });
  el.bulkTo.addEventListener("change", () => {
    if (el.bulkTo.value === NEW) { el.bulkTo.value = S.bulkTo; openNg({ kind: "bulk" }); return; }
    S.bulkTo = el.bulkTo.value;
    renderMemory();
  });
  el.clearPicked.addEventListener("click", () => { S.picked.clear(); renderMemory(); });
  el.fileSelected.addEventListener("click", async () => {
    if (!S.bulkTo || !S.picked.size) return;
    if ((await attempt("file the selection", () => api.fileFacts([...S.picked], S.bulkTo))).ok) {
      S.picked.clear();
      S.bulkTo = "";
      await refreshAll();
    }
  });

  el.toggleFilters.addEventListener("click", () => { el.filters.hidden = !el.filters.hidden; renderMemory(); if (!el.filters.hidden) el.fKeyword.focus(); });
  el.fKeyword.addEventListener("input", () => { S.filters.keyword = el.fKeyword.value; renderMemory(); });
  el.fGroup.addEventListener("change", () => { S.filters.group = el.fGroup.value; renderMemory(); });
  el.fSource.addEventListener("change", () => { S.filters.source = el.fSource.value; renderMemory(); });
  el.fSort.addEventListener("change", () => { S.filters.sort = el.fSort.value as Sort; renderMemory(); });
  el.clearFilters.addEventListener("click", () => { S.filters = { ...NO_FILTERS }; el.fKeyword.value = ""; renderMemory(); });

  el.toggleAdd.addEventListener("click", () => {
    el.addForm.hidden = !el.addForm.hidden;
    el.toggleAdd.setAttribute("aria-expanded", String(!el.addForm.hidden));
    if (!el.addForm.hidden) {
      fillSelect(el.nFrom, S.principals.filter((p) => p.kind === "person").map((p) => [p.id, p.name] as const), el.nFrom.value || (S.me?.id ?? ""));
      el.nText.focus();
    }
  });
  el.cancelAdd.addEventListener("click", () => { el.addForm.hidden = true; el.toggleAdd.setAttribute("aria-expanded", "false"); });
  el.nDemo.append(...DEMO_ITEMS.map((d) => h("option", { value: d.id }, d.source)));
  el.nDemo.hidden = api.mode !== "mock";
  el.nDemo.closest("label")!.hidden = api.mode !== "mock";
  el.nDemo.addEventListener("change", () => {
    const d = DEMO_ITEMS.find((x) => x.id === el.nDemo.value);
    if (!d) return;
    el.nKind.value = d.kind;
    el.nSource.value = d.source;
    el.nFrom.value = d.author;
    el.nText.value = d.text;
  });
  el.addForm.addEventListener("submit", (e) => void addItem(e));

  const showTab = (audit: boolean) => {
    el.tabHandoffs.classList.toggle("on", !audit);
    el.tabAudit.classList.toggle("on", audit);
    el.tabHandoffs.setAttribute("aria-selected", String(!audit));
    el.tabAudit.setAttribute("aria-selected", String(audit));
    el.handoffsPanel.hidden = audit;
    el.auditPanel.hidden = !audit;
  };
  el.tabHandoffs.addEventListener("click", () => showTab(false));
  el.tabAudit.addEventListener("click", () => showTab(true));
  el.aWho.addEventListener("change", renderAudit);
  el.aGroup.addEventListener("change", renderAudit);

  // Relative times and idle agent lines age without events.
  setInterval(() => { renderFeed(); renderAgents(); }, 30_000);
}

async function start(): Promise<void> {
  wire();
  el.modeLine.textContent = api.mode === "mock"
    ? "Demo data: the synthetic Axe Capital world at the start of the demo. Triage, relevance, scope builds and agent runs are simulated in the browser."
    : "Connected to Canon.";
  const me = await attempt("load your profile", () => api.me());
  if (!me.ok) return;
  S.me = me.value;
  el.greeting.textContent = `Hi, ${me.value.name}`;
  el.firm.textContent = me.value.firm ?? "";
  await refreshAll();
  S.sel = S.principals.find((p) => p.id === "dollar-bill")?.id ?? me.value.id;
  api.subscribe(onEvent, (s) => {
    if (s === "reconnecting") notify("Lost the live connection; retrying…");
    if (s === "live" && !S.replaying) scheduleRefresh();
  });
  S.replaying = false;
  renderAll();
}

void start();
