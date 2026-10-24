// Pure helpers for the ingest CLI (canon-ingest.mjs): firm content on disk → CapturedSession.
// One file is one item is one session, posted as client "ingest". Layout-tolerant on purpose:
// lane A owns the official synthetic world and its layout is not fixed, so the kind comes from
// front-matter, then raw email (an .eml, or a header block with transport headers), then a folder
// name, then the file name, then the extension, then a sniff of the text. Only walk() and
// readItem() touch the disk.
//
// Security rule: `external` never depends on where a file sits. Any item whose text opens with an
// email header block naming an address is judged by its sender, whatever its kind or folder.
//
// Zero dependencies and no import of @canon/shared, like the Claude Code hook next door: the
// output mirrors shared/src/types/session.ts (CapturedSession, SOURCE_KINDS). Keep them in sync
// by reading that file; hooks/test/ingest.test.mjs fails if SOURCE_KINDS drifts from KINDS.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { normalizePrincipal } from "../claude-code/lib.mjs";

export const CLIENT = "ingest";
/** Mirrors SOURCE_KINDS in shared/src/types/session.ts. */
export const KINDS = ["ai_session", "memo", "chat", "transcript", "email", "note"];
export const DEFAULT_FIRM_DOMAIN = "harborlane.com";
export const TITLE_MAX = 80;
/** Same cap as the Claude Code hook. Long documents are split at paragraphs, never cut. */
export const MESSAGE_MAX = 8000;
/** Bigger files are skipped with a reason: an export dump is not one memo. */
export const FILE_MAX_BYTES = 1_000_000;
export const EXTENSIONS = [".md", ".markdown", ".txt", ".eml", ".json", ".jsonl", ".vtt", ".srt"];

// Words that name a kind in front-matter, folder names and file names.
const KIND_WORDS = {
  ai_session: "ai_session", "ai-session": "ai_session", ai_sessions: "ai_session", "ai-sessions": "ai_session", chatgpt: "ai_session",
  memo: "memo", memos: "memo", memorandum: "memo",
  chat: "chat", chats: "chat", slack: "chat", teams: "chat", messages: "chat",
  transcript: "transcript", transcripts: "transcript", meeting: "transcript", meetings: "transcript", call: "transcript", calls: "transcript",
  email: "email", emails: "email", mail: "email", eml: "email",
  note: "note", notes: "note", news: "note",
};
const EXT_KINDS = { ".eml": "email", ".jsonl": "chat", ".vtt": "transcript", ".srt": "transcript" };

/**
 * "Emails", "meetings", "ai-session" → a SourceKind, or undefined. Own keys only: a file named
 * `constructor.md` or a folder `__proto__/` must not turn an Object member into a kind.
 */
export function kindFromWord(word) {
  if (typeof word !== "string") return undefined;
  const key = word.trim().toLowerCase();
  return Object.hasOwn(KIND_WORDS, key) ? KIND_WORDS[key] : undefined;
}

// ------------------------------------------------------------------------------ front-matter

/**
 * `---` YAML-lite front-matter: flat `key: value` lines, quotes stripped, `true`/`false`,
 * `[a, b]` lists (commas inside parentheses stay put). Keys are lowercased. Nested YAML is
 * ignored rather than misread. Returns { data: {}, body: text } when there is none.
 */
export function splitFrontMatter(text) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const raw of m[1].split(/\r?\n/)) {
    if (/^\s/.test(raw) || raw.trim().startsWith("#")) continue;
    const kv = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(raw); // no lazy `.*?\s*$`: it backtracks quadratically
    // `__proto__: [a, b]` would swap the object's prototype instead of setting a key.
    if (kv && kv[1].toLowerCase() !== "__proto__") data[kv[1].toLowerCase()] = yamlValue(kv[2].trim());
  }
  return { data, body: text.slice(m[0].length) };
}

function yamlValue(raw) {
  const list = /^\[(.*)\]$/.exec(raw);
  if (list) return splitTopLevel(list[1]).map(unquote).filter(Boolean);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return unquote(raw);
}

function unquote(s) {
  const t = s.trim();
  const q = /^(["'])(.*)\1$/.exec(t);
  return q ? q[2] : t;
}

/** Splits on commas outside parentheses and quotes. */
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// ------------------------------------------------------------------------------------- kind

/**
 * First signal wins: front-matter `kind` (or `type`); raw email (an `.eml`, or a header block that
 * carries transport headers such as Message-ID or Received, which no memo has); the nearest
 * folder that names a kind; a word in the file name; the extension; then the text itself (a
 * From/Subject header block, speaker lines). Nothing at all → "note", the most generic kind. `by`
 * says which signal decided, for meta. Raw email beats the folder so an outside email saved
 * under `messages/` or `calls/` is not read as a chat.
 */
export function inferKind({ data = {}, relPath = "", text = "" }) {
  for (const key of ["kind", "type"]) {
    const k = kindFromWord(data[key]);
    if (k) return { kind: k, by: "front-matter" };
  }
  const parts = relPath.split("/");
  const file = parts.pop() ?? "";
  const ext = extname(file).toLowerCase();
  if (ext === ".eml") return { kind: "email", by: "extension" };
  if (looksLikeRawEmail(text)) return { kind: "email", by: "content" };
  for (const dir of parts.reverse()) {
    const k = kindFromWord(dir);
    if (k) return { kind: k, by: "folder" };
  }
  for (const word of basename(file, ext).toLowerCase().split(/[^a-z]+/)) {
    const k = kindFromWord(word);
    if (k) return { kind: k, by: "file name" };
  }
  if (EXT_KINDS[ext]) return { kind: EXT_KINDS[ext], by: "extension" };
  if (looksLikeEmail(text)) return { kind: "email", by: "content" };
  if (looksLikeChat(text)) return { kind: "chat", by: "content" };
  return { kind: "note", by: "default" };
}

function looksLikeEmail(text) {
  const { headers } = parseEmail(text);
  return Boolean(headers.from && (headers.subject || headers.to));
}

const TRANSPORT_HEADERS = ["message-id", "received", "return-path", "mime-version", "dkim-signature", "x-mailer"];

/** A From with an address plus a transport header: a mail system wrote this, not a person. */
function looksLikeRawEmail(text) {
  const { headers } = parseEmail(text);
  return addressesIn(headers.from).length > 0 && TRANSPORT_HEADERS.some((h) => headers[h] !== undefined);
}

/**
 * Most non-empty lines are "Speaker: text", and at least two people evidently talk (each says
 * more than one line, or speaks on a timestamped line). A key/value sheet such as
 * "Buyer: …\nTarget: …\nPrice: …" names each key once, so it stays a note.
 */
function looksLikeChat(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return false;
  const said = lines.map(parseSpeakerLine).filter(Boolean);
  if (said.length / lines.length < 0.6) return false;
  return evidentSpeakers(said).size >= 2;
}

/**
 * Speakers (from parseSpeakerLine results) that are evidently people in the conversation: they
 * say more than one line or speak on a timestamped line. A one-off "Location: Zoom" or
 * "Recorded by: Otter" header line is neither, so a key/value sheet is not mistaken for a chat.
 */
function evidentSpeakers(lines) {
  const said = new Map();
  const stamped = new Set();
  for (const l of lines) {
    said.set(l.speaker, (said.get(l.speaker) ?? 0) + 1);
    if (l.stamp) stamped.add(l.speaker);
  }
  return new Set([...said.keys()].filter((s) => said.get(s) > 1 || stamped.has(s)));
}

// ----------------------------------------------------------------------------- speaker lines

// Header-ish words that are not people: "Note: …" inside a chat is a continuation line. Covers
// email headers (so a raw email under a chat folder never yields a speaker such as "Return-Path"),
// meeting-header and key/value labels. x-* headers are caught by prefix in parseSpeakerLine.
const NOT_SPEAKERS = new Set([
  "http", "https", "note", "notes", "nb", "ps", "subject", "from", "to", "cc", "bcc", "date", "re", "fw", "fwd",
  "action", "action items", "todo", "next steps", "summary", "agenda", "title", "attendees", "participants", "q", "a",
  // email transport headers
  "return-path", "received", "message-id", "reply-to", "in-reply-to", "references", "sender", "delivered-to",
  "mime-version", "content-type", "content-transfer-encoding", "content-disposition", "dkim-signature",
  "authentication-results", "importance", "thread-topic", "thread-index",
  // meeting and transcript headers
  "meeting", "meeting id", "location", "time", "when", "where", "host", "organizer", "topic", "duration",
  "recorded by", "recording", "transcript", "transcribed by", "minutes", "present", "absent", "dial-in", "dial in",
  "passcode", "link", "url", "start", "end", "start time", "end time", "speakers", "channel",
  // key/value labels in deal documents
  "buyer", "seller", "target", "acquirer", "client", "price", "consideration", "structure", "status", "owner",
  "author", "project", "deal", "ticker", "version", "draft", "confidential", "privileged", "priority", "type", "kind",
  "source", "tags", "category", "phone", "tel", "fax", "email",
]);

const SPEAKER_RE = new RegExp(
  String.raw`^(?:[-*•]\s+)?` + // bullet
    String.raw`(?:\[(?<stamp>[^\]]{1,40})\]\s*|(?<bare>\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?)\s+)?` + // [09:12] or 09:12
    String.raw`(?:\*\*|__)?(?<speaker>[A-Za-z][\w.'’-]*(?: [A-Za-z][\w.'’-]*){0,3})` + // Dan, Dan Okafor, dan.okafor
    // The line is trimmed first, so the text runs to the end greedily. (A lazy `.*?\s*$` here
    // backtracked quadratically on long whitespace runs inside a line.)
    String.raw`(?:\s*\((?<aside>[^)]{1,48})\))?(?:\*\*|__)?\s*:(?:\*\*|__)?(?:\s+(?<text>.*))?$`,
);

/** "[09:12] Dan Okafor (MD): text" → { speaker, label, stamp, text }, or null. */
export function parseSpeakerLine(line) {
  const trimmed = String(line).trim();
  const m = SPEAKER_RE.exec(trimmed);
  if (!m) return null;
  const { stamp, bare, speaker, aside, text } = m.groups;
  const key = speaker.toLowerCase();
  if (NOT_SPEAKERS.has(key) || key.startsWith("x-")) return null;
  if (!text && !/:\s*$/.test(trimmed)) return null;
  return {
    speaker,
    label: aside ? `${speaker} (${aside})` : speaker,
    stamp: stamp ?? bare,
    text: text ?? "",
  };
}

/**
 * Chat / transcript text → turns, one per speaker turn: consecutive lines from the same speaker
 * merge, lines with no speaker continue the turn above, and text before the first speaker is a
 * preamble turn with no speaker. Timestamps become `at` only when they resolve to an exact
 * instant (see stampToIso); otherwise the stamp stays in the text, so nothing is lost or invented.
 * A same-speaker line whose stamp is an exact instant other than the turn's own `at` starts a new
 * turn instead of merging, so its time is kept as `at` and never dropped (a turn holds one `at`).
 */
export function parseTurns(text, clock = {}) {
  const turns = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const s = parseSpeakerLine(line);
    if (!s) {
      if (!cur) {
        cur = { speaker: undefined, label: undefined, lines: [] };
        turns.push(cur);
      }
      cur.lines.push(line.trim());
      continue;
    }
    const at = s.stamp ? stampToIso(s.stamp, clock) : undefined;
    const body = s.stamp && !at ? `[${s.stamp}] ${s.text}`.trim() : s.text;
    if (cur && cur.speaker === s.speaker && (!at || at === cur.at)) {
      if (body) cur.lines.push(body);
      continue;
    }
    cur = { speaker: s.speaker, label: s.label, at, lines: body ? [body] : [] };
    turns.push(cur);
  }
  return turns
    .map((t) => ({ speaker: t.speaker, label: t.label, at: t.at, text: t.lines.join("\n").trim() }))
    .filter((t) => t.text);
}

// --------------------------------------------------------------------------------- time

const OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * What an item says about its own time: the day (YYYY-MM-DD), a UTC offset when it gives one
 * (`tz: -04:00`, or the offset on `date`), and `start` when `date` is an exact instant.
 */
export function itemClock(data = {}) {
  const raw = firstString(data.date, data.start, data.started_at);
  const clock = {};
  if (!raw) return clock;
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (day) clock.day = day[1];
  const tz = normalizeOffset(firstString(data.tz, data.timezone));
  const own = OFFSET_RE.exec(raw.trim());
  clock.offset = tz ?? (own ? normalizeOffset(own[1]) : undefined);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(raw)) {
    const withOffset = own ? raw.trim().replace(" ", "T") : clock.offset ? `${raw.trim().replace(" ", "T")}${clock.offset}` : undefined;
    const ms = withOffset ? Date.parse(withOffset) : NaN;
    if (!Number.isNaN(ms)) clock.start = new Date(ms).toISOString();
  }
  return clock;
}

function normalizeOffset(s) {
  if (!s) return undefined;
  if (/^z$/i.test(s.trim())) return "Z";
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(s.trim());
  return m ? `${m[1]}${m[2]}:${m[3]}` : undefined;
}

/**
 * A line's stamp → ISO 8601, only when exact:
 *   - a full date-time with an offset (or the item's offset)
 *   - transcripts: an elapsed `hh:mm:ss` / `mm:ss` from the item's exact `start`, unless the same
 *     stamp read as a time of day would fall at or after the start ("14:03" in a call that began
 *     at 14:00 could be either, so it is neither)
 *   - otherwise: a time of day on the item's day, at the item's offset ("09:12", "9:12 PM")
 * Anything less certain returns undefined and the caller keeps the stamp as text.
 */
export function stampToIso(stamp, { day, offset, start, elapsed = false } = {}) {
  const s = String(stamp).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const iso = s.replace(" ", "T");
    const ms = Date.parse(OFFSET_RE.test(iso) ? iso : offset && /T\d/.test(iso) ? `${iso}${offset}` : "");
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  if (elapsed) {
    const e = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(s);
    if (!e || !start) return undefined;
    const asClock = stampToIso(s, { day, offset });
    if (asClock && Date.parse(asClock) >= Date.parse(start)) return undefined;
    const secs = Number(e[1] ?? 0) * 3600 + Number(e[2]) * 60 + Number(e[3]);
    return new Date(Date.parse(start) + secs * 1000).toISOString();
  }
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/.exec(s);
  if (!t || !day || !offset) return undefined;
  let h = Number(t[1]);
  if (t[4]) h = (h % 12) + (/p/i.test(t[4]) ? 12 : 0);
  if (h > 23) return undefined;
  const pad = (n) => String(n).padStart(2, "0");
  const ms = Date.parse(`${day}T${pad(h)}:${t[2]}:${t[3] ?? "00"}${offset}`);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Epoch numbers we read: 9 to 13 digits, i.e. epoch seconds or ms from 1973 to 2286. */
const EPOCH_MIN = 1e8;
const EPOCH_MAX = 1e13;

/**
 * A row's `at` from JSON: epoch seconds/ms (Slack `ts`), or an ISO string with an offset.
 * Small numbers (elapsed seconds) and out-of-range ones are not instants → undefined.
 */
export function rowInstant(v, clock) {
  if (typeof v === "number" || (typeof v === "string" && /^\d+(\.\d+)?$/.test(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < EPOCH_MIN || n >= EPOCH_MAX) return undefined;
    return isoOrUndefined(n < 1e12 ? n * 1000 : n);
  }
  return typeof v === "string" ? stampToIso(v, clock) : undefined;
}

// A string that pins its own zone: a trailing Z or ±hh:mm / ±hhmm (an RFC 2822 "(EDT)" comment may
// follow), or a zone name Date.parse knows exactly.
const ZONE_RE = /\d\s*(?:Z|[+-]\d{2}:?\d{2})(?:\s*\([^)]*\))?\s*$|\b(?:GMT|UTC?|[ECMP][SD]T)\b/i;

/**
 * A date string → ISO, only when it names an instant on its own: it carries a zone, or it is a bare
 * YYYY-MM-DD (UTC by definition). "2026-10-21 09:12" or "Oct 21 9am" → undefined, because
 * Date.parse would silently read them in the ingesting machine's local zone.
 */
export function exactIso(s) {
  if (typeof s !== "string") return undefined;
  const t = s.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) || ZONE_RE.test(t) ? isoOrUndefined(t) : undefined;
}

// -------------------------------------------------------------------------------- email

/**
 * RFC 822-ish header block, then a blank line, then the body. Folded header lines (leading
 * whitespace) continue the header above; repeated headers join with ", ". Text without a header
 * block comes back as { headers: {}, body: text }. Plain-text bodies only (no MIME parts).
 */
export function parseEmail(text) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const headers = {};
  let last;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      break;
    }
    if (/^[ \t]/.test(line) && last) {
      headers[last] += ` ${line.trim()}`;
      continue;
    }
    const m = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!m) break;
    last = m[1].toLowerCase();
    // Own keys only, so a `Constructor:` header is not joined onto Object's own constructor.
    headers[last] = Object.hasOwn(headers, last) ? `${headers[last]}, ${m[2].trim()}` : m[2].trim();
  }
  if (!headers.from && !headers.subject) return { headers: {}, body: String(text).trim() };
  return { headers, body: lines.slice(i).join("\n").trim() };
}

// The lookbehind keeps matchAll linear: a match can only start where a local part starts.
const ADDRESS_RE = /(?<![\w.+'-])[\w.+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const ADDR_SPEC_RE = /^[\w.+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
/** Longer address headers are not parsed; an unreadable sender counts as external anyway. */
const ADDRESS_HEADER_MAX = 4000;

/** Every address-shaped string anywhere in the value, display names and comments included. */
export function addressesIn(value) {
  return typeof value === "string" ? [...value.matchAll(ADDRESS_RE)].map((m) => m[0].toLowerCase()) : [];
}

/**
 * An address header (From, To, Cc) → one entry per mailbox: its address, lowercased, or
 * undefined when that mailbox cannot be read with confidence. Quoted display names and
 * (comments) are removed first, so an address written inside a display name is never taken for
 * the mailbox. The address is the one `<angle-addr>` when there is one, else a bare addr-spec.
 *   '"dan.okafor@harborlane.com" <creyes@ashdownreyes.com>'  → ["creyes@ashdownreyes.com"]
 *   "Dan <dan@harborlane.com>, nadia@harborlane.com"          → ["dan@…", "nadia@…"]
 *   "undisclosed sender"                                      → [undefined]
 */
export function mailboxesIn(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  if (value.length > ADDRESS_HEADER_MAX) return [undefined];
  let v = value.replace(/"(?:[^"\\]|\\.)*"/g, " ");
  for (let prev = ""; prev !== v; ) {
    prev = v;
    v = v.replace(/\([^()]*\)/g, " ");
  }
  return v
    .replace(/;/g, ",")
    .split(",")
    .map((part) => part.trim().replace(/^[^<>@:]*:\s*/, "")) // a group label: "Deal team: a@x, b@x;"
    .filter(Boolean)
    .map((part) => {
      if (/["()]/.test(part)) return undefined; // an unbalanced quote or comment
      const angles = [...part.matchAll(/<([^<>]*)>/g)];
      const rest = angles.length === 1 ? part.replace(angles[0][0], "") : part;
      if (angles.length > 1 || /[<>]/.test(rest)) return undefined;
      const addr = angles.length === 1 ? angles[0][1].trim() : part;
      return ADDR_SPEC_RE.test(addr) ? addr.toLowerCase() : undefined;
    });
}

/**
 * The From header's one sender address, or undefined when there is no single readable sender:
 * no address, several mailboxes, or another address anywhere else in the header. A display name
 * or comment that names a different mailbox ("dan.okafor@harborlane.com" <creyes@ashdownreyes.com>,
 * 'Dan (dan.okafor@harborlane.com)' via VDR <noreply@vdr.example>) is the classic spoof, so it
 * gets no benefit of the doubt.
 */
export function senderOf(from) {
  const boxes = mailboxesIn(from);
  if (boxes.length !== 1 || !boxes[0]) return undefined;
  return addressesIn(from).every((a) => a === boxes[0]) ? boxes[0] : undefined;
}

/** The firm's own domain or a subdomain of it. `harborlane.co` and `harbor-lane.com` are outside. */
export function isFirmAddress(address, firmDomain = DEFAULT_FIRM_DOMAIN) {
  const domain = String(address).toLowerCase().split("@")[1];
  const firm = String(firmDomain).toLowerCase().replace(/^@/, "");
  return Boolean(domain) && (domain === firm || domain.endsWith(`.${firm}`));
}

/**
 * External = the sender is not at the firm domain. A sender we cannot read (see senderOf) counts
 * as external: triage reads external text with extra suspicion, and "unknown" should not get the
 * benefit.
 */
export function isExternalSender(from, firmDomain = DEFAULT_FIRM_DOMAIN) {
  const sender = senderOf(from);
  return !sender || !isFirmAddress(sender, firmDomain);
}

// ---------------------------------------------------------------------------- principals

/**
 * "Dan Okafor", "dan.okafor@harborlane.com", "Maya (Compliance)" → "dan" / "maya". Values that
 * already look like a principal id (`dan`, `agt_research_1`) are kept. The same rule as the
 * Claude Code hook's CANON_PRINCIPAL and the extension's options page, so one person has one id.
 */
export const toPrincipalId = normalizePrincipal;

// --------------------------------------------------------------------------------- items

const AI_SPEAKER_RE = /^(assistant|chatgpt|gpt|claude|gemini|copilot|ai|bot)\b/i;
const ROLES = ["user", "assistant", "system", "tool"];

/**
 * Stable for one key, so re-ingesting the same file upserts instead of duplicating. The CLI's key
 * is the file's real absolute path: two different files never share an id, in one run or across
 * runs, so the server's upsert never overwrites one archived item with another.
 */
export function sessionIdFor(key) {
  return `ses_${createHash("sha1").update(toPosix(key)).digest("hex").slice(0, 8)}`;
}

/**
 * One item → a CapturedSession for POST /api/sessions, { skip: reason } when it holds nothing to
 * ingest (no text, a JSON file with no messages), or { error: reason } when it cannot be parsed
 * (bad JSON). The CLI goes on after either, but only an error makes the run exit 1. A JSONL file
 * with some lines that are not JSON still becomes a session from the good lines, and
 * meta.unparsed_lines lists the line numbers left out (the CLI reports them and exits 1).
 *   relPath      path relative to the ingest root: folder-name kind signals, meta.path, title
 *   idKey        what the id is derived from (the CLI passes the real absolute path); default relPath
 *   text         file contents
 *   firmDomain   sender domains outside it mark an email external
 *   principal    fallback principal when the item names none (--principal)
 *   now          ISO time for items that carry no date at all
 */
export function buildItem({ relPath, idKey = relPath, text, firmDomain = DEFAULT_FIRM_DOMAIN, principal: fallback, now = new Date().toISOString() }) {
  const rel = toPosix(relPath);
  const ext = extname(rel).toLowerCase();
  const parsed = ext === ".json" || ext === ".jsonl" ? readJsonItem(text, ext) : readTextItem(text, ext);
  if (parsed.error) return { error: parsed.error };
  if (parsed.skip) return { skip: parsed.skip };
  const { data, body, rows, unparsed } = parsed;
  const { kind, by } = inferKind({ data, relPath: rel, text: body });
  const clock = { ...itemClock(data), elapsed: kind === "transcript" };

  // Email headers are read for every item, not only kind "email": an outside email filed under
  // notes/ or calls/ is still from outside. Front-matter can supply them too.
  const parsedEmail = parseEmail(body);
  const headers = { ...pick(data, ["from", "to", "cc", "subject", "date"]), ...parsedEmail.headers };
  const mailish = kind === "email" || ext === ".eml" || addressesIn(headers.from).length > 0;
  const email = mailish
    ? compact({
        from: headers.from,
        to: headers.to,
        cc: headers.cc,
        subject: headers.subject,
        date: headers.date,
        message_id: headers["message-id"],
        reply_to: headers["reply-to"],
        return_path: headers["return-path"],
      })
    : undefined;

  let messages = [];
  let turns = [];
  if (kind === "email") {
    const block = ["from", "to", "cc", "subject", "date"]
      .filter((h) => headers[h])
      .map((h) => `${h[0].toUpperCase()}${h.slice(1)}: ${headers[h]}`)
      .join("\n");
    const at = exactIso(headers.date);
    messages = chunk([block, parsedEmail.body].filter(Boolean).join("\n\n")).map((content, i) => withAt({ role: "user", content }, i === 0 ? at : undefined));
  } else if (rows || kind === "chat" || kind === "transcript" || kind === "ai_session") {
    // A row time that is not an exact instant stays in the text as "[3.5]", as in parseTurns.
    turns = rows
      ? rows.map((r) => {
          const at = rowInstant(r.at, clock);
          return { ...r, at, text: r.at !== undefined && !at ? `[${r.at}] ${r.text}` : r.text };
        })
      : parseTurns(body, clock);
    messages = turns.flatMap((t) => {
      const role = ROLES.includes(t.role) ? t.role : kind === "ai_session" && t.speaker && AI_SPEAKER_RE.test(t.speaker) ? "assistant" : "user";
      const content = t.label && kind !== "ai_session" ? `${t.label}: ${t.text}` : t.text;
      return chunk(content).map((c, i) => withAt({ role, content: c }, i === 0 ? t.at : undefined));
    });
  } else {
    messages = chunk(body.trim()).map((content) => ({ role: "user", content }));
  }
  if (messages.length === 0) return { skip: "no text" };

  // The item's date, when it names an instant: an exact start, a bare day (midnight at `tz:`, else
  // UTC, as exactIso reads a bare date), or a date string with its own zone. A date-time with no
  // zone ("2026-10-21 09:12") names no instant, so it falls through to the first message time,
  // then now, and is kept as written in meta.date.
  const dated = firstString(data.date, data.start, data.started_at);
  const bareDay = dated && /^\d{4}-\d{2}-\d{2}$/.test(dated.trim()) ? dated.trim() : undefined;
  const fromItem = clock.start ?? (bareDay ? isoOrUndefined(`${bareDay}T00:00:00${clock.offset ?? "Z"}`) : undefined) ?? exactIso(dated);
  const startedAt = fromItem ?? messages.find((m) => m.at)?.at ?? now;
  const lastAt = [...messages].reverse().find((m) => m.at)?.at;
  const endedAt = lastAt && Date.parse(lastAt) >= Date.parse(startedAt) ? lastAt : startedAt;

  // The principal is the author of every fact distilled from this item, and a member's own facts
  // join their scope without the exclusion checks (PRD, living scopes). So it is never guessed
  // from a speaker: a chat or meeting has many people in it, and naming whoever spoke first would
  // put everyone's lines (a Falcon slip in #general, say) into that one person's scope. A chat or
  // transcript gets a principal only from front-matter or --principal; with none, its facts have
  // no author and join scopes only through the checks. AI sessions likewise: "You" is not a principal.
  const principal =
    toPrincipalId(firstString(data.principal, data.author, data.owner, data.by)) ??
    (mailish ? emailPrincipal(headers, firmDomain) : undefined) ??
    toPrincipalId(fallback);

  let external;
  if (typeof data.external === "boolean") external = data.external;
  else if (mailish) external = isExternalSender(headers.from, firmDomain);

  const speakers = [...new Set(turns.map((t) => t.label).filter(Boolean))];
  const participants = Array.isArray(data.participants) ? data.participants : speakers.length ? speakers : undefined;
  const session = {
    id: sessionIdFor(idKey),
    client: CLIENT,
    started_at: startedAt,
    ended_at: endedAt,
    title: makeTitle(firstString(data.title, email?.subject, firstHeading(body)) ?? humanize(rel)),
    messages,
    meta: compact({ path: rel, kind_from: by, source: firstString(data.source), participants, email, date: fromItem ? undefined : dated, unparsed_lines: unparsed }),
    kind,
  };
  if (principal) session.principal = principal;
  if (external !== undefined) session.external = external;
  return session;
}

/**
 * Sender at the firm → them; otherwise the first firm recipient (whose inbox it is). Addresses
 * come from mailboxes only (see mailboxesIn), never from display names.
 */
function emailPrincipal(headers, firmDomain) {
  const sender = senderOf(headers.from);
  if (sender && isFirmAddress(sender, firmDomain)) return toPrincipalId(sender);
  const recipient = [...mailboxesIn(headers.to), ...mailboxesIn(headers.cc)].find((a) => a && isFirmAddress(a, firmDomain));
  return recipient ? toPrincipalId(recipient) : undefined;
}

function readTextItem(text, ext) {
  const { data, body } = splitFrontMatter(String(text));
  return { data, body: ext === ".vtt" || ext === ".srt" ? fromSubtitles(body) : body };
}

/** WebVTT / SRT → "Speaker: text" lines: cue numbers, timing lines and the header dropped. */
function fromSubtitles(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => !/^WEBVTT/.test(l) && !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !/^(NOTE|STYLE)\b/.test(l))
    .map((l) => l.replace(/^<v\s+([^>]+)>(.*?)(?:<\/v>)?$/, "$1: $2"))
    .join("\n");
}

const SPEAKER_KEYS = ["speaker", "from", "user", "author", "name", "sender", "user_name"];
const TEXT_KEYS = ["text", "content", "message", "body"];
const TIME_KEYS = ["at", "ts", "timestamp", "time", "date"];

/**
 * JSONL: one message object per line. A line that is not valid JSON is left out and its line
 * number is returned in `unparsed` (the CLI reports it and exits 1, since the import is
 * incomplete); no good line at all is an error. JSON: an array of message objects, an object
 * with `messages`, or an object with a text `body` / `text` / `content`. Top-level keys of an
 * object act as front-matter (kind, principal, title, date, from, …). Unparseable JSON →
 * { error }; valid JSON that holds no item → { skip }.
 */
function readJsonItem(text, ext) {
  let data = {};
  let list;
  const unparsed = [];
  if (ext === ".jsonl") {
    list = [];
    String(text)
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (!line.trim()) return;
        try {
          list.push(JSON.parse(line));
        } catch {
          unparsed.push(i + 1);
        }
      });
    if (unparsed.length > 0 && list.length === 0) return { error: "bad JSONL (no line is valid JSON)" };
  } else {
    let value;
    try {
      value = JSON.parse(text);
    } catch (err) {
      return { error: `bad JSON (${err.message})` };
    }
    if (Array.isArray(value)) list = value;
    else if (isRecord(value)) {
      data = Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v !== "object" || Array.isArray(v)).map(([k, v]) => [k.toLowerCase(), v]));
      if (Array.isArray(value.messages)) list = value.messages;
      else {
        const body = firstString(...TEXT_KEYS.map((k) => value[k]));
        return body ? { data, body } : { skip: "JSON object with no messages or body" };
      }
    } else return { skip: "JSON is not an object or array" };
  }
  const rows = list.filter(isRecord).flatMap((o) => {
    const text = firstString(...TEXT_KEYS.map((k) => o[k]));
    if (!text || !text.trim()) return [];
    const speaker = firstString(...SPEAKER_KEYS.map((k) => o[k]));
    const role = typeof o.role === "string" ? o.role : undefined;
    const at = TIME_KEYS.map((k) => o[k]).find((v) => typeof v === "string" || typeof v === "number");
    return [{ speaker, label: speaker, role, at, text: text.trim() }];
  });
  return { data, body: rows.map((r) => (r.label ? `${r.label}: ${r.text}` : r.text)).join("\n"), rows, unparsed: unparsed.length ? unparsed : undefined };
}

// ------------------------------------------------------------------------------- disk

/**
 * Every ingestible file under `root`, as POSIX paths relative to it, sorted. Skips dotfiles,
 * node_modules, README files (a world's own docs are not firm content) and other extensions.
 */
export function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile() && isIngestible(entry.name)) out.push(toPosix(relative(root, abs)));
    }
  };
  visit(root);
  return out;
}

/** A file name or path we would ingest: a known extension, and not a README or dotfile. */
export function isIngestible(path) {
  const name = basename(String(path));
  return !name.startsWith(".") && !/^readme(\.|$)/i.test(name) && EXTENSIONS.includes(extname(name).toLowerCase());
}

/** Reads one file for buildItem, or says why it was skipped. */
export function readItem(abs) {
  const size = statSync(abs).size;
  if (size > FILE_MAX_BYTES) return { skip: `${Math.round(size / 1000)} KB is over the ${FILE_MAX_BYTES / 1000} KB cap` };
  return { text: readFileSync(abs, "utf8") };
}

// ------------------------------------------------------------------------------ small

/** Splits at paragraph breaks so no message is over MESSAGE_MAX; a giant paragraph is hard-split. */
export function chunk(text, max = MESSAGE_MAX) {
  const t = String(text).trim();
  if (!t) return [];
  if (t.length <= max) return [t];
  const out = [];
  let cur = "";
  for (const para of t.split(/\n{2,}/)) {
    for (let p = para; p; p = p.slice(max)) {
      const piece = p.slice(0, max);
      if (cur && cur.length + 2 + piece.length > max) {
        out.push(cur);
        cur = "";
      }
      cur = cur ? `${cur}\n\n${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Whitespace collapsed, at most TITLE_MAX chars, cut at a word boundary when one is near the end. */
export function makeTitle(text) {
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  if (oneLine.length <= TITLE_MAX) return oneLine;
  const cut = oneLine.slice(0, TITLE_MAX + 1);
  const space = cut.lastIndexOf(" ");
  return (space >= TITLE_MAX * 0.75 ? cut.slice(0, space) : cut.slice(0, TITLE_MAX)).trimEnd();
}

function firstHeading(body) {
  return /^#{1,3}\s+(.+)$/m.exec(String(body))?.[1];
}

/** "memos/falcon-ic-memo.md" → "falcon ic memo". */
function humanize(rel) {
  const file = rel.split("/").pop() ?? rel;
  return basename(file, extname(file)).replace(/[-_]+/g, " ").trim() || rel;
}

function toPosix(p) {
  return String(p).split(sep).join("/");
}

/** A date string or epoch ms → ISO, or undefined; never throws on out-of-range values. */
function isoOrUndefined(v) {
  const d = new Date(typeof v === "number" ? v : Date.parse(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function withAt(msg, at) {
  if (at) msg.at = at;
  return msg;
}

function firstString(...values) {
  return values.find((v) => typeof v === "string" && v.trim() !== "");
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => typeof obj[k] === "string").map((k) => [k, obj[k]]));
}

function isRecord(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Drop undefined / empty values so the JSON body stays clean. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return Object.keys(out).length ? out : undefined;
}
