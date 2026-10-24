// Fact file contract. Mirrors the "Fact file" section of CLAUDE.md — change both together,
// and tell the other builder before you do.
//
// One markdown file per fact, YAML frontmatter + optional detail body, so the store opens
// in Obsidian. Parsing/serializing lives in ../fact-file.ts; this file is types only.

export const TOP_FOLDERS = ["career", "projects", "team", "private"] as const;
export type TopFolder = (typeof TOP_FOLDERS)[number];

/** Facts Jev could not file with confidence wait here for a human. No AI client reads it. */
export const INBOX = "inbox" as const;

/** `career`, `career/projects`, `private/health`, … or the inbox. */
export type Folder = TopFolder | `${TopFolder}/${string}` | typeof INBOX;

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
  /** YYYY-MM-DD */
  updated: string;
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
}

export const FACT_ID_RE = /^fct_[0-9a-f]{4,}$/;
export const SESSION_ID_RE = /^ses_[0-9a-f]{4,}$/;
