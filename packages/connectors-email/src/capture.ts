import { Rfc3339 } from '@servanda/types';
import type { Envelope } from '@servanda/types';
import {
  FROM_VERIFICATION,
  MAX_REF,
  clip,
  compact,
  label,
  sealEnvelope,
} from './envelope.js';
import type { ImapMessageSource } from './imap.js';
import { DEFAULT_LIMITS, parseMessage } from './mime.js';
import type { MailAddress, MimeLimits, ParsedMessage } from './mime.js';

/**
 * IMAP capture → §2 envelopes.
 *
 * `source` is always `imap` and `kind` is always drawn from a closed set in this package —
 * both are decided here and never read out of the message. That is the mechanical form of
 * M-6 at this boundary: whatever a message says, it can only end up as a string under
 * `payload`, `refs`, or `actor.label`.
 */

export const EMAIL_SOURCE = 'imap' as const;
export const CAPTURE_KINDS = ['email_in', 'email_out'] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

/** How the connector concluded a message was outbound. Recorded so nothing has to guess. */
export const DIRECTION_BASES = ['mailbox', 'from_header', 'default'] as const;
export type DirectionBasis = (typeof DIRECTION_BASES)[number];

export interface EmailIdentity {
  /**
   * The node's own mail addresses, lowercased. Bound at construction alongside the persona:
   * "which mailbox am I" is registration data, not something a message may assert.
   */
  readonly addresses: readonly string[];
  /** Mailboxes whose contents are, by definition, messages this node sent. */
  readonly sentMailboxes: readonly string[];
}

export interface CaptureContext {
  /** §2 `received_at` — injected, so the envelope path holds no clock. */
  readonly receivedAt: string;
  readonly limits?: MimeLimits;
}

export function normalizeIdentity(identity: {
  readonly addresses?: readonly string[];
  readonly sentMailboxes?: readonly string[];
}): EmailIdentity {
  return {
    addresses: [...new Set((identity.addresses ?? []).map((a) => a.trim().toLowerCase()))]
      .filter((a) => a.length > 0)
      .sort(),
    sentMailboxes: [...new Set(identity.sentMailboxes ?? ['Sent', 'Sent Items', 'Sent Mail'])].sort(),
  };
}

/**
 * Non-ASCII in an address is the observable shape of a homoglyph domain (§9.5). It is
 * FLAGGED, never "fixed": normalizing `раypal.com` towards `paypal.com` would be the connector
 * asserting an identity, which is precisely what M-12 forbids it from doing.
 */
export function hasNonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return true;
  }
  return false;
}

export function addressOf(list: readonly MailAddress[]): string | undefined {
  for (const a of list) {
    if (a.address !== undefined) return a.address;
  }
  return undefined;
}

/** Recipient addresses as plain strings, bounded. Display names stay out of this list. */
export function addressesOf(list: readonly MailAddress[], max = 32): string[] {
  const out: string[] = [];
  for (const a of list) {
    if (a.address === undefined || out.includes(a.address)) continue;
    out.push(clip(a.address, 320));
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Thread identity — load-bearing for scenario 3: the root of the reference chain, so a reply
 * and the message it answers land on the same value and a later commitment can cite either.
 *
 * `References` is ordered oldest-first (RFC 5322 §3.6.4), so its first entry is the root.
 * Defensive fallbacks: `In-Reply-To`, then the message's own id, then nothing. A message that
 * declares no ids at all has no thread and gets no thread id rather than a made-up one.
 */
export function threadIdOf(parsed: ParsedMessage): string | undefined {
  return parsed.references[0] ?? parsed.inReplyTo ?? parsed.messageId;
}

export function threadRefs(parsed: ParsedMessage): { kind: 'message'; value: string }[] {
  const refs: { kind: 'message'; value: string }[] = [];
  const push = (value: string | undefined): void => {
    if (value === undefined || value.length === 0) return;
    const clipped = clip(value, MAX_REF);
    if (!refs.some((r) => r.value === clipped)) refs.push({ kind: 'message', value: clipped });
  };
  push(parsed.messageId);
  push(parsed.inReplyTo);
  for (const ref of parsed.references) push(ref);
  return refs;
}

export function directionOf(
  parsed: ParsedMessage,
  mailbox: string,
  identity: EmailIdentity,
): { kind: CaptureKind; basis: DirectionBasis } {
  // Mailbox first. Which mailbox a message was fetched from is server state; a `From` header
  // is message content and is trivially forged, so it is consulted only when the mailbox says
  // nothing. `direction_basis` travels with the envelope so a later stage can weigh it.
  if (identity.sentMailboxes.includes(mailbox)) return { kind: 'email_out', basis: 'mailbox' };
  const from = addressOf(parsed.from)?.toLowerCase();
  if (from !== undefined && identity.addresses.includes(from)) {
    return { kind: 'email_out', basis: 'from_header' };
  }
  return { kind: 'email_in', basis: 'default' };
}

export interface CaptureExtras {
  /** Extra payload fields (archaeology, forwards). Merged after the base fields. */
  readonly payload?: Record<string, unknown>;
  readonly kind?: string;
  readonly refs?: readonly { kind: 'url' | 'commit' | 'issue' | 'message' | 'file'; value: string }[];
}

/**
 * The one place an envelope is built in this package. Everything else feeds it.
 *
 * Returns `undefined` — never throws — when there is no defensible `occurred_at`. §2 requires
 * one, and inventing it from the wall clock would both break determinism and lie about when
 * the promise was made.
 */
export function buildEnvelope(
  parsed: ParsedMessage,
  source: ImapMessageSource,
  persona: string,
  identity: EmailIdentity,
  ctx: CaptureContext,
  extras: CaptureExtras = {},
): Envelope | undefined {
  // Precedence: the message's own `Date`, then the server's INTERNALDATE.
  //
  // NARROWEST READING (listed in the stream report): the brief says `occurred_at` comes from
  // the message's own `Date`. INTERNALDATE is used ONLY when that header is absent or
  // unparseable, because it is then the sole remaining observation of when the message
  // existed — and it comes from the server, not from the message, so it is neither
  // attacker-authored nor a clock read on the envelope path. A message with neither yields no
  // envelope at all.
  const occurredAt =
    parsed.date ??
    (source.internalDate !== undefined && Rfc3339.safeParse(source.internalDate).success
      ? source.internalDate
      : undefined);
  if (occurredAt === undefined) return undefined;

  const direction = directionOf(parsed, source.mailbox, identity);
  const fromAddress = addressOf(parsed.from);
  const fromName = parsed.from[0]?.name;
  const threadId = threadIdOf(parsed);

  return sealEnvelope({
    v: 'servanda/0.1',
    type: 'envelope',
    source: EMAIL_SOURCE,
    kind: extras.kind ?? direction.kind,
    occurred_at: occurredAt,
    received_at: ctx.receivedAt,
    // M-12: the label is what a client may show; `external_id` is the ADDRESS, never the
    // display name, so the two can never be conflated downstream.
    actor: compact({
      label: label(fromName ?? fromAddress ?? 'unknown'),
      external_id: fromAddress === undefined ? undefined : clip(fromAddress, 320),
    }),
    payload: compact({
      mailbox: clip(source.mailbox, 256),
      uid: source.uid,
      direction: direction.kind,
      direction_basis: direction.basis,

      message_id: parsed.messageId,
      thread_id: threadId,
      in_reply_to: parsed.inReplyTo,
      references_count: parsed.references.length,
      is_reply: parsed.inReplyTo !== undefined || parsed.references.length > 0,

      subject: parsed.subject,
      text: parsed.text,
      // How long the body was BEFORE the MIME parser cut it — a different question from §2's
      // `text_length`, which the envelope boundary writes and which counts octets of the value
      // that reached it. Both can be present; neither substitutes for the other.
      text_source_chars: parsed.textLength,
      html: parsed.html,
      raw_bytes: parsed.rawBytes,
      truncated: parsed.truncated,

      // Display name and address are SEPARATE fields. A display name reading
      // "billing@acme.com" must never be readable as an address (M-12).
      from_display_name: fromName === undefined ? undefined : clip(fromName, 320),
      from_address: fromAddress === undefined ? undefined : clip(fromAddress, 320),
      from_verification: FROM_VERIFICATION,
      from_address_non_ascii: fromAddress === undefined ? undefined : hasNonAscii(fromAddress),

      to: addressesOf(parsed.to),
      to_count: parsed.to.length,
      cc: addressesOf(parsed.cc),
      cc_count: parsed.cc.length,
      reply_to: addressesOf(parsed.replyTo, 4),

      attachment_count: parsed.attachments.length,
      attachments: parsed.attachments,
      flags: source.flags === undefined ? undefined : [...source.flags].sort(),
      header_anomalies: parsed.anomalies,
      // Observed and NOT interpreted: this connector cannot authenticate its own mail server's
      // headers, so it reports what it saw and claims nothing (M-12).
      observed_auth_results: parsed.observedAuthResults,

      ...(extras.payload ?? {}),
    }),
    refs: [...threadRefs(parsed), ...(extras.refs ?? [])].slice(0, 40),
    persona,
  });
}

export function envelopeFromMessage(
  source: ImapMessageSource,
  persona: string,
  identity: EmailIdentity,
  ctx: CaptureContext,
): Envelope | undefined {
  const parsed = parseMessage(source.raw, ctx.limits ?? DEFAULT_LIMITS);
  return buildEnvelope(parsed, source, persona, identity, ctx);
}
