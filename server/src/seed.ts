// `npm run seed -w server`: copies server/fixtures/ into the data dir, then writes the demo world's
// facts and raw items (fixtures/world/, see world.ts), so the demo has facts and sessions on a fresh
// machine. Existing files are never overwritten. Every fixture fact is parsed first, so a broken
// fixture fails here and not at 4 AM in the server log.

import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { dataDir, factPath, loadEnv, parseFactFile, serializeFactFile } from "@canon/shared";

import { sessionFingerprint } from "./store.ts";
import { loadDemoWorld } from "./world.ts";
import type { WorldMoment } from "./world.ts";

export const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));
/** The earlier Harbor Lane / Project Falcon facts, seeded only for the server tests' Falcon world. */
export const FALCON_FIXTURES_DIR = fileURLToPath(new URL("../fixtures/falcon/", import.meta.url));

export interface SeedResult {
  facts: number;
  sessions: number;
  skipped: number;
}

/**
 * Copies `fixtures` (facts/ and sessions/; null skips them) into `target`, then the demo world's
 * facts and items at `world` ("seed": what is loaded before the demo starts; "all": every
 * non-quarantined item, the benchmark's world; false: none).
 */
export async function seedDataDir(target: string, fixtures: string | null = FIXTURES_DIR, world: WorldMoment | false = "seed"): Promise<SeedResult> {
  const result: SeedResult = { facts: 0, sessions: 0, skipped: 0 };
  if (fixtures !== null) await copyFixtures(target, fixtures, result);
  if (world === false) return result;
  const demo = loadDemoWorld({ moment: world });
  for (const fact of demo.facts) {
    if (await writeIfMissing(join(target, factPath(fact)), serializeFactFile(fact))) result.facts++;
    else result.skipped++;
  }
  for (const session of demo.sessions) {
    if (await writeIfMissing(join(target, "sessions", `${session.id}.json`), JSON.stringify(session, null, 2) + "\n")) {
      result.sessions++;
      // Answer-key facts already materialize this exact fixture revision; never re-extract it.
      await writeIfMissing(join(target, "receipts", `${session.id}.json`), JSON.stringify({ fingerprint: sessionFingerprint(session) }) + "\n");
    } else result.skipped++;
  }
  return result;
}

async function copyFixtures(target: string, fixtures: string, result: SeedResult): Promise<void> {
  for (const rel of await listRelative(join(fixtures, "facts"), ".md")) {
    const src = join(fixtures, "facts", rel);
    parseFactFile(await readFile(src, "utf8")); // throws with the file's problem
    if (await copyIfMissing(src, join(target, "facts", rel))) result.facts++;
    else result.skipped++;
  }
  for (const rel of await listRelative(join(fixtures, "sessions"), ".json")) {
    const src = join(fixtures, "sessions", rel);
    JSON.parse(await readFile(src, "utf8"));
    if (await copyIfMissing(src, join(target, "sessions", rel))) result.sessions++;
    else result.skipped++;
  }
}

/** The "wx" flag makes "skip existing" atomic, like copyIfMissing. */
async function writeIfMissing(dest: string, content: string): Promise<boolean> {
  await mkdir(dirname(dest), { recursive: true });
  try {
    await writeFile(dest, content, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

async function listRelative(root: string, ext: string): Promise<string[]> {
  try {
    return (await readdir(root, { recursive: true })).filter((n) => n.endsWith(ext)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** COPYFILE_EXCL makes "skip existing" atomic: no check-then-copy race. */
async function copyIfMissing(src: string, dest: string): Promise<boolean> {
  await mkdir(dirname(dest), { recursive: true });
  try {
    await copyFile(src, dest, 1 /* fs.constants.COPYFILE_EXCL */);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

// Run as a script (tsx src/seed.ts), not when imported by a test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnv();
  const target = dataDir();
  const r = await seedDataDir(target);
  const rel = relative(process.cwd(), target);
  const shown = rel === "" ? "." : rel.startsWith("..") ? target : rel; // absolute when outside the cwd
  console.info(`[seed] ${r.facts} facts + ${r.sessions} sessions copied into ${shown}; ${r.skipped} already there`);
}
