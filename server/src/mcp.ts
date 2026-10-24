// The four MCP tools (task A2, with the Jev filter of task A7 in canon_context). Every call is
// scoped to the client token's grant. The tool bodies are plain functions (run*) so tests call
// them without a transport; createMcpServer() only wraps them in zod schemas and MCP results.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { DEFAULT_BUDGET_TOKENS, MCP_TOOLS, THRESHOLDS, canRead, cutToBudget, newSessionId, nowIso, timed } from "@canon/shared";
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
  Question,
  SaveInput,
  SaveOutput,
  SearchInput,
  SearchOutput,
  WhoamiOutput,
} from "@canon/shared";

import type { EventBus } from "./events.ts";
import type { Retriever } from "./retrieval/index.ts";
import type { FileStore } from "./store.ts";

export interface McpDeps {
  client: string;
  grant: Grant;
  store: FileStore;
  retriever: Retriever;
  bus: EventBus;
  judge: Judge;
}

/** How many candidates retrieval hands to Jev. One batched judge call covers all of them. */
export const CONTEXT_CANDIDATES = 20;
export const SEARCH_LIMIT = 25;
/** "Enough to answer?" has no threshold in CLAUDE.md; 0.5 is a judge's neutral default, so > 0.5 is a real yes. */
const ENOUGH_P = 0.5;
const ENOUGH_ID = "enough";

// ------------------------------------------------------------------ canon_context

export async function runContext(deps: McpDeps, input: ContextInput): Promise<ContextOutput> {
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

export type SearchResult = { ok: true; output: SearchOutput } | { ok: false; refused: string };

export async function runSearch(deps: McpDeps, input: SearchInput): Promise<SearchResult> {
  // Requested folders are intersected with the grant: anything outside it is a refusal, not a
  // silent narrowing, so the AI can explain itself (and call canon_whoami).
  let folders: readonly Folder[] = deps.grant.read;
  if (input.folders && input.folders.length > 0) {
    for (const f of input.folders) {
      if (!canRead(deps.grant, f)) {
        deps.bus.emit({ type: "access.denied", client: deps.client, tool: MCP_TOOLS.search, folder: f });
        return { ok: false, refused: `refused: ${deps.client} cannot read ${f}. Call canon_whoami to see your folders.` };
      }
    }
    folders = input.folders;
  }
  const hits = await deps.retriever.search(input.query, { folders, k: SEARCH_LIMIT });
  return { ok: true, output: { facts: hits.map((h) => h.fact) } };
}

// --------------------------------------------------------------------- canon_save

/** Never straight to hot: the text becomes a one-message session in the cold archive. */
export async function runSave(deps: McpDeps, input: SaveInput): Promise<SaveOutput> {
  const now = nowIso();
  const session: CapturedSession = {
    id: newSessionId(),
    client: deps.client,
    started_at: now,
    ended_at: now,
    title: input.text.slice(0, 80),
    messages: [{ role: "user", content: input.text }],
    meta: { folder_hint: input.folder },
  };
  await deps.store.putSession(session);
  deps.bus.emit({
    type: "session.captured",
    session: { id: session.id, client: deps.client, title: session.title, messages: 1, ended: true },
  });
  return { queued: true, session_id: session.id };
}

// ------------------------------------------------------------------- canon_whoami

export function runWhoami(deps: McpDeps): WhoamiOutput {
  return { client: deps.client, read: [...deps.grant.read], write: [...deps.grant.write] };
}

// ------------------------------------------------------------------ MCP wrapping

function ok(output: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
}

function refused(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** A fresh McpServer per request (stateless Streamable HTTP), bound to one client's grant. */
export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "canon", version: "0.1.0" });

  server.registerTool(
    MCP_TOOLS.context,
    {
      title: "Relevant context for a task",
      description:
        "The small slice of the user's stored context that is relevant to a task: facts from past AI sessions, filtered by Jev and cut to a token budget. Call it at the start of a task instead of asking the user to repeat themselves.",
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
      description: "Search the user's stored facts within the folders this client may read. Optional folders narrow the search; a folder outside the grant is refused.",
      inputSchema: {
        query: z.string().min(1),
        folders: z.array(z.string()).optional().describe('e.g. ["career/skills"]'),
      },
    },
    async (args) => {
      const r = await runSearch(deps, { query: args.query, folders: args.folders as Folder[] | undefined });
      return r.ok ? ok({ ...r.output }) : refused(r.refused);
    },
  );

  server.registerTool(
    MCP_TOOLS.save,
    {
      title: "Remember this",
      description: "Queue text to be remembered. It goes to the cold archive; the distiller and Jev then decide what becomes a hot fact and where it is filed. Nothing is written to hot facts directly.",
      inputSchema: {
        text: z.string().min(1),
        folder: z.string().optional().describe("Hint only, e.g. projects/canon. Jev decides."),
      },
    },
    async (args) => ok({ ...(await runSave(deps, { text: args.text, folder: args.folder as Folder | undefined })) }),
  );

  server.registerTool(
    MCP_TOOLS.whoami,
    {
      title: "Who am I",
      description: "The folders this client can read and write. Call it to explain a refusal.",
      inputSchema: {},
    },
    async () => ok({ ...runWhoami(deps) }),
  );

  return server;
}
