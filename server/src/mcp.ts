// The four MCP tools (task A2, with the Jev filter of task A7 in canon_context). What a call may
// see depends on the token's class (docs/PIPELINE-PRD.md §4.2):
//
//   person / agent  the grant names a principal: every read is that principal's scope, through
//                   the same handoff the Claude Code hook uses (scopes.ts selfHandoff). Nothing
//                   outside the scope is named, counted or hinted at.
//   operator        a capture client with no principal (claude-code, chatgpt): the scaffold's
//                   folder grants, unchanged.
//
// The tool bodies are plain functions (run*) so tests call them without a transport;
// createMcpServer() only wraps them in zod schemas and MCP results.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { DEFAULT_BUDGET_TOKENS, MCP_TOOLS, THRESHOLDS, canRead, cutToBudget, folderAllows, newSessionId, nowIso, timed } from "@canon/shared";
import type {
  Answer,
  CapturedSession,
  ContextFact,
  ContextInput,
  ContextOutput,
  Fact,
  Folder,
  Grant,
  Judge,
  Principal,
  Question,
  SaveInput,
  SaveOutput,
  SearchInput,
  SearchOutput,
  WhoamiOutput,
} from "@canon/shared";

import type { EventBus } from "./events.ts";
import { HttpError } from "./http.ts";
import type { Retriever } from "./retrieval/index.ts";
import { callerRoles, hotCandidates, scopeFacts, selfHandoff } from "./scopes.ts";
import type { ScopeState, ScopesDeps } from "./scopes.ts";
import type { FileStore } from "./store.ts";

export interface McpDeps {
  client: string;
  grant: Grant;
  store: FileStore;
  retriever: Retriever;
  bus: EventBus;
  judge: Judge;
  world: ScopeState;
  grants: readonly Grant[];
}

/** How many candidates retrieval hands to Jev. One batched judge call covers all of them. */
export const CONTEXT_CANDIDATES = 20;
export const SEARCH_LIMIT = 25;
/** "Enough to answer?" has no threshold in CLAUDE.md; 0.5 is a judge's neutral default, so > 0.5 is a real yes. */
const ENOUGH_P = 0.5;
const ENOUGH_ID = "enough";

/** The principal this token acts as, when its grant names one (a person or an agent). */
export function principalOf(deps: McpDeps): Principal | undefined {
  return callerRoles(deps.world, deps.grants, deps.client).principal;
}

function scopesDeps(deps: McpDeps): ScopesDeps {
  return { world: deps.world, store: deps.store, bus: deps.bus, grants: deps.grants, judge: deps.judge, retriever: deps.retriever };
}

/** Everything a principal may ever read: their scope, or every hot fact in a world group for a moderator. */
function universeOf(deps: McpDeps, who: Principal): Fact[] {
  const sd = scopesDeps(deps);
  return who.kind === "person" && who.tier === "moderator" ? hotCandidates(sd) : scopeFacts(sd, who.id);
}

// ------------------------------------------------------------------ canon_context

export async function runContext(deps: McpDeps, input: ContextInput): Promise<ContextOutput> {
  const who = principalOf(deps);
  if (who) return contextForPrincipal(deps, who, input);
  return contextForOperator(deps, input);
}

/**
 * A person's or agent's memory for this task: the self handoff (search inside the scope, the
 * needs-context check, Jev relevance, the token budget, an audit row), with the pinned profile.
 * No `candidates`, no `missing`: what was considered and what the memory lacks are not theirs
 * to know.
 */
async function contextForPrincipal(deps: McpDeps, who: Principal, input: ContextInput): Promise<ContextOutput> {
  const task = input.task.trim();
  if (!task) throw new HttpError(400, "task must be a non-empty string");
  const body: Record<string, unknown> = { task };
  if (input.budget_tokens !== undefined) body.budget_tokens = input.budget_tokens;
  const r = await selfHandoff(scopesDeps(deps), deps.client, who, body);
  const enough = r.facts.length > 0;
  // The dashboard's counter reads context.served; the handoff already emitted handoff.served for the inspector.
  deps.bus.emit({
    type: "context.served",
    client: deps.client,
    task,
    fact_ids: r.facts.map((f) => f.id),
    candidates: r.facts.length,
    tokens: r.tokens,
    latency_ms: r.latency_ms,
    enough,
  });
  return { facts: r.facts, tokens: r.tokens, latency_ms: r.latency_ms, enough, profile: r.profile };
}

/** The scaffold path for operator tokens: retrieval over the folder grant, one batched judge call, the budget. */
async function contextForOperator(deps: McpDeps, input: ContextInput): Promise<ContextOutput> {
  const t0 = performance.now();
  const task = input.task.trim();
  const budget = input.budget_tokens ?? DEFAULT_BUDGET_TOKENS;

  const { result: hits, ms: retrieval_ms } = await timed(() =>
    deps.retriever.search(task, { folders: deps.grant.read, k: CONTEXT_CANDIDATES }),
  );

  // One judge.ask() for the whole batch (CLAUDE.md rule): a relevance question per candidate
  // plus the "enough?" question. With no candidates there is nothing to ask.
  let judge_ms = 0;
  let judgeError: string | undefined;
  let relevant: Array<{ fact: ContextFact; p: number }> = [];
  let enoughP = 0;
  if (hits.length > 0) {
    const state = [`Task: ${task}`, "", "Candidate facts:", ...hits.map((h, i) => `${i + 1}. [${h.fact.id}] ${h.fact.statement}`)].join("\n");
    const questions: Question[] = hits.map((h) => ({
      id: h.fact.id,
      type: "noul",
      text: `Is this fact relevant to the task? "${h.fact.statement}"`,
    }));
    questions.push({ id: ENOUGH_ID, type: "noul", text: "Is this enough to answer the task?" });

    // A flaky judge (Jev timeout or 5xx, Claude 429) must not turn the headline tool into an MCP
    // error. With no answers nothing passes the relevance threshold, so nothing unjudged is
    // served; the call still succeeds, emits context.served and says why in `missing`.
    let answers: Answer[] = [];
    const tJudge = performance.now();
    try {
      const judged = await timed(() => deps.judge.ask(state, questions));
      judge_ms = judged.ms;
      answers = judged.result;
    } catch (err) {
      judge_ms = Math.round(performance.now() - tJudge);
      judgeError = err instanceof Error ? err.message : String(err);
      console.error(`[mcp] judge ${deps.judge.name} failed: ${judgeError}`);
    }
    const p = noulAnswers(answers);
    enoughP = p.get(ENOUGH_ID) ?? 0.5;
    relevant = hits
      .map((h) => ({ fact: toContextFact(h.fact, p.get(h.fact.id) ?? 0.5), p: p.get(h.fact.id) ?? 0.5 }))
      .filter((c) => c.p > THRESHOLDS.RELEVANT)
      .sort((a, b) => b.p - a.p);
  }

  const { kept, tokens } = cutToBudget(
    relevant.map((c) => c.fact),
    budget,
  );
  const enough = kept.length > 0 && enoughP > ENOUGH_P;
  const latency_ms = Math.round(performance.now() - t0);

  deps.bus.emit({
    type: "context.served",
    client: deps.client,
    task,
    fact_ids: kept.map((f) => f.id),
    candidates: hits.length,
    tokens,
    latency_ms,
    retrieval_ms,
    judge_ms,
    enough,
  });

  const out: ContextOutput = { facts: kept, tokens, latency_ms, enough, candidates: hits.length };
  if (judgeError) out.missing = `Judge ${deps.judge.name} failed (${judgeError}), so ${hits.length} candidate(s) could not be checked for: ${task}`;
  else if (!enough) out.missing = `No stored fact covers: ${task}`;
  return out;
}

/** Fact → ContextFact: drops tier/jev_keep/supersedes (the AI does not need them) and adds Jev's relevance. */
function toContextFact(f: Fact, relevance: number): ContextFact {
  const out: ContextFact = { id: f.id, statement: f.statement, folder: f.folder, updated: f.updated, source: f.source, relevance };
  if (f.detail) out.detail = f.detail;
  return out;
}

/** id → P(yes) for the noul answers. Other answer types are ignored. */
function noulAnswers(answers: Answer[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of answers) if (a.type === "noul") out.set(a.id, a.p);
  return out;
}

// ------------------------------------------------------------------- canon_search

export async function runSearch(deps: McpDeps, input: SearchInput): Promise<SearchOutput> {
  const who = principalOf(deps);
  if (who) return searchForPrincipal(deps, who, input);
  return searchForOperator(deps, input);
}

/**
 * Search inside the principal's scope. `folders` narrow within it; a folder the scope has nothing
 * in is simply not searched (no error, no hint). Every hit is re-checked against the scope's ids
 * in code, so a stale index can never surface an outside fact. `supersedes` is dropped: the fact
 * it names may be outside the scope.
 */
async function searchForPrincipal(deps: McpDeps, who: Principal, input: SearchInput): Promise<SearchOutput> {
  const query = input.query.trim();
  if (!query) return { facts: [] };
  const universe = universeOf(deps, who);
  const byId = new Map(universe.map((f) => [f.id, f]));
  const inScopeFolders = [...new Set(universe.map((f) => f.folder))];
  const requested = input.folders && input.folders.length > 0 ? input.folders : undefined;
  const folders = requested ? inScopeFolders.filter((f) => folderAllows(requested, f)) : inScopeFolders;
  if (folders.length === 0) return { facts: [] };
  const hits = await deps.retriever.search(query, { folders, k: SEARCH_LIMIT });
  const facts: Fact[] = [];
  for (const h of hits) {
    const fact = byId.get(h.fact.id);
    if (!fact || (requested && !folderAllows(requested, fact.folder))) continue;
    const { supersedes: _outside, ...own } = fact;
    facts.push(own);
  }
  return { facts };
}

async function searchForOperator(deps: McpDeps, input: SearchInput): Promise<SearchOutput> {
  // Requested folders are intersected with the grant. A folder outside it is dropped silently and
  // the answer is an ordinary (possibly empty) result: no refusal, nothing that says it exists
  // (CLAUDE.md). Moderators still see the probe as access.denied on the event stream.
  let folders: readonly Folder[] = deps.grant.read;
  if (input.folders && input.folders.length > 0) {
    folders = input.folders.filter((f) => {
      if (canRead(deps.grant, f)) return true;
      deps.bus.emit({ type: "access.denied", client: deps.client, tool: MCP_TOOLS.search, folder: f });
      return false;
    });
    if (folders.length === 0) return { facts: [] };
  }
  const hits = await deps.retriever.search(input.query, { folders, k: SEARCH_LIMIT });
  return { facts: hits.map((h) => h.fact) };
}

// --------------------------------------------------------------------- canon_save

/**
 * Queues text for distillation as a one-message note from this token's principal (an agent's
 * outputs are its creator's memory). The distiller and Jev decide what becomes a fact and where;
 * nothing is written to hot facts here. `kind: "note"` and `external: false`: the firm's own text.
 */
export async function runSave(deps: McpDeps, input: SaveInput): Promise<SaveOutput> {
  const who = principalOf(deps);
  const now = nowIso();
  const session: CapturedSession = {
    id: newSessionId(),
    client: deps.client,
    started_at: now,
    ended_at: now,
    kind: "note",
    external: false,
    messages: [{ role: "user", content: input.text }],
    meta: { source: "canon_save", ...(input.folder ? { folder_hint: input.folder } : {}) },
  };
  const principal = who ? (who.kind === "agent" ? who.created_by ?? who.id : who.id) : deps.grant.principal;
  if (principal !== undefined) session.principal = principal;
  await deps.store.putSession(session);
  deps.bus.emit({
    type: "session.captured",
    session: { id: session.id, client: session.client, messages: 1, ended: true },
  });
  return { queued: true, session_id: session.id };
}

// ------------------------------------------------------------------- canon_whoami

/** Who this token is. A person or agent: name, tier and task, never exclusions, groups or counts. An operator: its folder grant. */
export function runWhoami(deps: McpDeps): WhoamiOutput {
  const who = principalOf(deps);
  if (!who) return { client: deps.client, read: [...deps.grant.read], write: [...deps.grant.write] };
  const out: WhoamiOutput = { client: deps.client, principal: who.id, name: who.name };
  if (who.kind === "person" && who.tier) out.tier = who.tier;
  if (who.kind === "agent" && who.created_by) out.created_by = who.created_by;
  const task = deps.world.rules.get(who.id)?.task;
  if (task) out.task = task;
  return out;
}

// ------------------------------------------------------------------ MCP wrapping

function ok(output: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
}

/** A fresh McpServer per request (stateless Streamable HTTP), bound to one client's token. */
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "bullwark", version: "0.2.0" });

  server.registerTool(
    MCP_TOOLS.context,
    {
      title: "Get context for a task",
      description:
        "Hand over the stored facts this task needs, within a token budget. Call it before answering a question that could depend on the firm's or your own earlier work. Returns facts with their relevance, the pinned profile, and whether anything was found.",
      inputSchema: {
        task: z.string().min(1).describe("What you are about to do, in one or two sentences."),
        budget_tokens: z.number().int().positive().optional().describe(`Max tokens to hand back (default ${DEFAULT_BUDGET_TOKENS}).`),
      },
    },
    async (args) => ok({ ...(await runContext(deps, args)) }),
  );

  server.registerTool(
    MCP_TOOLS.search,
    {
      title: "Search stored facts",
      description: "Search the facts in your memory by keyword. Optional folders narrow the search.",
      inputSchema: {
        query: z.string().min(1),
        folders: z.array(z.string()).optional().describe('e.g. ["market/public"]'),
      },
    },
    async (args) => ok({ ...(await runSearch(deps, { query: args.query, folders: args.folders as Folder[] | undefined })) }),
  );

  server.registerTool(
    MCP_TOOLS.save,
    {
      title: "Remember this",
      description: "Queue text to be remembered as your own memory. It goes to the cold archive; the distiller and Jev then decide what becomes a fact and where it is filed. Nothing is written to hot facts directly.",
      inputSchema: {
        text: z.string().min(1),
        folder: z.string().optional().describe("Hint only, e.g. market/public. Jev decides."),
      },
    },
    async (args) => ok({ ...(await runSave(deps, { text: args.text, folder: args.folder as Folder | undefined })) }),
  );

  server.registerTool(
    MCP_TOOLS.whoami,
    {
      title: "Who am I",
      description: "Who this token acts as: name, tier and standing task.",
      inputSchema: {},
    },
    async () => ok({ ...runWhoami(deps) }),
  );

  return server;
}
