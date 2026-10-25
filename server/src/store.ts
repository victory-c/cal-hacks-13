// FileStore: hot/cold facts as markdown files and raw sessions as JSON (task A3, cold archive).
// Plain files on purpose: the store opens in Obsidian and survives any crash at 4 AM. An
// in-memory index of facts (and session ids) is refreshed on every write, so reads never hit
// the disk except for a session body.
//
// Layout under the data dir:   facts/<folder>/<id>.md     sessions/<id>.json

import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
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
  private readonly sessionPrincipals = new Map<string, string>();
  private readonly sessionClients = new Map<string, string>();

  constructor(readonly dir: string) {}

  // ---------------------------------------------------------------- loading

  /** Scans the data dir. Unparsable files are skipped with a warning, never thrown on. */
  async loadAll(): Promise<{ facts: number; sessions: number; skipped: number }> {
    this.facts.clear();
    this.sessionIds.clear();
    this.sessionClients.clear();
    this.sessionPrincipals.clear();
    let skipped = 0;

    // Tmp files orphaned by a crash mid-writeAtomic: the real file (if any) is intact, so sweep them.
    for (const root of [join(this.dir, "facts"), join(this.dir, "sessions"), join(this.dir, "world"), join(this.dir, "receipts")]) {
      for (const tmp of await listFiles(root, ".tmp")) {
        console.warn(`[store] removing orphaned tmp file ${tmp}`);
        await rm(tmp, { force: true });
      }
    }

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
        const parsed = JSON.parse(await readFile(file, "utf8")) as { id?: unknown; client?: unknown; principal?: unknown };
        if (parsed?.id !== id) throw new Error(`"id" inside the file (${String(parsed?.id)}) does not match the file name`);
        this.sessionIds.add(id);
        if (typeof parsed.principal === "string") this.sessionPrincipals.set(id, parsed.principal);
        if (typeof parsed.client === "string") this.sessionClients.set(id, parsed.client);
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
    this.sessionClients.set(session.id, session.client);
    if (session.principal) this.sessionPrincipals.set(session.id, session.principal);
    return { updated };
  }

  /** Session metadata for synchronous SSE authorization; no transcript is exposed. */
  sessionPrincipal(id: string): string | undefined { return this.sessionPrincipals.get(id); }

  sessionClient(id: string): string | undefined {
    return this.sessionClients.get(id);
  }

  async listSessions(pending = false): Promise<CapturedSession[]> {
    const out: CapturedSession[] = [];
    for (const id of this.sessionIds) {
      const session = await this.getSession(id);
      if (!session) continue;
      if (pending) {
        if (!session.ended_at) continue;
        let receipt = "";
        try { receipt = (JSON.parse(await readFile(join(this.dir, "receipts", `${id}.json`), "utf8")) as { fingerprint: string }).fingerprint; }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
        if (receipt === sessionFingerprint(session)) continue;
      }
      out.push(session);
    }
    return out;
  }

  async markDistilled(id: string, fingerprint: string): Promise<void> {
    const session = await this.getSession(id);
    if (!session) throw new Error("no such session");
    if (sessionFingerprint(session) !== fingerprint) throw new Error("session changed during distillation");
    await writeAtomic(join(this.dir, "receipts", `${id}.json`), JSON.stringify({ fingerprint }) + "\n");
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

/**
 * Write to a sibling tmp file, fsync, then rename: readers never see a half-written file, and a
 * crash right after the rename cannot leave a truncated one (the archive must never lose a
 * session). A tmp orphaned by a crash before the rename is swept on the next loadAll().
 */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
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
  // writeAtomic tmp names end in ".tmp", never in ".md"/".json", so they only match ext ".tmp".
  return names.filter((n) => n.endsWith(ext)).map((n) => join(root, n)).sort();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sessionFingerprint(session: CapturedSession): string {
  return createHash("sha256").update(JSON.stringify({ messages: session.messages, principal: session.principal, kind: session.kind, external: session.external })).digest("hex");
}
