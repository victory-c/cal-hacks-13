// Run the pipeline on one recorded item, no server needed:
//   npm run distill -w distiller -- <session.json> [--engine heuristic|claude|droid] [--deals <file> --lists <file> | --post]
// Prints the plan, the drafts and the triage (outcome, wall, Jev's answers, review items) as
// tables and as JSON. Deals and lists come from --deals / --lists (DealsResponse / ListsResponse
// JSON), else from fixtures/world/deals.json and lists.json when those exist. With --post they
// come from the server only: --deals / --lists are refused and the fixtures are never read, since
// the result is filed on that server and a local list could label public what its walls would
// not. Without both, nothing is labeled public and every fact goes to inbox (the worker's v1
// rule). --post files the result on the running server exactly as the worker does: facts, review
// items, events.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_SERVER_URL, createJudge, env, loadEnv } from "@canon/shared";
import type { CapturedSession, Deal, DistillEngine, Fact, ListsResponse } from "@canon/shared";
import { createClient, parseDeals, parseLists } from "./client.ts";
import type { CanonClient } from "./client.ts";
import { createDistiller } from "./engines/index.ts";
import { errorMessage } from "./log.ts";
import { triage, triageJudge } from "./triage.ts";
import type { TriageResult } from "./triage.ts";
import { deliver, describeUnsent, loadContext, onceWarner } from "./worker.ts";
import type { WarnOnce } from "./worker.ts";

const USAGE = "usage: npm run distill -w distiller -- <session.json> [--engine heuristic|claude|droid] [--deals <file> --lists <file> | --post]";
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
  // Silent here: the deals / lists lines below say where each came from. With --post the result
  // is filed on that server, so its own deals and lists are the only ones that count (parseArgs
  // refuses --deals / --lists with it): a server without them gets no public labels (and every
  // fact in inbox), never a local file's or the fixtures' world.
  const server = client ? await loadContext(client, () => {}) : undefined;
  const existing: Fact[] = server?.existing ?? [];
  const fromServer = server?.labelPublic ? server : undefined;
  const deals = client ? serverSource(fromServer?.deals) : pickSource("deals", args.deals, WORLD_DEALS, readDeals);
  const lists = client ? serverSource(fromServer?.lists) : pickSource("lists", args.lists, WORLD_LISTS, readLists);
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
  if (!labelPublic) console.log("          no deal list or no lists: nothing is labeled public and every fact is filed in inbox (walls may not be enforced)");
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

  return client ? await post(client, triaged, warnOnce) : 0;
}

async function post(client: CanonClient, triaged: TriageResult, warnOnce: WarnOnce): Promise<number> {
  const res = await deliver(client, triaged, warnOnce);
  console.log(`\nposted: saved ${res.saved.length} (${res.saved.join(", ") || "none"}), retired ${res.retired.length}, ${res.reviews} review items, ${res.events} events`);
  if (!res.unsent) return 0;
  // One shot, no retry loop here: say what is missing instead of exiting 0.
  console.error(`[distiller] not filed, the server failed: ${describeUnsent(res.unsent)}. The facts are saved; re-running --post would write them again.`);
  return 1;
}

/** With --post: what the server gave, or nothing. Never a local file. */
function serverSource<T>(fromServer: T | undefined): { value?: T; from: string } {
  if (fromServer !== undefined) return { value: fromServer, from: "the server" };
  return { from: "the server did not give both deals and lists; --post never falls back to local files" };
}

/** Without --post: the --flag file, else the world fixture if it exists, else nothing. */
function pickSource<T>(what: string, flag: string | undefined, fixture: string, read: (path: string) => T): { value?: T; from: string } {
  if (flag) {
    const path = findFile(flag);
    return { value: read(path), from: path };
  }
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
  // A posted result is filed on the server, whose walls are checked against its own deal list. A
  // local list could label public what the server would wall, and against a server without the
  // finance routes it would skip the inbox fallback. Refused, not ignored, so nobody is surprised.
  if (out.post && (out.deals || out.lists)) {
    throw new Error(`--deals and --lists cannot be used with --post: a posted result is labeled with the server's deals and lists only. ${USAGE}`);
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

/** A DealsResponse ({ deals }) or a bare Deal[], checked the way the worker checks the server's. */
function readDeals(path: string): Deal[] {
  return parseDeals(readJson(path), path);
}

function readLists(path: string): ListsResponse {
  return parseLists(readJson(path), path);
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
