// Ids and timestamps. 8 hex chars is plenty for one person's store and stays readable in
// Obsidian; the contract only requires 4+ (FACT_ID_RE / SESSION_ID_RE).

import { randomBytes } from "node:crypto";

export function newFactId(): string {
  return `fct_${randomBytes(4).toString("hex")}`;
}

export function newSessionId(): string {
  return `ses_${randomBytes(4).toString("hex")}`;
}

/** ISO 8601 in UTC, for `at` on events and `started_at` on sessions. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * YYYY-MM-DD in the machine's local time zone, for `updated` on facts. Local, not UTC, because
 * it is a human-facing day in the resume viewer and everything runs on one laptop.
 */
export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
