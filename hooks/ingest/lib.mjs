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
// Security rule: the principal is the author of every fact from the item, and decides access. It
// is never guessed: not from a speaker, not from an email recipient, not from the first token of a
// name. A name or an address becomes a principal id only through an explicit directory.
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
  return withoutComments(value.replace(/"(?:[^"\\]|\\.)*"/g, " "))
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

/** `(comments)`, nested ones included, replaced by a space. */
function withoutComments(value) {
  let v = String(value);
  for (let prev = ""; prev !== v; ) {
    prev = v;
    v = v.replace(/\([^()]*\)/g, " ");
  }
  return v;
}

// Quoted or forwarded mail inside a body: "> " lines, an "On … wrote:" line (one wrap allowed),
// Outlook's "-----Original Message-----" or its "From: … / Sent: …" block, a forward marker.
const QUOTED_MAIL_RES = [
  /^[ \t]*>/m,
  /^[ \t]*-{2,}[ \t]*(?:original message|forwarded message)[ \t]*-{2,}/im,
  /^[ \t]*begin forwarded message:/im,
  /^[ \t]*on\b[^\n]{0,300}(?:\n[^\n]{0,300})?\bwrote:[ \t]*$/im,
  /^[ \t]*from:[^\n]*\n[ \t]*(?:sent|date):/im,
];

/** True when an email body carries another message's text (a reply's quote, a forward). */
export function quotesAnotherMessage(body) {
  const text = String(body);
  return QUOTED_MAIL_RES.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------- principals

/**
 * A principal directory: which principal id each name and address belongs to, from an explicit
 * list (the CLI's --principals FILE). It is the only way ingest turns a name ("Dan Okafor") or an
 * address (dan.okafor@harborlane.com) into an id. Takes GET /api/principals' shape
 * (`{ "principals": Principal[] }`) or a bare array; each entry may add `emails` (its mailboxes)
 * and `aliases` (other spellings of its name). A name two principals share resolves to none. An id
 * or address listed twice, or a malformed entry, throws: the file itself is then wrong.
 */
export function principalDirectory(value) {
  const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.principals) ? value.principals : undefined;
  if (!list) throw new Error('a principals file is a JSON array of principals, or { "principals": [...] }');
  const ids = new Set();
  const emails = new Map();
  const names = new Map(); // name key → id, or null when two principals share it
  list.forEach((p, i) => {
    const where = `principals[${i}]`;
    if (!isRecord(p)) throw new Error(`${where} is not an object`);
    if (typeof p.id !== "string" || normalizePrincipal(p.id) !== p.id) throw new Error(`${where}: ${JSON.stringify(p.id)} is not a principal id (dan, agt_…)`);
    if (ids.has(p.id)) throw new Error(`${where}: ${p.id} is listed twice`);
    ids.add(p.id);
    for (const e of stringList(p.emails, `${where}.emails`)) {
      const addr = e.trim().toLowerCase();
      if (!ADDR_SPEC_RE.test(addr)) throw new Error(`${where}: ${JSON.stringify(e)} is not an email address`);
      if (emails.has(addr)) throw new Error(`${where}: ${addr} is already ${emails.get(addr)}'s`);
      emails.set(addr, p.id);
    }
    for (const n of [...(typeof p.name === "string" ? [p.name] : []), ...stringList(p.aliases, `${where}.aliases`)]) {
      const key = nameKey(n);
      if (key) names.set(key, names.has(key) && names.get(key) !== p.id ? null : p.id);
    }
  });
  return { ids, emails, names };
}

function stringList(v, where) {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) throw new Error(`${where} must be a list of strings`);
  return v;
}

/** "Dan  Okafor (MD)" → "dan okafor": comments dropped, whitespace collapsed, lowercased. */
function nameKey(name) {
  return withoutComments(name).replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Whoever an item names as its principal (front-matter `principal` / `author`, a firm sender,
 * --principal) → their id, or undefined. Never guessed, because the principal decides access:
 *   - an id is taken as written (`dan`, `AGT_Deal-Analyst` → `agt_deal-analyst`, `Maya (Compliance)`
 *     → `maya`). With a directory it must be one of its ids; else it is read as a name, so a
 *     one-word alias such as "Danny" still resolves to the principal that lists it
 *   - a name or an address maps to an id only through the directory: "Leo Chen
 *     <leo.chen@harborlane.com>" is not Leo Brandt because both start with "leo". An address must be
 *     the value's one mailbox (see senderOf), so a display name cannot smuggle one in.
 */
export function resolvePrincipal(value, directory) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (value.includes("@")) {
    const addr = senderOf(value);
    return addr && directory ? directory.emails.get(addr) : undefined;
  }
  const bare = withoutComments(value).replace(/\s+/g, " ").trim();
  if (!bare || /[()]/.test(bare)) return undefined;
  const id = normalizePrincipal(bare);
  if (!directory) return id;
  if (id && directory.ids.has(id)) return id;
  // Not an id in the directory: a name or alias, which only the directory maps (a name two
  // principals share is null there, so it resolves to none).
  return directory.names.get(nameKey(bare)) ?? undefined;
}

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
 * (bad JSON, a JSON shape we cannot read, or JSON rows none of which could be read). The CLI goes on after either, but only an
 * error makes the run exit 1. A JSONL or JSON file with some rows that could not be read (not
 * JSON, not an object, or a message whose text is not a string or text blocks) still becomes a
 * session from the good rows, and meta.unparsed_lines (JSONL line numbers) or meta.unparsed_rows
 * (1-based positions in a JSON message list) records what was left out. A row read only in part
 * (text next to an image or another block we cannot read: the text is kept) is recorded the same
 * way in meta.partial_lines / meta.partial_rows, and a JSON document whose body was read in part
 * sets meta.partial_body. The CLI reports any of these and exits 1, because the import is
 * incomplete.
 *   relPath      path relative to the ingest root: folder-name kind signals, meta.path, title
 *   idKey        what the id is derived from (the CLI passes the real absolute path); default relPath
 *   text         file contents
 *   firmDomain   sender domains outside it mark an email external
 *   principal    fallback principal for items that name no author at all (--principal)
 *   directory    principalDirectory(): the only way a name or an address becomes a principal id
 *   now          ISO time for items that carry no date at all
 */
export function buildItem({ relPath, idKey = relPath, text, firmDomain = DEFAULT_FIRM_DOMAIN, principal: fallback, directory, now = new Date().toISOString() }) {
  const rel = toPosix(relPath);
  const ext = extname(rel).toLowerCase();
  const parsed = ext === ".json" || ext === ".jsonl" ? readJsonItem(text, ext) : readTextItem(text, ext);
  if (parsed.error) return { error: parsed.error };
  if (parsed.skip) return { skip: parsed.skip };
  const { data, body, rows, unparsed, unparsedRows, partial, partialRows, partialBody } = parsed;
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
  if (messages.length === 0) {
    if (unparsed) return { error: `no readable message (${countList("line", unparsed)} could not be read)` };
    if (unparsedRows) return { error: `no readable message (${countList("row", unparsedRows)} could not be read)` };
    return { skip: "no text" };
  }

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

  // Security rule: the principal is the author of every fact distilled from this item, and a
  // member's own facts join their scope without the exclusion checks (PRD, living scopes). So it
  // comes only from a statement of who wrote the item, resolved by resolvePrincipal, and the
  // first statement found decides (an unresolved one gives none, never the next source):
  //   0. mail from outside the firm, or from a sender we cannot read: none, whatever else the
  //      file says. An outsider's text is nobody's own memory, so its facts pass each scope's
  //      checks. Never a recipient: whose inbox it sits in does not make them its author, and an
  //      outsider would otherwise choose, by addressing it, whose scope it joins.
  //   1. front-matter `principal` / `author` / `owner` / `by`. A memo by Nadia (not a principal)
  //      is nobody's own memory, not --principal dan's.
  //   2. firm mail: its one firm sender, when the body quotes or forwards no other message (that
  //      text has other authors). Never --principal.
  //   3. --principal, for items that name no author at all.
  // Never a speaker: a chat or meeting has many people in it, and naming whoever spoke first would
  // put everyone's lines (a Falcon slip in #general, say) into that one person's scope. AI
  // sessions likewise: "You" is not a principal.
  const named = firstString(data.principal, data.author, data.owner, data.by);
  const sender = mailish ? senderOf(headers.from) : undefined;
  let principal;
  if (mailish && !(sender && isFirmAddress(sender, firmDomain))) principal = undefined;
  else if (named !== undefined) principal = resolvePrincipal(named, directory);
  else if (mailish) principal = quotesAnotherMessage(parsedEmail.body) ? undefined : resolvePrincipal(sender, directory);
  else principal = resolvePrincipal(fallback, directory);

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
    meta: compact({
      path: rel,
      kind_from: by,
      source: firstString(data.source),
      participants,
      email,
      date: fromItem ? undefined : dated,
      unparsed_lines: unparsed,
      unparsed_rows: unparsedRows,
      partial_lines: partial,
      partial_rows: partialRows,
      partial_body: partialBody,
    }),
    kind,
  };
  if (principal) session.principal = principal;
  if (external !== undefined) session.external = external;
  return session;
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

// Content blocks that are not conversation text; skipped, as the Claude Code hook skips them.
const NON_TEXT_BLOCKS = new Set(["tool_use", "tool_result", "server_tool_use", "thinking", "redacted_thinking"]);
// Text blocks: Claude's `text`, OpenAI's `input_text` / `output_text`.
const TEXT_BLOCK_RE = /^(?:input_|output_)?text$/;

/**
 * One text field of a JSON row → { text }, { none } when it deliberately holds no text (blank, or
 * only tool and thinking blocks), or { unreadable } when it holds something we cannot read (an
 * image block, a number, an object of unknown shape). Reads a string, a list of content blocks
 * (`[{ type: "text", text }]`, the Claude API and Claude export shape) and a ChatGPT export's
 * `{ content_type, parts: [...] }`; several text pieces join with a blank line. Text next to a
 * block we cannot read (a message with text and an image) → { text, partial: true }: the text is
 * kept and the loss is still reported, as for an image-only message.
 */
function readText(v) {
  if (typeof v === "string") return v.trim() ? { text: v.trim() } : { none: true };
  const parts = Array.isArray(v) ? v : isRecord(v) && Array.isArray(v.parts) ? v.parts : isRecord(v) && typeof v.text === "string" ? [v] : undefined;
  if (!parts) return { unreadable: true };
  const texts = [];
  let unreadable = false;
  for (const p of parts) {
    const t = typeof p === "string" ? p : isRecord(p) && typeof p.text === "string" && (p.type === undefined || TEXT_BLOCK_RE.test(p.type)) ? p.text : undefined;
    if (t !== undefined) {
      if (t.trim()) texts.push(t.trim());
    } else if (!(isRecord(p) && NON_TEXT_BLOCKS.has(p.type))) unreadable = true;
  }
  if (texts.length) return unreadable ? { text: texts.join("\n\n"), partial: true } : { text: texts.join("\n\n") };
  return unreadable ? { unreadable: true } : { none: true };
}

/** Several reads of one object's text fields → the text to keep, and whether something was lost. */
function firstText(reads) {
  const hit = reads.find((r) => r.text);
  // Lost: the kept field also held a block we cannot read, or another text field held one.
  return hit ? { text: hit.text, partial: reads.some((r) => r.partial || r.unreadable) } : undefined;
}

/**
 * Message objects → rows, plus the positions (0-based) of entries that could not be read: not an
 * object, a text field we cannot read, or a speaker or role with no text field at all; and of
 * rows read only in part (text kept, an image or other block we cannot read left out). A row
 * whose text is blank or only tool calls, or an object that names no speaker and carries no text
 * (export metadata), is left out silently: nothing is lost.
 */
function readRows(list) {
  const rows = [];
  const bad = [];
  const partial = [];
  list.forEach((o, i) => {
    if (!isRecord(o)) return void bad.push(i);
    const speaker = firstString(...SPEAKER_KEYS.map((k) => o[k]));
    const role = typeof o.role === "string" ? o.role : undefined;
    const reads = TEXT_KEYS.filter((k) => o[k] !== undefined && o[k] !== null).map((k) => readText(o[k]));
    const hit = firstText(reads);
    if (hit) {
      const at = TIME_KEYS.map((k) => o[k]).find((v) => typeof v === "string" || typeof v === "number");
      rows.push({ speaker, label: speaker, role, at, text: hit.text });
      if (hit.partial) partial.push(i);
    } else if (reads.some((r) => r.unreadable) || (reads.length === 0 && (speaker || role))) bad.push(i);
  });
  return { rows, bad, partial };
}

/**
 * JSONL: one message object per line. JSON: an array of message objects, an object with
 * `messages`, or an object with a text `body` / `text` / `content`. Top-level keys of an object
 * act as front-matter (kind, principal, title, date, from, …). An entry that could not be read
 * (see readRows; for JSONL also a line that is not valid JSON) is left out and its JSONL line
 * number goes in `unparsed`, its 1-based position in a JSON list in `unparsedRows`. A row read
 * only in part (its text kept, an image or other block left out) goes in `partial` / `partialRows`
 * the same way, and a document whose body was read in part sets `partialBody`. The CLI reports
 * any of these and exits 1, since the import is incomplete. Unparseable JSON, JSONL with no valid
 * line, a `messages` that is not a list, or a bare JSON string or number → { error }; valid JSON
 * that holds nothing (`null`, `{}`, an object with no messages or body) → { skip }.
 */
function readJsonItem(text, ext) {
  let data = {};
  let list;
  let lineOf; // JSONL: list index → line number
  const badLines = [];
  if (ext === ".jsonl") {
    list = [];
    lineOf = [];
    String(text)
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (!line.trim()) return;
        try {
          list.push(JSON.parse(line));
          lineOf.push(i + 1);
        } catch {
          badLines.push(i + 1);
        }
      });
    if (badLines.length > 0 && list.length === 0) return { error: "bad JSONL (no line is valid JSON)" };
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
      // Messages in a shape we cannot read (a map of ids, a string): content we would drop.
      else if (value.messages !== undefined && value.messages !== null) return { error: "JSON whose `messages` is not a list" };
      else {
        const reads = TEXT_KEYS.filter((k) => value[k] !== undefined && value[k] !== null).map((k) => readText(value[k]));
        const hit = firstText(reads);
        if (hit) return { data, body: hit.text, partialBody: hit.partial || undefined };
        if (reads.some((r) => r.unreadable)) return { error: "JSON object whose text is not a string or text blocks" };
        return { skip: "JSON object with no messages or body" };
      }
    } else if (value === null) return { skip: "JSON is null" };
    // A bare string, number or boolean is not a shape we read; a string may be a whole memo.
    else return { error: "JSON is not an object or array" };
  }
  const { rows, bad, partial } = readRows(list);
  const unparsed = lineOf ? [...badLines, ...bad.map((i) => lineOf[i])].sort((a, b) => a - b) : [];
  const unparsedRows = lineOf ? [] : bad.map((i) => i + 1);
  const partialLines = lineOf ? partial.map((i) => lineOf[i]) : [];
  const partialRows = lineOf ? [] : partial.map((i) => i + 1);
  return {
    data,
    body: rows.map((r) => (r.label ? `${r.label}: ${r.text}` : r.text)).join("\n"),
    rows,
    unparsed: unparsed.length ? unparsed : undefined,
    unparsedRows: unparsedRows.length ? unparsedRows : undefined,
    partial: partialLines.length ? partialLines : undefined,
    partialRows: partialRows.length ? partialRows : undefined,
  };
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

/** ("line", [2]) → "line 2", ("row", [2, 5]) → "rows 2, 5"; long lists end in "…". */
export function countList(word, nums) {
  const shown = nums.slice(0, 5).join(", ") + (nums.length > 5 ? ", …" : "");
  return `${word}${nums.length === 1 ? "" : "s"} ${shown}`;
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
