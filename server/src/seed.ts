// `npm run seed -w server`: copies server/fixtures/ into the data dir so the demo has facts and a
// session on a fresh machine. Existing files are never overwritten. Every fixture fact is parsed
// first, so a broken fixture fails here and not at 4 AM in the server log.

import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { dataDir, loadEnv, parseFactFile } from "@canon/shared";

export const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

export interface SeedResult {
  facts: number;
  sessions: number;
  skipped: number;
}

export async function seedDataDir(target: string, fixtures: string = FIXTURES_DIR): Promise<SeedResult> {
  const result: SeedResult = { facts: 0, sessions: 0, skipped: 0 };

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
  return result;
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
