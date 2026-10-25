// `npm run reset -w server`: back to the demo world. Removes facts/, sessions/ and world/ under the
// data dir and seeds the demo world again (the 0:00 items; the server builds the 0:00 scopes on
// its next start). For QA and the demo, never for a real store. Refuses to run while the server is
// up, because the running process would keep writing into the directory it just emptied.

import { rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PORTS, dataDir, env, loadEnv } from "@canon/shared";

import { WORLD_DIR } from "./persist.ts";
import { seedDataDir } from "./seed.ts";

export async function resetDataDir(target: string): Promise<{ removed: string[]; facts: number; sessions: number }> {
  const removed: string[] = [];
  for (const sub of ["facts", "sessions", WORLD_DIR]) {
    await rm(resolve(target, sub), { recursive: true, force: true });
    removed.push(sub);
  }
  const seeded = await seedDataDir(target);
  return { removed, facts: seeded.facts, sessions: seeded.sessions };
}

async function serverIsUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnv();
  const url = env("CANON_URL", `http://127.0.0.1:${env("CANON_PORT", String(DEFAULT_PORTS.server))}`);
  if (await serverIsUp(url)) {
    console.error(`[reset] the server is up at ${url}; stop it first (it would keep writing into the directory being reset)`);
    process.exit(1);
  }
  const target = dataDir();
  const r = await resetDataDir(target);
  const rel = relative(process.cwd(), target);
  const shown = rel === "" ? "." : rel.startsWith("..") ? target : rel;
  console.info(`[reset] removed ${r.removed.join(", ")} under ${shown}; seeded ${r.facts} facts + ${r.sessions} sessions (the demo world at 0:00)`);
}
