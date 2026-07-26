/**
 * A defensive RFC 5322 / MIME reader.
 *
 * Email is the most hostile input this system accepts: every byte is written by whoever sent
 * the message, and a mailbox is a decade of it. Three rules run through this file and are
 * what make M-6 mechanical here rather than aspirational:
 *
 *  1. **Nothing throws.** Malformed MIME, an invalid charset label, a 10 MB body, bytes that
 *     are not UTF-8, an empty message — each yields a *partial* parse with the failure
 *     recorded in `anomalies`. A connector emits valid §2 envelopes or nothing; it never
 *     propagates a parse error as control flow.
 *  2. **Every structure is bounded** — bytes, headers, parts, depth, addresses, references.
 *     A message cannot make the parser allocate more than the limits below.
 *  3. **Duplicate singleton headers are an anomaly, not a choice.** Header injection shows up
 *     in a stored message as a second `From:` / `Subject:` line. The parser takes the FIRST
 *     occurrence and records `duplicate-header:from`; it never merges, never prefers the
 *     later one, and never lets the injected copy silently win.
 *
 * No dependency is used. `@servanda/*` and the Node standard library only — a mail parser is
 * the last place to add third-party code to the trusted path.
 */

export interface MimeLimits {
  /** Bytes of the message actually parsed. Beyond this the message is truncated, not refused. */
  readonly maxBytes: number;
  readonly maxHeaderBytes: number;
  readonly maxHeaders: number;
  readonly maxParts: number;
  readonly maxDepth: number;
  readonly maxAddresses: number;
  readonly maxReferences: number;
  readonly maxTextChars: number;
  readonly maxAttachments: number;
}

export const DEFAULT_LIMITS: MimeLimits = {
  maxBytes: 2 * 1024 * 1024,
  maxHeaderBytes: 128 * 1024,
  maxHeaders: 256,
  maxParts: 64,
  maxDepth: 8,
  maxAddresses: 64,
  maxReferences: 32,
  maxTextChars: 256 * 1024,
  maxAttachments: 32,
};

export interface MailAddress {
  /** The display name as written, decoded but NOT authenticated. Never an identity (M-12). */
  readonly name?: string;
  /** `local@domain`, verbatim. Absent when the token does not look like an address at all. */
  readonly address?: string;
  /** The token as it appeared, clipped. Kept so nothing is silently normalized away. */
  readonly raw: string;
}

export interface MailAttachment {
  readonly filename?: string;
  readonly content_type: string;
  readonly bytes: number;
}

export interface ParsedMessage {
  readonly subject?: string;
  readonly from: readonly MailAddress[];
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
  readonly replyTo: readonly MailAddress[];
  /** Addresses the MDA recorded as the delivery target (`Delivered-To` and friends). */
  readonly deliveredTo: readonly string[];
  /** The message's own `Date`, normalized to RFC 3339 UTC. Absent if missing or unparseable. */
  readonly date?: string;
  readonly messageId?: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  /** Best-effort human-readable body. Empty string when there is none. */
  readonly text: string;
  /** Characters of body text before clipping — the original length, preserved. */
  readonly textLength: number;
  readonly html: boolean;
  readonly attachments: readonly MailAttachment[];
  /** A `message/rfc822` part, parsed one level down. The forwarded original. */
  readonly embedded?: ParsedMessage;
  /** Bytes the message occupied before truncation. */
  readonly rawBytes: number;
  readonly truncated: boolean;
  /** Everything that did not parse cleanly, as stable machine-readable tokens. */
  readonly anomalies: readonly string[];
  /** Raw `Authentication-Results` header values, observed and NOT interpreted (M-12). */
  readonly observedAuthResults: readonly string[];
}

interface Header {
  readonly name: string;
  readonly value: string;
}

interface Entity {
  readonly headers: readonly Header[];
  readonly body: Uint8Array;
  readonly anomalies: string[];
}

const CR = 13;
const LF = 10;

function decodeUtf8(bytes: Uint8Array): string {
  // `fatal: false` — invalid sequences become U+FFFD. Bytes that are not text are still
  // data; they must not be able to stop a mailbox from being read.
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  if (charset === undefined || charset.length === 0) return decodeUtf8(bytes);
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    // An unknown or hostile charset label ("../../etc/passwd") is not fatal.
    return decodeUtf8(bytes);
  }
}

/** Index just past the header/body separator (a blank line), or -1. */
function headerEnd(bytes: Uint8Array, limit: number): { end: number; bodyStart: number } {
  const n = Math.min(bytes.length, limit);
  for (let i = 0; i < n; i++) {
    if (bytes[i] !== LF) continue;
    // \n\n
    if (bytes[i + 1] === LF) return { end: i, bodyStart: i + 2 };
    // \n\r\n
    if (bytes[i + 1] === CR && bytes[i + 2] === LF) return { end: i, bodyStart: i + 3 };
  }
  return { end: -1, bodyStart: -1 };
}

const HEADER_NAME = /^[!-9;-~]+$/u;

function parseHeaderBlock(block: string, limits: MimeLimits, anomalies: string[]): Header[] {
  const out: Header[] = [];
  // Unfold: a line beginning with SP/HTAB continues the previous one (RFC 5322 §2.2.3).
  const unfolded: string[] = [];
  for (const line of block.split('\n')) {
    const clean = line.replace(/\r$/u, '');
    if (clean.length === 0) continue;
    if ((clean.startsWith(' ') || clean.startsWith('\t')) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += ` ${clean.trim()}`;
      continue;
    }
    unfolded.push(clean);
  }
  for (const line of unfolded) {
    if (out.length >= limits.maxHeaders) {
      anomalies.push('header-limit');
      break;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      anomalies.push('malformed-header-line');
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!HEADER_NAME.test(name)) {
      anomalies.push('malformed-header-name');
      continue;
    }
    out.push({ name, value: line.slice(colon + 1).trim() });
  }
  return out;
}

/**
 * Singleton headers. A stored message with two of any of these is the observable signature
 * of header injection (a `Subject` that contained a newline at composition time), so the
 * first is taken and the duplicate is recorded.
 */
const SINGLETON = new Set([
  'from',
  'date',
  'subject',
  'message-id',
  'in-reply-to',
  'sender',
  'return-path',
]);

function first(headers: readonly Header[], name: string, anomalies: string[]): string | undefined {
  let found: string | undefined;
  let count = 0;
  for (const h of headers) {
    if (h.name !== name) continue;
    count++;
    if (found === undefined) found = h.value;
  }
  if (count > 1 && SINGLETON.has(name)) anomalies.push(`duplicate-header:${name}`);
  return found;
}

function all(headers: readonly Header[], name: string): string[] {
  return headers.filter((h) => h.name === name).map((h) => h.value);
}

// ── RFC 2047 encoded-words ────────────────────────────────────────────────────────────────

const ENCODED_WORD = /=\?([^?]{1,64})\?([BbQq])\?([^?]{0,1024})\?=/gu;

function decodeQuotedPrintableText(s: string, underscoreIsSpace: boolean): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '_' && underscoreIsSpace) {
      out.push(32);
      continue;
    }
    if (c !== '=') {
      out.push(c.charCodeAt(0) & 0xff);
      continue;
    }
    const hex = s.slice(i + 1, i + 3);
    if (/^[0-9a-fA-F]{2}$/u.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else {
      out.push(61); // a bare '=' is kept, not treated as a parse failure
    }
  }
  return Uint8Array.from(out);
}

/**
 * Decodes `=?charset?B?...?=` runs. Never throws.
 *
 * An unknown charset label falls back to UTF-8 (mislabelled mail is ordinary, not hostile).
 * A word that decodes to NOTHING is left verbatim instead: silently erasing text a human
 * wrote is worse than showing them an undecoded token, and `!!!!` in a base64 word is how an
 * attacker would make a subject disappear.
 */
export function decodeEncodedWords(s: string): string {
  return s.replace(ENCODED_WORD, (whole, charset: string, enc: string, text: string) => {
    try {
      const bytes =
        enc.toLowerCase() === 'b'
          ? new Uint8Array(Buffer.from(text, 'base64'))
          : decodeQuotedPrintableText(text, true);
      const decoded = decodeCharset(bytes, charset.split('*')[0]);
      return decoded.length === 0 && text.length > 0 ? whole : decoded;
    } catch {
      return whole;
    }
  });
}

// ── addresses ─────────────────────────────────────────────────────────────────────────────

/** Splits on commas that are not inside quotes or angle brackets. */
function splitAddressList(s: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quoted = false;
  let angle = false;
  for (const c of s) {
    if (c === '"' && !angle) quoted = !quoted;
    else if (c === '<' && !quoted) angle = true;
    else if (c === '>' && !quoted) angle = false;
    if (c === ',' && !quoted && !angle) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  out.push(buf);
  return out.map((x) => x.trim()).filter((x) => x.length > 0);
}

const ADDRESS_SHAPE = /^[^\s<>@]+@[^\s<>@]+$/u;

export function parseAddressList(raw: string | undefined, limits: MimeLimits): MailAddress[] {
  if (raw === undefined) return [];
  const out: MailAddress[] = [];
  for (const token of splitAddressList(decodeEncodedWords(raw))) {
    if (out.length >= limits.maxAddresses) break;
    const angle = /<([^>]*)>/u.exec(token);
    if (angle !== null) {
      const address = angle[1]!.trim();
      const name = token.slice(0, angle.index).trim().replace(/^"|"$/gu, '').trim();
      out.push({
        ...(name.length > 0 ? { name } : {}),
        ...(ADDRESS_SHAPE.test(address) ? { address } : {}),
        raw: token.slice(0, 512),
      });
      continue;
    }
    // A token with no angle brackets is an address only if it was NOT quoted. `From:
    // "ceo@acme.example"` is a display name that LOOKS like an address, which is precisely the
    // M-12 confusion: deriving an address from a quoted string would let a sender pick their
    // own `external_id`.
    const quoted = /^".*"$/su.test(token);
    const bare = token.replace(/^"|"$/gu, '').trim();
    out.push({
      ...(quoted && bare.length > 0 ? { name: bare } : {}),
      ...(!quoted && ADDRESS_SHAPE.test(bare) ? { address: bare } : {}),
      raw: token.slice(0, 512),
    });
  }
  return out;
}

// ── message ids ───────────────────────────────────────────────────────────────────────────

const MSGID_INVALID = /[\p{Cc}\p{Cf}\s]/gu;

/**
 * `<x@y>` → `x@y`. Whitespace and invisibles are stripped; nothing else is normalized.
 *
 * An id that is empty once the brackets come off yields `undefined` rather than the literal
 * `<>`: a placeholder value would be SHARED by every message that carries a broken id, and
 * thread identity is built on these — two unrelated conversations must never merge.
 */
export function normalizeMessageId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const angle = /<([^>]{1,512})>/u.exec(raw);
  const inner = (angle === null ? raw : angle[1]!)
    .replace(MSGID_INVALID, '')
    .replace(/^<+|>+$/gu, '');
  return inner.length === 0 ? undefined : inner.slice(0, 512);
}

export function parseReferences(raw: string | undefined, limits: MimeLimits): string[] {
  if (raw === undefined) return [];
  const out: string[] = [];
  for (const m of raw.matchAll(/<([^>]{1,512})>/gu)) {
    if (out.length >= limits.maxReferences) break;
    const id = m[1]!.replace(MSGID_INVALID, '');
    if (id.length > 0 && !out.includes(id)) out.push(id);
  }
  if (out.length === 0) {
    // A `References` header without angle brackets still carries something citable.
    for (const token of raw.split(/\s+/u)) {
      if (out.length >= limits.maxReferences) break;
      const id = token.replace(MSGID_INVALID, '');
      if (id.length > 0 && !out.includes(id)) out.push(id.slice(0, 512));
    }
  }
  return out;
}

// ── dates ─────────────────────────────────────────────────────────────────────────────────

/**
 * RFC 5322 `Date` → RFC 3339 UTC, seconds precision. A missing, unparseable, or absurd date
 * yields `undefined` — the caller decides whether an envelope can exist without one.
 */
export function rfc3339FromMailDate(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // A folded/injected date can carry a trailing comment; V8's parser tolerates it, but an
  // embedded newline has already been removed by unfolding.
  const ms = Date.parse(raw.trim());
  if (!Number.isFinite(ms)) return undefined;
  // Outside this range a `Date` is not a real mail timestamp, and `toISOString` can throw.
  if (ms < 0 || ms > 32_503_680_000_000) return undefined;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

// ── content type & transfer encoding ──────────────────────────────────────────────────────

interface ContentType {
  readonly type: string;
  readonly params: Readonly<Record<string, string>>;
}

function parseContentType(raw: string | undefined): ContentType {
  if (raw === undefined) return { type: 'text/plain', params: {} };
  const [head, ...rest] = raw.split(';');
  const type = (head ?? '').trim().toLowerCase() || 'text/plain';
  const params: Record<string, string> = {};
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"')) value = value.slice(1, value.indexOf('"', 1) < 0 ? undefined : value.indexOf('"', 1));
    if (key.length > 0 && params[key] === undefined) params[key] = value.slice(0, 256);
  }
  return { type, params };
}

function decodeTransfer(body: Uint8Array, encoding: string | undefined): Uint8Array {
  const enc = (encoding ?? '').trim().toLowerCase();
  if (enc === 'base64') {
    // Buffer's base64 decoder ignores everything outside the alphabet, which is exactly the
    // lenient behaviour a hostile part needs: it cannot make decoding fail.
    return new Uint8Array(Buffer.from(decodeUtf8(body), 'base64'));
  }
  if (enc === 'quoted-printable') {
    const text = decodeUtf8(body).replace(/=\r?\n/gu, '');
    return decodeQuotedPrintableText(text, false);
  }
  return body;
}

// ── multipart ─────────────────────────────────────────────────────────────────────────────

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function splitMultipart(body: Uint8Array, boundary: string, limits: MimeLimits): Uint8Array[] {
  const marker = new TextEncoder().encode(`--${boundary}`);
  const parts: Uint8Array[] = [];
  let cursor = indexOfBytes(body, marker, 0);
  if (cursor < 0) return parts;
  while (cursor >= 0 && parts.length < limits.maxParts) {
    const start = cursor + marker.length;
    // `--boundary--` closes the multipart.
    if (body[start] === 45 && body[start + 1] === 45) break;
    const next = indexOfBytes(body, marker, start);
    const end = next < 0 ? body.length : next;
    // Skip the CRLF that terminates the boundary line.
    let s = start;
    if (body[s] === CR) s++;
    if (body[s] === LF) s++;
    parts.push(body.subarray(s, end));
    if (next < 0) break;
    cursor = next;
  }
  return parts;
}

// ── html ──────────────────────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/**
 * HTML → visible text.
 *
 * `<script>` and `<style>` CONTENT is dropped rather than carried into `payload.text`. That
 * is a rendering decision, not a security one — nothing in this system executes an envelope,
 * so a script body is noise, and the honest reading of "the visible text of this message" does
 * not include it. `payload.html` records that the source was HTML and `payload.text_length`
 * preserves the original length, so nothing about the drop is silent.
 */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<\/?(?:p|div|br|tr|li|h[1-6])\b[^>]*>/giu, '\n')
    .replace(/<[^>]*>/gu, ' ');
  const decoded = stripped.replace(/&[a-zA-Z#0-9]{1,8};/gu, (e) => ENTITIES[e.toLowerCase()] ?? e);
  return decoded
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

// ── the parser ────────────────────────────────────────────────────────────────────────────

function parseEntity(bytes: Uint8Array, limits: MimeLimits): Entity {
  const anomalies: string[] = [];
  const { end, bodyStart } = headerEnd(bytes, limits.maxHeaderBytes);
  if (end < 0) {
    // No blank line: either a headers-only message or a body that never announced itself.
    // Both are parsed as headers, and the anomaly says which assumption was made.
    anomalies.push('no-header-separator');
    const block = decodeUtf8(bytes.subarray(0, Math.min(bytes.length, limits.maxHeaderBytes)));
    return { headers: parseHeaderBlock(block, limits, anomalies), body: new Uint8Array(0), anomalies };
  }
  const block = decodeUtf8(bytes.subarray(0, end));
  return {
    headers: parseHeaderBlock(block, limits, anomalies),
    body: bytes.subarray(bodyStart),
    anomalies,
  };
}

interface Leaf {
  readonly contentType: ContentType;
  readonly disposition: string;
  readonly filename?: string;
  readonly bytes: Uint8Array;
}

/** Walks the MIME tree, bounded by depth and part count, collecting leaves and one embedded. */
function walk(
  entity: Entity,
  limits: MimeLimits,
  depth: number,
  leaves: Leaf[],
  embedded: { value?: Uint8Array },
  anomalies: string[],
): void {
  if (leaves.length >= limits.maxParts) return;
  const contentType = parseContentType(first(entity.headers, 'content-type', anomalies));
  const disposition = (first(entity.headers, 'content-disposition', anomalies) ?? '').toLowerCase();
  const filename =
    parseContentType(first(entity.headers, 'content-disposition', anomalies)).params['filename'] ??
    contentType.params['name'];

  if (contentType.type.startsWith('multipart/')) {
    if (depth >= limits.maxDepth) {
      anomalies.push('mime-depth-limit');
      return;
    }
    const boundary = contentType.params['boundary'];
    if (boundary === undefined || boundary.length === 0) {
      anomalies.push('multipart-without-boundary');
      return;
    }
    const parts = splitMultipart(entity.body, boundary, limits);
    if (parts.length === 0) anomalies.push('multipart-without-parts');
    for (const part of parts) {
      const sub = parseEntity(part, limits);
      anomalies.push(...sub.anomalies);
      walk(sub, limits, depth + 1, leaves, embedded, anomalies);
    }
    return;
  }

  const decoded = decodeTransfer(
    entity.body,
    first(entity.headers, 'content-transfer-encoding', anomalies),
  );

  if (contentType.type === 'message/rfc822') {
    if (embedded.value === undefined && depth < limits.maxDepth) embedded.value = decoded;
    return;
  }

  leaves.push({
    contentType,
    disposition,
    ...(filename === undefined ? {} : { filename: filename.slice(0, 256) }),
    bytes: decoded,
  });
}

export function parseMessage(raw: Uint8Array, limits: MimeLimits = DEFAULT_LIMITS): ParsedMessage {
  return parseMessageAt(raw, limits, 0);
}

function parseMessageAt(raw: Uint8Array, limits: MimeLimits, depth: number): ParsedMessage {
  const rawBytes = raw.length;
  const truncated = rawBytes > limits.maxBytes;
  const bytes = truncated ? raw.subarray(0, limits.maxBytes) : raw;

  const entity = parseEntity(bytes, limits);
  const anomalies: string[] = [...entity.anomalies];
  if (truncated) anomalies.push('truncated');
  if (rawBytes === 0) anomalies.push('empty-message');

  const leaves: Leaf[] = [];
  const embedded: { value?: Uint8Array } = {};
  walk(entity, limits, 0, leaves, embedded, anomalies);

  // Body selection: the first text/plain leaf that is not an attachment, else the first
  // text/html leaf. A message that is only attachments has no text, which is valid.
  const inline = leaves.filter((l) => !l.disposition.startsWith('attachment'));
  const plain = inline.find((l) => l.contentType.type === 'text/plain');
  const html = inline.find((l) => l.contentType.type === 'text/html');
  let text = '';
  let isHtml = false;
  if (plain !== undefined) {
    text = decodeCharset(plain.bytes, plain.contentType.params['charset']);
  } else if (html !== undefined) {
    isHtml = true;
    text = htmlToText(decodeCharset(html.bytes, html.contentType.params['charset']));
  }
  const textLength = text.length;
  if (textLength > limits.maxTextChars) {
    text = text.slice(0, limits.maxTextChars);
    anomalies.push('text-clipped');
  }

  const attachments: MailAttachment[] = [];
  for (const leaf of leaves) {
    if (attachments.length >= limits.maxAttachments) break;
    const isBody = leaf === plain || leaf === html;
    if (isBody && leaf.filename === undefined) continue;
    attachments.push({
      ...(leaf.filename === undefined ? {} : { filename: leaf.filename }),
      content_type: leaf.contentType.type,
      bytes: leaf.bytes.length,
    });
  }

  const subjectRaw = first(entity.headers, 'subject', anomalies);
  const date = rfc3339FromMailDate(first(entity.headers, 'date', anomalies));
  if (date === undefined && first(entity.headers, 'date', anomalies) !== undefined) {
    anomalies.push('unparseable-date');
  }

  const deliveredTo: string[] = [];
  for (const name of ['delivered-to', 'x-original-to', 'envelope-to', 'x-forwarded-to']) {
    for (const value of all(entity.headers, name)) {
      for (const a of parseAddressList(value, limits)) {
        if (a.address !== undefined && !deliveredTo.includes(a.address)) deliveredTo.push(a.address);
      }
    }
  }

  return {
    ...(subjectRaw === undefined
      ? {}
      : { subject: decodeEncodedWords(subjectRaw).slice(0, limits.maxTextChars) }),
    from: parseAddressList(first(entity.headers, 'from', anomalies), limits),
    to: parseAddressList(first(entity.headers, 'to', anomalies), limits),
    cc: parseAddressList(first(entity.headers, 'cc', anomalies), limits),
    replyTo: parseAddressList(first(entity.headers, 'reply-to', anomalies), limits),
    deliveredTo,
    ...(date === undefined ? {} : { date }),
    ...(() => {
      const id = normalizeMessageId(first(entity.headers, 'message-id', anomalies));
      return id === undefined ? {} : { messageId: id };
    })(),
    ...(() => {
      const id = normalizeMessageId(first(entity.headers, 'in-reply-to', anomalies));
      return id === undefined ? {} : { inReplyTo: id };
    })(),
    references: parseReferences(first(entity.headers, 'references', anomalies), limits),
    text,
    textLength,
    html: isHtml,
    attachments,
    ...(embedded.value === undefined || depth >= limits.maxDepth
      ? {}
      : { embedded: parseMessageAt(embedded.value, limits, depth + 1) }),
    rawBytes,
    truncated,
    // Sorted + deduped: the anomaly list is part of the envelope, so it must be a function of
    // the message and not of the order the parser happened to notice things.
    anomalies: [...new Set(anomalies)].sort(),
    observedAuthResults: all(entity.headers, 'authentication-results').map((v) => v.slice(0, 512)),
  };
}
