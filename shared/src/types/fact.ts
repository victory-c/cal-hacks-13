// Fact file contract. Mirrors the "Fact file" section of CLAUDE.md — change both together,
// and tell the other builder before you do.
//
// One markdown file per fact, YAML frontmatter + optional detail body, so the store opens
// in Obsidian. Parsing/serializing lives in ../fact-file.ts; this file is types only.

/** The scaffold's original top folders. Still valid groups; the finance world adds its own. */
export const TOP_FOLDERS = ["career", "projects", "team", "private"] as const;
export type TopFolder = (typeof TOP_FOLDERS)[number];

/** Facts nobody could place wait here. Only moderators see it until one files them. */
export const INBOX = "inbox" as const;

/**
 * A fact's folder is its group (PRD: the one bucket the memory system files it into):
 * `deal/falcon`, `research/logistics`, `market/public`, … or the inbox. Lowercase slug path,
 * checked by GROUP_RE. Exclusions match a group and everything under it.
 */
export type Folder = string;
export type GroupId = Folder;
export const GROUP_RE = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;

export const TIERS = ["hot", "cold"] as const;
export type Tier = (typeof TIERS)[number];

/** Clients we know about. The string fallback keeps new clients from breaking the type. */
export const KNOWN_CLIENTS = [
  "claude-code",
  "cursor",
  "hermes",
  "chatgpt",
  "claude-web",
  "gemini-web",
  "gemini-cli",
  "teammate-cursor",
  // Finance: the ingest client (memos, team chat, meeting notes, email) and internal workers.
  "ingest",
  "dispatcher",
  "compliance",
] as const;
export type ClientId = (typeof KNOWN_CLIENTS)[number] | (string & {});

export interface FactSource {
  client: ClientId;
  /** The captured session this fact came from (`ses_…`). The resume viewer links to it. */
  session: string;
  pr?: string;
  url?: string;
}

export interface Fact {
  /** `fct_` + 4 or more hex chars. */
  id: string;
  statement: string;
  folder: Folder;
  tier: Tier;
  /** Save-time probability that this is worth keeping hot (Jev "Noul" answer). */
  jev_keep: number;
  source: FactSource;
  /** Id of the fact this one replaces. The old fact is retired, never deleted. */
  supersedes?: string;
  /** YYYY-MM-DD: when Canon learned it (or last changed it). */
  updated: string;
  /** YYYY-MM-DD: when it happened, from the source. The second of the PRD's two dates. */
  happened?: string;
  /** Extra tags for when the group is too coarse (`nimbus`). Exclusions can remove by label. */
  labels?: string[];
  /** Principal id of whose memory this is (the captured item's principal; an agent's facts belong to its creator). */
  author?: string;
  /** Markdown body under the frontmatter. */
  detail?: string;
}

/** A fact the distiller proposes before Jev decides tier, folder and dedupe. */
export interface DraftFact {
  statement: string;
  /** The distiller's best guess. Jev may move it. */
  folder?: Folder;
  detail?: string;
  source: FactSource;
  /** YYYY-MM-DD the writer read off the source, when it says. */
  happened?: string;
  /** The writer's suggested labels. Triage decides. */
  labels?: string[];
}

export const FACT_ID_RE = /^fct_[0-9a-f]{4,}$/;
export const SESSION_ID_RE = /^ses_[0-9a-f]{4,}$/;
