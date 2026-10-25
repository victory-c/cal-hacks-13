// World persistence (docs/PIPELINE-PRD.md §4.4): everything the moderator and the pipeline decide
// about people, rules, scopes, agents and quarantine lives in `<data dir>/world/` as JSON
// snapshots, and the audit log is an append-only `audit.jsonl`. Facts and sessions keep their own
// files (store.ts). Fixtures seed only an empty store: when `world/principals.json` exists on
// start, the world is restored from here and the 0:00 scopes are not rebuilt.
//
// Every write goes through one serialized queue, so two changes to the same file can never finish
// their renames out of order, and a handler awaits `flush()` before it answers: when the response
// says a person was added, the file says so too.

import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { AuditEvent, Group, Principal, QuarantineItem, Scope, ScopeRule } from "@canon/shared";

import { isRecord } from "./http.ts";
import { writeAtomic } from "./store.ts";

export const WORLD_DIR = "world";
export type WorldSection = "groups" | "principals" | "rules" | "scopes" | "quarantine";
const SECTIONS: readonly WorldSection[] = ["groups", "principals", "rules", "scopes", "quarantine"];

/** What `load()` hands back: the same shape the fixtures use, plus the audit rows in order. */
export interface PersistedWorld {
  groups: Group[];
  principals: Principal[];
  rules: ScopeRule[];
  scopes: Scope[];
  quarantine: QuarantineItem[];
  audit: AuditEvent[];
  /** When the world was first written, so a console can say how old the state is. */
  firm?: string;
}

/** The live state the persister snapshots. ScopeState satisfies it. */
export interface WorldSnapshot {
  readonly groups: readonly Group[];
  readonly principals: ReadonlyMap<string, Principal>;
  readonly rules: ReadonlyMap<string, ScopeRule>;
  readonly scopes: ReadonlyMap<string, Scope>;
  readonly quarantine: ReadonlyMap<string, QuarantineItem>;
  readonly firm?: string;
}

export class WorldPersister {
  readonly dir: string;
  private queue: Promise<void> = Promise.resolve();
  private readonly dirty = new Set<WorldSection>();
  private snapshot: WorldSnapshot | undefined;
  private scheduled = false;

  constructor(dataDir: string) {
    this.dir = join(dataDir, WORLD_DIR);
  }

  /** The world on disk, or undefined when nothing was ever written (a fresh store). */
  static async load(dataDir: string): Promise<PersistedWorld | undefined> {
    const dir = join(dataDir, WORLD_DIR);
    const principals = await readJson<Principal>(join(dir, "principals.json"), "principals");
    if (principals === undefined) return undefined;
    const meta = await readMeta(join(dir, "principals.json"));
    return {
      principals,
      groups: (await readJson<Group>(join(dir, "groups.json"), "groups")) ?? [],
      rules: (await readJson<ScopeRule>(join(dir, "rules.json"), "rules")) ?? [],
      scopes: (await readJson<Scope>(join(dir, "scopes.json"), "scopes")) ?? [],
      quarantine: (await readJson<QuarantineItem>(join(dir, "quarantine.json"), "items")) ?? [],
      audit: await readAudit(join(dir, "audit.jsonl")),
      ...(meta.firm ? { firm: meta.firm } : {}),
    };
  }

  /** Removes the world directory (npm run reset). */
  static async clear(dataDir: string): Promise<void> {
    await rm(join(dataDir, WORLD_DIR), { recursive: true, force: true });
  }

  /** Binds the live state; the first flush after this writes every section. */
  attach(snapshot: WorldSnapshot): void {
    this.snapshot = snapshot;
    for (const s of SECTIONS) this.dirty.add(s);
  }

  /** Marks a section changed. The write happens on the next flush, which `touch` also schedules. */
  touch(section: WorldSection): void {
    this.dirty.add(section);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        void this.flush();
      });
    }
  }

  /** Appends one audit row. Rows are never rewritten. */
  appendAudit(entry: AuditEvent): void {
    const line = JSON.stringify(entry) + "\n";
    this.enqueue(async () => {
      await mkdir(this.dir, { recursive: true });
      await appendFile(join(this.dir, "audit.jsonl"), line, "utf8");
    });
  }

  /** Writes every dirty section, in order, and resolves when the queue is empty. */
  flush(): Promise<void> {
    const snapshot = this.snapshot;
    if (snapshot && this.dirty.size > 0) {
      const sections = [...this.dirty];
      this.dirty.clear();
      this.enqueue(async () => {
        await mkdir(this.dir, { recursive: true });
        for (const section of sections) await writeAtomic(join(this.dir, `${section}.json`), serialize(section, snapshot));
      });
    }
    return this.queue;
  }

  /** Waits for every queued write (shutdown). */
  drain(): Promise<void> {
    return this.flush();
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((err: unknown) => {
      // One failed write must not wedge the queue; it is logged and the next flush rewrites the snapshot.
      console.error(`[persist] write failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

function serialize(section: WorldSection, w: WorldSnapshot): string {
  const body: Record<string, unknown> =
    section === "groups"
      ? { groups: w.groups, ...(w.firm ? { firm: w.firm } : {}) }
      : section === "principals"
        ? { principals: [...w.principals.values()], ...(w.firm ? { firm: w.firm } : {}) }
        : section === "rules"
          ? { rules: [...w.rules.values()] }
          : section === "scopes"
            ? { scopes: [...w.scopes.values()] }
            : { items: [...w.quarantine.values()] };
  return JSON.stringify(body, null, 2) + "\n";
}

async function readJson<T>(path: string, key: string): Promise<T[] | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !Array.isArray(parsed[key])) throw new Error(`${path}: expected { ${key}: [...] }`);
  return parsed[key] as T[];
}

async function readMeta(path: string): Promise<{ firm?: string }> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) && typeof parsed.firm === "string" ? { firm: parsed.firm } : {};
  } catch {
    return {};
  }
}

/** One row per line; a torn last line (a crash mid-append) is skipped with a warning, never fatal. */
async function readAudit(path: string): Promise<AuditEvent[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: AuditEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && typeof parsed.id === "string" && typeof parsed.kind === "string") out.push(parsed as unknown as AuditEvent);
    } catch {
      console.warn(`[persist] skipping a torn audit line in ${path}`);
    }
  }
  return out;
}
