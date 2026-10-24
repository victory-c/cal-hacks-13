// Run the pipeline on one recorded session, no server needed:
//   npm run distill -w distiller -- fixtures/session.sample.json [--engine heuristic|claude|droid] [--post]
// Prints the plan, the drafts and Jev's decisions as a table and as JSON. --post sends the
// decided facts to the running server (and judges against its real hot facts).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_SERVER_URL, createJudge, env, loadEnv } from "@canon/shared";
import type { CapturedSession, DistillEngine, Fact } from "@canon/shared";
import { createClient } from "./client.ts";
import { decideFacts } from "./decide.ts";
import { createDistiller } from "./engines/index.ts";
import { errorMessage } from "./log.ts";

const USAGE = "usage: npm run distill -w distiller -- <session.json> [--engine heuristic|claude|droid] [--post]";

async function main(argv: string[]): Promise<number> {
  loadEnv();
  const args = parseArgs(argv);
  if (!args.file) {
    console.error(USAGE);
    return 2;
  }

  const session = readSession(args.file);
  const distiller = createDistiller(args.engine ? { engine: args.engine } : {});
  const judge = createJudge();

  const client = args.post
    ? createClient({ baseUrl: env("CANON_URL", DEFAULT_SERVER_URL), token: env("CANON_TOKEN_DISTILLER", "dev-distiller") })
    : undefined;
  const existingHot: Fact[] = client ? await client.listFacts({ tier: "hot" }) : [];

  const t0 = performance.now();
  const result = await distiller.distill(session);
  const distillMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const decided = await decideFacts(result.drafts, existingHot, judge);
  const judgeMs = Math.round(performance.now() - t1);

  console.log(`session   ${session.id} (${session.client}, ${session.messages.length} messages${session.ended_at ? ", ended" : ""})`);
  console.log(`engine    ${distiller.name}${result.simulated ? " (simulated)" : ""}  ${distillMs} ms${result.usage ? `  tokens in/out ${result.usage.input_tokens}/${result.usage.output_tokens}` : ""}`);
  console.log(`judge     ${judge.name}${judge.name === "fake" ? " (simulated)" : ""}  ${judgeMs} ms, ${existingHot.length} existing hot facts`);
  console.log(`plan      ${result.plan ?? "(none)"}`);

  console.log(`\ndrafts (${result.drafts.length})`);
  table([["#", "folder?", "statement"], ...result.drafts.map((d, i) => [String(i), d.folder ?? "-", d.statement])]);

  console.log(`\ndecisions (${decided.length})`);
  table([
    ["#", "tier", "folder", "action", "keep_p", "statement"],
    ...decided.map((d, i) => [String(i), d.decision.tier, d.decision.folder, d.decision.action + (d.decision.supersedes ? ` ${d.decision.supersedes}` : ""), d.decision.keep_p.toFixed(2), d.fact.statement]),
  ]);

  console.log("\njson");
  console.log(JSON.stringify({ engine: distiller.name, simulated: result.simulated, plan: result.plan, usage: result.usage, drafts: result.drafts, facts: decided }, null, 2));

  if (client) {
    const res = await client.postFacts({ facts: decided });
    console.log(`\nposted: saved ${res.saved.length} (${res.saved.join(", ")}), retired ${res.retired.length}`);
  }
  return 0;
}

function parseArgs(argv: string[]): { file?: string; engine?: DistillEngine; post: boolean } {
  const out: { file?: string; engine?: DistillEngine; post: boolean } = { post: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--post") out.post = true;
    else if (a === "--engine") {
      const v = argv[++i];
      if (!v) throw new Error(`--engine needs a value. ${USAGE}`);
      out.engine = v as DistillEngine; // createDistiller validates it
    } else if (a.startsWith("--")) throw new Error(`unknown flag ${a}. ${USAGE}`);
    else out.file = a;
  }
  return out;
}

function readSession(file: string): CapturedSession {
  // `npm run -w distiller` changes cwd to distiller/; INIT_CWD is where the user actually typed
  // the command, so both `fixtures/x.json` (from here) and `distiller/fixtures/x.json` (from
  // the repo root) work.
  const candidates = [...new Set([resolve(process.env.INIT_CWD ?? process.cwd(), file), resolve(file)])];
  const path = candidates.find((p) => existsSync(p));
  if (!path) throw new Error(`cannot find ${file} (looked at ${candidates.join(" and ")})`);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${path}: ${errorMessage(err)}`);
  }
  const s = json as Partial<CapturedSession>;
  if (typeof s?.id !== "string" || typeof s.client !== "string" || !Array.isArray(s.messages)) {
    throw new Error(`${path} is not a CapturedSession: need id, client and messages[] (see shared/src/types/session.ts)`);
  }
  return s as CapturedSession;
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
