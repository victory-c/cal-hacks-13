// Run the pipeline on one recorded item, no server needed:
//   npm run distill -w distiller -- <session.json> [--engine heuristic|claude|droid] [--deals <file>] [--lists <file>] [--post]
// Prints the plan, the drafts and the triage (outcome, wall, Jev's answers, review items) as
// tables and as JSON. Deals and lists come from --deals / --lists (DealsResponse / ListsResponse
// JSON); else from the server with --post; else from fixtures/world/deals.json and lists.json when
// those exist. Without both, nothing is labeled public (the worker's v1 rule). --post files the
// result on the running server exactly as the worker does: facts, review items, events.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEAL_STATUSES, DEFAULT_SERVER_URL, createJudge, env, isDealWall, loadEnv } from "@canon/shared";
import type { CapturedSession, Deal, DealStatus, DistillEngine, Fact, ListsResponse, RestrictedEntry } from "@canon/shared";
import { createClient } from "./client.ts";
import type { CanonClient } from "./client.ts";
import { createDistiller } from "./engines/index.ts";
import { errorMessage } from "./log.ts";
import { triage, triageJudge } from "./triage.ts";
import type { TriageResult } from "./triage.ts";
import { deliver, loadContext, onceWarner } from "./worker.ts";
import type { WarnOnce } from "./worker.ts";

const USAGE = "usage: npm run distill -w distiller -- <session.json> [--engine heuristic|claude|droid] [--deals <file>] [--lists <file>] [--post]";
const WORLD_DEALS = fileURLToPath(new URL("../fixtures/world/deals.json", import.meta.url));
const WORLD_LISTS = fileURLToPath(new URL("../fixtures/world/lists.json", import.meta.url));

interface Args {
  file?: string;
  engine?: DistillEngine;
  deals?: string;
  lists?: string;
  post: boolean;
}

async function main(argv: string[]): Promise<number> {
  loadEnv();
  const args = parseArgs(argv);
  if (!args.file) {
    console.error(USAGE);
    return 2;
  }

  const session = readSession(args.file);
  const distiller = createDistiller(args.engine ? { engine: args.engine } : {});
  const judge = triageJudge(createJudge());
  const warnOnce = onceWarner();

  const client = args.post
    ? createClient({ baseUrl: env("CANON_URL", DEFAULT_SERVER_URL), token: env("CANON_TOKEN_DISTILLER", "dev-distiller") })
    : undefined;
  // Silent here: a server without the v2 routes just means the fixtures (or nothing) are used,
  // and the deals / lists lines below say which.
  const server = client ? await loadContext(client, () => {}) : undefined;
  const existing: Fact[] = server?.existing ?? [];
  const deals = pickSource("deals", args.deals, server ? (server.labelPublic ? server.deals : undefined) : undefined, WORLD_DEALS, readDeals);
  const lists = pickSource("lists", args.lists, server ? (server.labelPublic ? server.lists : undefined) : undefined, WORLD_LISTS, readLists);
  const labelPublic = deals.value !== undefined && lists.value !== undefined;

  const t0 = performance.now();
  const result = await distiller.distill(session);
  const distillMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const triaged = await triage({ session, drafts: result.drafts, existing, deals: deals.value ?? [], lists: lists.value ?? { restricted: [] }, labelPublic }, judge);
  const judgeMs = Math.round(performance.now() - t1);

  const flags = [session.kind ?? "ai_session", `${session.messages.length} messages`, session.ended_at ? "ended" : "", session.external ? "external" : ""].filter(Boolean);
  console.log(`session   ${session.id} (${session.client}, ${flags.join(", ")})`);
  console.log(`engine    ${distiller.name}${result.simulated ? " (simulated)" : ""}  ${distillMs} ms${result.usage ? `  tokens in/out ${result.usage.input_tokens}/${result.usage.output_tokens}` : ""}`);
  console.log(`judge     ${judge.name}${judge.name === "fake" ? " (simulated, finance rules)" : ""}  ${judgeMs} ms, one request, ${existing.length} existing facts`);
  console.log(`deals     ${deals.value ? `${deals.value.length} from ${deals.from}: ${deals.value.map((d) => `${d.id} (${d.status})`).join(", ") || "none"}` : `none (${deals.from})`}`);
  console.log(`lists     ${lists.value ? `${lists.value.restricted.length} restricted, ${lists.value.watch?.length ?? 0} watch from ${lists.from}` : `none (${lists.from})`}`);
  if (!labelPublic) console.log("          no deal list or no lists: nothing is labeled public (unlabeled is the safe default)");
  console.log(`plan      ${result.plan ?? "(none)"}`);
  console.log(`inject    p ${triaged.injection_p.toFixed(2)}${triaged.quarantine ? `  QUARANTINED: ${triaged.quarantine.excerpt ?? ""}` : ""}`);

  console.log(`\ndrafts (${result.drafts.length})`);
  table([["#", "folder?", "happened", "statement"], ...result.drafts.map((d, i) => [String(i), d.folder ?? "-", d.happened ?? "-", d.statement])]);

  console.log(`\ntriage (${triaged.drafts.length})`);
  table([
    ["#", "outcome", "wall", "keep", "conf", "deal", "relation", "action", "statement"],
    ...triaged.drafts.map((t, i) => {
      const d = t.decision;
      const wall = t.fact ? (t.fact.wall ?? `unlabeled${d.outcome === "compliance" ? ` (proposed ${d.wall})` : ""}`) : `(${d.wall})`;
      return [
        String(i),
        d.outcome,
        wall,
        d.keep_p.toFixed(2),
        d.confidential_p.toFixed(2),
        `${d.deal} ${d.deal_p.toFixed(2)}`,
        d.relation + (d.relation_to ? ` ${d.relation_to}` : ""),
        t.save ? t.save.action + (t.save.supersedes ? ` ${t.save.supersedes}` : "") : "-",
        t.draft.statement,
      ];
    }),
  ]);

  const reviews = [...(triaged.quarantine ? [triaged.quarantine] : []), ...triaged.drafts.flatMap((t) => (t.review ? [t.review] : []))];
  console.log(`\nreview items (${reviews.length})`);
  if (reviews.length) table([["kind", "proposed", "summary"], ...reviews.map((r) => [r.kind, r.proposed_wall ?? "-", r.summary])]);

  console.log("\njson");
  console.log(
    JSON.stringify(
      {
        engine: distiller.name,
        simulated: result.simulated,
        judge: judge.name,
        plan: result.plan,
        usage: result.usage,
        injection_p: triaged.injection_p,
        quarantine: triaged.quarantine,
        drafts: result.drafts,
        triage: triaged.drafts.map((t) => ({ statement: t.draft.statement, decision: t.decision, fact: t.fact, save: t.save, review: t.review })),
      },
      null,
      2,
    ),
  );

  if (client) await post(client, triaged, warnOnce);
  return 0;
}

async function post(client: CanonClient, triaged: TriageResult, warnOnce: WarnOnce): Promise<void> {
  const res = await deliver(client, triaged, warnOnce);
  console.log(`\nposted: saved ${res.saved.length} (${res.saved.join(", ") || "none"}), retired ${res.retired.length}, ${res.reviews} review items, ${res.events} events`);
}

/** --flag file, else what the server gave, else the world fixture if it exists, else nothing. */
function pickSource<T>(what: string, flag: string | undefined, fromServer: T | undefined, fixture: string, read: (path: string) => T): { value?: T; from: string } {
  if (flag) {
    const path = findFile(flag);
    return { value: read(path), from: path };
  }
  if (fromServer !== undefined) return { value: fromServer, from: "the server" };
  if (existsSync(fixture)) return { value: read(fixture), from: fixture };
  return { from: `no --${what} and no ${fixture}` };
}

function parseArgs(argv: string[]): Args {
  const out: Args = { post: false };
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value. ${USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--post") out.post = true;
    else if (a === "--engine") out.engine = value(++i, a) as DistillEngine; // createDistiller validates it
    else if (a === "--deals") out.deals = value(++i, a);
    else if (a === "--lists") out.lists = value(++i, a);
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}. ${USAGE}`);
    else out.file = a;
  }
  return out;
}

/**
 * `npm run -w distiller` changes cwd to distiller/; INIT_CWD is where the user actually typed
 * the command, so both `fixtures/x.json` (from here) and `distiller/fixtures/x.json` (from the
 * repo root) work.
 */
function findFile(file: string): string {
  const candidates = [...new Set([resolve(process.env.INIT_CWD ?? process.cwd(), file), resolve(file)])];
  const path = candidates.find((p) => existsSync(p));
  if (!path) throw new Error(`cannot find ${file} (looked at ${candidates.join(" and ")})`);
  return path;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${path}: ${errorMessage(err)}`);
  }
}

function readSession(file: string): CapturedSession {
  const path = findFile(file);
  const s = readJson(path) as Partial<CapturedSession>;
  if (typeof s?.id !== "string" || typeof s.client !== "string" || !Array.isArray(s.messages)) {
    throw new Error(`${path} is not a CapturedSession: need id, client and messages[] (see shared/src/types/session.ts)`);
  }
  return s as CapturedSession;
}

/** A DealsResponse ({ deals }) or a bare Deal[]. A deal with no status is treated as confidential. */
function readDeals(path: string): Deal[] {
  const json = readJson(path) as { deals?: unknown } | unknown[];
  const raw = Array.isArray(json) ? json : json?.deals;
  if (!Array.isArray(raw)) throw new Error(`${path} is not a DealsResponse: need { deals: Deal[] } (see shared/src/types/walls.ts)`);
  return raw.map((d: Partial<Deal>, i) => {
    if (typeof d?.id !== "string" || !isDealWall(d.id) || typeof d.code_name !== "string") throw new Error(`${path}: deals[${i}] needs an id like deal_falcon and a code_name`);
    const status: DealStatus = (DEAL_STATUSES as readonly string[]).includes(d.status ?? "") ? (d.status as DealStatus) : "confidential";
    return {
      id: d.id,
      code_name: d.code_name,
      aliases: strings(d.aliases),
      companies: strings(d.companies),
      status,
      status_changed_at: typeof d.status_changed_at === "string" ? d.status_changed_at : "",
    };
  });
}

function readLists(path: string): ListsResponse {
  const json = readJson(path) as Partial<ListsResponse>;
  if (!Array.isArray(json?.restricted)) throw new Error(`${path} is not a ListsResponse: need { restricted: [], watch?: [] } (see shared/src/types/api.ts)`);
  const entries = (xs: unknown[]): RestrictedEntry[] => xs.filter((e): e is RestrictedEntry => typeof (e as RestrictedEntry)?.company === "string");
  const out: ListsResponse = { restricted: entries(json.restricted) };
  if (Array.isArray(json.watch)) out.watch = entries(json.watch);
  return out;
}

function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
}

function table(rows: string[][]): void {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => Math.min(r[c]?.length ?? 0, 90))));
  for (const r of rows) console.log("  " + r.map((cell, c) => cell.slice(0, 90).padEnd(widths[c])).join("  "));
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[distiller] ${errorMessage(err)}`);
    process.exit(1);
  },
);
