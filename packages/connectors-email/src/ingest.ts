import type { Envelope } from '@servanda/types';
import { MAX_PAYLOAD_TEXT, MAX_REF, clip, compact } from './envelope.js';
import type { ImapMessageSource } from './imap.js';
import { addressesOf, buildEnvelope } from './capture.js';
import type { CaptureContext, EmailIdentity } from './capture.js';
import { DEFAULT_LIMITS, decodeEncodedWords, normalizeMessageId, parseMessage, rfc3339FromMailDate } from './mime.js';
import type { MimeLimits, ParsedMessage } from './mime.js';

/**
 * BCC / forward capture — the in-situ gesture for mail (ui-design.md §"In-situ gestures").
 *
 * "Capture and confirmation have no screens of their own by definition." For mail the gesture
 * is: BCC the node's address on a message you are sending, or forward one you received. No
 * app, no wizard, no field to fill in. This module turns that into an envelope whose
 * `payload.original` preserves the message the gesture was about.
 *
 * The forwarded original is the most hostile input in the system: it is attacker-authored text
 * *inside a body*, wearing the costume of headers. Two rules follow, and both are tested:
 *
 *  - `actor` is always the OUTER message's sender. The original's `From:` line — whether it is
 *    a real `message/rfc822` header or four lines of prose someone typed — never becomes the
 *    actor and never becomes an `external_id`. It is a string under `payload.original.from_*`.
 *  - The original's timestamp never becomes `occurred_at`. The envelope records when the
 *    GESTURE happened; when the original happened is data (`payload.original.date`).
 */

export const INGEST_KINDS = ['email_bcc', 'email_forwarded'] as const;
export type IngestKind = (typeof INGEST_KINDS)[number];

/** Subjects that announce a forward, across the common clients and a few locales' clients. */
const FORWARD_SUBJECT = /^\s*(?:(?:fwd?|tr|wg|rv|vs|enc)\s*:\s*)+/iu;

/**
 * Inline forward separators. Narrowest defensible set: the four that Gmail, Apple Mail,
 * Outlook and Thunderbird actually emit. Anything cleverer would be guessing at prose.
 */
const FORWARD_SEPARATORS: readonly RegExp[] = [
  /^-{2,}\s*(?:forwarded message|original message|urspr.ngliche nachricht)\s*-{2,}\s*$/imu,
  /^begin forwarded message:\s*$/imu,
  /^_{16,}\s*$/mu,
];

interface InlineOriginal {
  readonly headerText: string;
  readonly bodyText: string;
}

function splitAtSeparator(text: string): InlineOriginal | undefined {
  let best = -1;
  let width = 0;
  for (const re of FORWARD_SEPARATORS) {
    const m = re.exec(text);
    if (m === null) continue;
    if (best < 0 || m.index < best) {
      best = m.index;
      width = m[0].length;
    }
  }
  if (best < 0) return undefined;
  const after = text.slice(best + width);
  // The pseudo-header block runs until the first blank line. Everything past it is the body.
  const blank = after.search(/\n\s*\n/u);
  return blank < 0
    ? { headerText: after.slice(0, 2048), bodyText: '' }
    : { headerText: after.slice(0, blank).slice(0, 2048), bodyText: after.slice(blank) };
}

const PSEUDO_HEADER = /^\s*(from|to|cc|subject|date|sent|reply-to)\s*:\s*(.*)$/iu;

/**
 * Reads `From:` / `Date:` / `Subject:` out of a forwarded block.
 *
 * These are NOT headers. They are lines of prose that a mail client wrote and an attacker can
 * write just as easily. Everything here lands under `payload.original.*` as inert strings and
 * is never promoted to `actor`, `occurred_at`, or a ref that implies provenance.
 */
function readPseudoHeaders(headerText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of headerText.split('\n').slice(0, 24)) {
    const m = PSEUDO_HEADER.exec(line);
    if (m === null) continue;
    const key = m[1]!.toLowerCase() === 'sent' ? 'date' : m[1]!.toLowerCase();
    if (out[key] === undefined) out[key] = decodeEncodedWords(m[2]!.trim()).slice(0, 512);
  }
  return out;
}

/** The original as payload: a flat, bounded, entirely inert record. */
function originalFromEmbedded(embedded: ParsedMessage): Record<string, unknown> {
  const from = embedded.from[0];
  return compact({
    kind: 'message/rfc822',
    from_display_name: from?.name === undefined ? undefined : clip(from.name, 320),
    from_address: from?.address === undefined ? undefined : clip(from.address, 320),
    from_raw: from === undefined ? undefined : clip(from.raw, 512),
    to: addressesOf(embedded.to),
    cc: addressesOf(embedded.cc),
    subject: embedded.subject === undefined ? undefined : clip(embedded.subject, MAX_PAYLOAD_TEXT),
    date: embedded.date,
    message_id: embedded.messageId,
    in_reply_to: embedded.inReplyTo,
    references_count: embedded.references.length,
    text: clip(embedded.text, MAX_PAYLOAD_TEXT),
    text_length: embedded.textLength,
    html: embedded.html,
    attachment_count: embedded.attachments.length,
    raw_bytes: embedded.rawBytes,
    header_anomalies: embedded.anomalies,
  });
}

function originalFromInline(inline: InlineOriginal): Record<string, unknown> {
  const pseudo = readPseudoHeaders(inline.headerText);
  const body = inline.bodyText.trim();
  return compact({
    // Named so no reader can mistake this for parsed headers: it is quoted prose.
    kind: 'inline_quoted',
    from_raw: pseudo['from'],
    to_raw: pseudo['to'],
    cc_raw: pseudo['cc'],
    subject: pseudo['subject'],
    // Parsed only if it happens to be a real date; never used for `occurred_at`.
    date: rfc3339FromMailDate(pseudo['date']),
    date_raw: pseudo['date'],
    text: clip(body, MAX_PAYLOAD_TEXT),
    text_length: body.length,
  });
}

export interface IngestOptions extends CaptureContext {
  readonly limits?: MimeLimits;
}

/**
 * One delivered message → zero or one envelope.
 *
 * Returns `undefined` when the message is not one of the two gestures — an ordinary inbound
 * message addressed to the node in `To`/`Cc` is capture, not a gesture, and belongs to
 * `envelopeFromMessage`.
 */
export function envelopeFromDelivered(
  source: ImapMessageSource,
  persona: string,
  identity: EmailIdentity,
  ctx: IngestOptions,
): Envelope | undefined {
  const parsed = parseMessage(source.raw, ctx.limits ?? DEFAULT_LIMITS);

  const subject = parsed.subject ?? '';
  const inline = splitAtSeparator(parsed.text);
  const isForward =
    parsed.embedded !== undefined || FORWARD_SUBJECT.test(subject) || inline !== undefined;

  // BCC is the absence of an address, which makes it inferable only from the envelope-level
  // headers the MDA wrote: the node was delivered a copy it is not named on.
  const named = new Set(
    [...addressesOf(parsed.to, 64), ...addressesOf(parsed.cc, 64)].map((a) => a.toLowerCase()),
  );
  const deliveredToSelf = parsed.deliveredTo
    .map((a) => a.toLowerCase())
    .filter((a) => identity.addresses.includes(a));
  const isBcc = deliveredToSelf.length > 0 && !deliveredToSelf.some((a) => named.has(a));

  if (!isForward && !isBcc) return undefined;

  const original =
    parsed.embedded !== undefined
      ? originalFromEmbedded(parsed.embedded)
      : inline !== undefined
        ? originalFromInline(inline)
        : undefined;

  // A forward carries the original's message-id when there is a real one to carry: that is what
  // lets a commitment extracted from the forward cite the thread it came from.
  const originalId =
    parsed.embedded === undefined ? undefined : normalizeMessageId(parsed.embedded.messageId);
  const extraRefs =
    originalId === undefined
      ? []
      : [{ kind: 'message' as const, value: clip(originalId, MAX_REF) }];

  return buildEnvelope(parsed, source, persona, identity, ctx, {
    // Forward wins over BCC: it is the more specific gesture, and a forwarded message that
    // also happens to be BCC'd is still "look at this message".
    kind: isForward ? 'email_forwarded' : 'email_bcc',
    payload: compact({
      gesture: isForward ? 'forward' : 'bcc',
      delivered_to: deliveredToSelf,
      bcc_inferred: isBcc,
      original,
      original_source: original === undefined ? 'none' : (original['kind'] as string),
    }),
    refs: extraRefs,
  });
}

/** Convenience for the gesture path: raw bytes with no mailbox behind them. */
export function envelopeFromRawDelivered(
  raw: Uint8Array,
  persona: string,
  identity: EmailIdentity,
  ctx: IngestOptions & { readonly mailbox?: string; readonly uid?: number },
): Envelope | undefined {
  return envelopeFromDelivered(
    { mailbox: ctx.mailbox ?? 'INBOX', uid: ctx.uid ?? 0, raw },
    persona,
    identity,
    ctx,
  );
}
