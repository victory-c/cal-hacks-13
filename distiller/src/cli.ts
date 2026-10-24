// Run the pipeline on one recorded item, no server needed:
//   npm run distill -w distiller -- <session.json> [--engine heuristic|claude|droid] [--groups <file> | --post]
// Prints the plan, the drafts and the triage (outcome, group, labels, Jev's answers, relation) as
// tables and as JSON. The writer and triage get the same group list (the writer's group is a
// hint; triage decides). Groups come from --groups (a GroupsResponse JSON file), else from
// fixtures/world/groups.json when it exists. With --post they come from the server only: --groups
// is refused and the fixture is never read, since the result is filed on that server and a local
// list could file a fact in a group the server does not have, or skip the inbox fallback. Without
// a group list every fact goes to inbox (the worker's rule). --post files the result on the
// running server exactly as the worker does: facts, the quarantine item, events.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_SERVER_URL, createJudge, env, loadEnv } from "@canon/shared";
import type { CapturedSession, DistillEngine, Fact, Group } from "@canon/shared";
import { createClient, parseGroups } from "./client.ts";
import type { CanonClient } from "./client.ts";
import { createDistiller } from "./engines/index.ts";
import { errorMessage } from "./log.ts";
import { provenance, triage, triageJudge } from "./triage.ts";
import type { TriageResult } from "./triage.ts";
import { deliver, describeUnsent, loadContext, onceWarner } from "./worker.ts";
import type { WarnOnce } from "./worker.ts";

const USAGE = "usage: npm run distill -w distiller -- <session.json> [--engine heuristic|claude|droid] [--groups <file> | --post]";
const WORLD_GROUPS = fileURLToPath(new URL("../fixtures/world/groups.json", import.meta.url));

interface Args {
  file?: string;
  engine?: DistillEngine;
  groups?: string;
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
  // Silent here: the groups line below says where they came from. With --post the result is filed
  // on that server, so its own groups are the only ones that count (parseArgs refuses --groups
  // with it): a server without them gets every fact in inbox, never a local file's or the fixture's.
  const server = client ? await loadContext(client, () => {}) : undefined;
  const existing: Fact[] = server?.existing ?? [];
  const groups = client ? serverSource(server?.groupsKnown ? server.groups : undefined) : pickSource(args.groups, WORLD_GROUPS, readGroups);

  // The writer gets the same list triage files against (none: no draft carries a group). Its
  // group is a hint in the drafts; triage decides.
  const t0 = performance.now();
  const result = await distiller.distill(session, { groups: groups.value ?? [] });
  const distillMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const triaged = await triage({ session, drafts: result.drafts, existing, groups: groups.value ?? [], groupsKnown: groups.value !== undefined }, judge);
  const judgeMs = Math.round(performance.now() - t1);

  // As triage reads it: a missing kind or external flag is unknown, not ai_session or internal.
  const from = provenance(session);
  const origin = from.external === true ? "external" : from.external === false ? "" : "origin unknown";
  const owner = from.principal === "unknown" ? "owner unknown" : `author ${from.principal}`;
  const flags = [from.kind === "unknown" ? "kind unknown" : from.kind, `${session.messages.length} messages`, session.ended_at ? "ended" : "", origin, owner].filter(Boolean);
  console.log(`session   ${session.id} (${session.client}, ${flags.join(", ")})`);
  console.log(`engine    ${distiller.name}${result.simulated ? " (simulated)" : ""}  ${distillMs} ms${result.usage ? `  tokens in/out ${result.usage.input_tokens}/${result.usage.output_tokens}` : ""}`);
  console.log(`judge     ${judge.name}${judge.name === "fake" ? " (simulated, finance rules)" : ""}  ${judgeMs} ms, one request, ${existing.length} existing facts`);
  console.log(`groups    ${groups.value ? `${groups.value.length} from ${groups.from}: ${groups.value.map((g) => g.id).join(", ") || "none"}` : `none (${groups.from})`}`);
  if (!groups.value) console.log("          no group list: every fact is filed in inbox (moderators only)");
  console.log(`plan      ${result.plan ?? "(none)"}`);
  console.log(`inject    p ${triaged.injection_p.toFixed(2)}${triaged.quarantine ? `  QUARANTINED: ${triaged.quarantine.item.excerpt}` : ""}`);
  if (triaged.quarantine) console.log(`          ${triaged.quarantine.summary}`);

  console.log(`\ndrafts (${result.drafts.length})`);
  table([["#", "group?", "labels?", "happened", "statement"], ...result.drafts.map((d, i) => [String(i), d.folder ?? "-", d.labels?.join(",") || "-", d.happened ?? "-", d.statement])]);

  console.log(`\ntriage (${triaged.drafts.length})`);
  table([
    ["#", "outcome", "group", "keep", "jev group", "labels", "relation", "action", "statement"],
    ...triaged.drafts.map((t, i) => {
      const d = t.decision;
      return [
        String(i),
        d.outcome,
        d.group + (d.new_group ? ` (new: ${d.new_group})` : ""),
        d.keep_p.toFixed(2),
        d.group_p.toFixed(2),
        d.labels.join(",") || "-",
        d.relation + (d.relation_to ? ` ${d.relation_to}` : ""),
        t.save ? t.save.action + (t.save.supersedes ? ` ${t.save.supersedes}` : "") : "-",
        t.draft.statement,
      ];
    }),
  ]);
  const why = triaged.drafts.filter((t) => t.decision.outcome !== "fact");
  if (why.length) {
    console.log("\nwhy (moderators only)");
    table([["#", "reason"], ...why.map((t) => [String(triaged.drafts.indexOf(t)), t.decision.reason])]);
  }

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
        triage: triaged.drafts.map((t) => ({ statement: t.draft.statement, decision: t.decision, fact: t.fact, save: t.save })),
      },
      null,
      2,
    ),
  );

  return client ? await post(client, triaged, warnOnce) : 0;
}

async function post(client: CanonClient, triaged: TriageResult, warnOnce: WarnOnce): Promise<number> {
  const res = await deliver(client, triaged, warnOnce);
  console.log(`\nposted: saved ${res.saved.length} (${res.saved.join(", ") || "none"}), retired ${res.retired.length}, ${res.quarantined} quarantine items, ${res.events} events`);
  if (!res.unsent) return 0;
  // One shot, no retry loop here: say what is missing instead of exiting 0.
  console.error(`[distiller] not filed, the server failed: ${describeUnsent(res.unsent)}. The facts are saved; re-running --post would write them again.`);
  return 1;
}

/** With --post: what the server gave, or nothing. Never a local file. */
function serverSource(fromServer: Group[] | undefined): { value?: Group[]; from: string } {
  if (fromServer !== undefined) return { value: fromServer, from: "the server" };
  return { from: "the server gave no group list; --post never falls back to a local file" };
}

/** Without --post: the --groups file, else the world fixture if it exists, else nothing. */
function pickSource(flag: string | undefined, fixture: string, read: (path: string) => Group[]): { value?: Group[]; from: string } {
  if (flag) {
    const path = findFile(flag);
    return { value: read(path), from: path };
  }
  if (existsSync(fixture)) return { value: read(fixture), from: fixture };
  return { from: `no --groups and no ${fixture}` };
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
    else if (a === "--groups") out.groups = value(++i, a);
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}. ${USAGE}`);
    else out.file = a;
  }
  // A posted result is filed on the server, in the server's groups. A local list could file a fact
  // in a group the server does not have, and against a server without GET /api/groups it would skip
  // the inbox fallback. Refused, not ignored, so nobody is surprised.
  if (out.post && out.groups) {
    throw new Error(`--groups cannot be used with --post: a posted result is filed in the server's groups only. ${USAGE}`);
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

/** A GroupsResponse ({ groups }) or a bare Group[], checked the way the worker checks the server's. */
function readGroups(path: string): Group[] {
  return parseGroups(readJson(path), path);
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
