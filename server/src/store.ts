// FileStore: hot/cold facts as markdown files and raw sessions as JSON (task A3, cold archive).
// Plain files on purpose: the store opens in Obsidian and survives any crash at 4 AM. An
// in-memory index of facts (and session ids) is refreshed on every write, so reads never hit
// the disk except for a session body.
//
// Layout under the data dir:   facts/<folder>/<id>.md     sessions/<id>.json

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { SESSION_ID_RE, factPath, folderAllows, parseFactFile, serializeFactFile, validateFact } from "@canon/shared";
import type { CapturedSession, Fact, Folder, Tier } from "@canon/shared";

export interface ListFactsFilter {
  /** Granted-folder semantics: `career` also lists `career/skills`. */
  folder?: Folder;
  tier?: Tier;
}

export class FileStore {
  private readonly facts = new Map<string, Fact>();
  private readonly sessionIds = new Set<string>();

  constructor(readonly dir: string) {}

  // ---------------------------------------------------------------- loading

  /** Scans the data dir. Unparsable files are skipped with a warning, never thrown on. */
  async loadAll(): Promise<{ facts: number; sessions: number; skipped: number }> {
    this.facts.clear();
    this.sessionIds.clear();
    let skipped = 0;

    for (const file of await listFiles(join(this.dir, "facts"), ".md")) {
      try {
        const fact = parseFactFile(await readFile(file, "utf8"));
        this.facts.set(fact.id, fact);
      } catch (err) {
        skipped++;
        console.warn(`[store] skipping ${file}: ${message(err)}`);
      }
    }

    for (const file of await listFiles(join(this.dir, "sessions"), ".json")) {
      const id = basename(file, ".json");
      try {
        if (!SESSION_ID_RE.test(id)) throw new Error(`file name is not a session id (${SESSION_ID_RE})`);
        const parsed = JSON.parse(await readFile(file, "utf8")) as { id?: unknown };
        if (parsed?.id !== id) throw new Error(`"id" inside the file (${String(parsed?.id)}) does not match the file name`);
        this.sessionIds.add(id);
      } catch (err) {
        skipped++;
        console.warn(`[store] skipping ${file}: ${message(err)}`);
      }
    }

    return { facts: this.facts.size, sessions: this.sessionIds.size, skipped };
  }

  // ------------------------------------------------------------------ facts

  listFacts(filter: ListFactsFilter = {}): Fact[] {
    const out: Fact[] = [];
    for (const f of this.facts.values()) {
      if (filter.folder && !folderAllows([filter.folder], f.folder)) continue;
      if (filter.tier && f.tier !== filter.tier) continue;
      out.push(f);
    }
    // Newest first, then by id so the order is stable for the dashboard.
    return out.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.id < b.id ? -1 : 1));
  }

  getFact(id: string): Fact | undefined {
    return this.facts.get(id);
  }

  /** Validates, writes tmp + rename (atomic), then updates the index. A moved fact loses its old file. */
  async putFact(input: Fact): Promise<Fact> {
    const v = validateFact(input);
    if (!v.ok) throw new Error(`putFact: ${v.errors.join("; ")}`);
    const fact = v.fact;
    const prev = this.facts.get(fact.id);
    await writeAtomic(this.factFile(fact), serializeFactFile(fact));
    if (prev && prev.folder !== fact.folder) await rm(this.factFile(prev), { force: true });
    this.facts.set(fact.id, fact);
    return fact;
  }

  factFile(fact: Pick<Fact, "id" | "folder">): string {
    return join(this.dir, factPath(fact));
  }

  // --------------------------------------------------------------- sessions

  /** Upsert. `updated` is true when this id was already in the archive. */
  async putSession(session: CapturedSession): Promise<{ updated: boolean }> {
    assertSessionId(session.id);
    const updated = this.sessionIds.has(session.id);
    await writeAtomic(this.sessionFile(session.id), JSON.stringify(session, null, 2) + "\n");
    this.sessionIds.add(session.id);
    return { updated };
  }

  async getSession(id: string): Promise<CapturedSession | undefined> {
    assertSessionId(id);
    try {
      return JSON.parse(await readFile(this.sessionFile(id), "utf8")) as CapturedSession;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  sessionFile(id: string): string {
    return join(this.dir, "sessions", `${id}.json`);
  }

  counts(): { facts: number; sessions: number } {
    return { facts: this.facts.size, sessions: this.sessionIds.size };
  }
}

// -------------------------------------------------------------------- helpers

/** Ids come from URLs and request bodies; the regex alone rules out any path traversal. */
function assertSessionId(id: string): void {
  if (!SESSION_ID_RE.test(id)) throw new Error(`session id must match ${SESSION_ID_RE} (got ${JSON.stringify(id)})`);
}

/** Write to a sibling tmp file, then rename: readers never see a half-written file. */
async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

/** All files under `root` (recursive) ending in `ext`. A missing root is an empty store. */
async function listFiles(root: string, ext: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(root, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.filter((n) => n.endsWith(ext) && !n.endsWith(`.tmp`)).map((n) => join(root, n)).sort();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
