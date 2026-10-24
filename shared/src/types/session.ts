// Raw session capture contract: what the Claude Code hook, the browser extension and
// `canon_save` send to `POST /api/sessions`. The server writes it to the cold archive as-is.

import type { ClientId } from "./fact.ts";

/** What kind of item this is. AI sessions come from the hook / extension; the rest from ingest. */
export const SOURCE_KINDS = ["ai_session", "memo", "chat", "transcript", "email", "note"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface SessionMessage {
  role: MessageRole;
  content: string;
  /** ISO 8601, when the client knows it. */
  at?: string;
}

export interface SessionMeta {
  cwd?: string;
  repo?: string;
  branch?: string;
  pr?: string;
  /** Page URL for web captures. */
  url?: string;
  model?: string;
  [key: string]: unknown;
}

export interface CapturedSession {
  /** `ses_` + 4 or more hex chars. Stable for the whole session, so re-posting upserts. */
  id: string;
  client: ClientId;
  /** ISO 8601 */
  started_at: string;
  /** Set once the client knows the session is over. Triggers the final distill. */
  ended_at?: string;
  title?: string;
  /** Full message list so far. Clients re-send the whole list; the server replaces. */
  messages: SessionMessage[];
  meta?: SessionMeta;
  /**
   * Whose context this is (principal id: `dan`). It becomes each fact's `author`, and a member's
   * own facts join their scope, so the server binds it to a per-person client's principal (see
   * ROUTES.sessions). Missing = unknown: triage treats it cautiously and sets no author.
   */
  principal?: string;
  /** Missing = "ai_session". */
  kind?: SourceKind;
  /** True when the text came from outside the firm (the target's lawyers). Triage reads it with extra suspicion. */
  external?: boolean;
}
