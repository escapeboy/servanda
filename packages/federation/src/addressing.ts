import { canonicalBytes, verifyObject } from '@servanda/crypto';
import type { WireMessage } from '@servanda/types';
import { InboxRecord } from '@servanda/types';
import type { Transport } from './transport.js';

/**
 * §6.7 addressing — where a persona says its mail should go, and who is allowed to say it.
 *
 * The whole of M-17 is one sentence: only the persona key may alter its own inbox record. It
 * sounds procedural and it is not. A hub that could sign a record naming someone else's persona
 * could rewrite that persona's `hubs` to a hub it controls, and every sender in the network would
 * route there — correctly, per the protocol. The signature check is what makes "a hub cannot move
 * its users" true rather than merely intended.
 *
 * Note what is NOT needed to check it: no registry, no directory, no hub cooperation. §1.2 makes
 * `persona_id` the public key itself, so a record carries its own verification key and any node
 * that has the bytes can decide.
 */

/** §6.7: an inbox record is valid for 30 days from `issued_at`. */
export const INBOX_RECORD_LIFETIME_DAYS = 30;
/** §6.7: republish at half-life, so a refreshed record circulates before the old one expires. */
export const INBOX_RECORD_REPUBLISH_DAYS = 15;

export type InboxRejectionReason =
  /**
   * M-17. Distinct from `invalid-signature` on purpose: this is a well-formed signature by the
   * WRONG KEY, which is an attempt to move somebody's mail, while a bad signature is usually a
   * mangled byte. An implementation that collapsed the two would report a hijack as corruption.
   */
  | 'signer-is-not-the-persona'
  | 'invalid-signature'
  | 'malformed-record';

export interface InboxVerification {
  accepted: boolean;
  rejection_reason: InboxRejectionReason | null;
  /**
   * Which known key actually signed a record rejected as `signer-is-not-the-persona`, when the
   * caller supplied a set of candidates. It is a diagnostic and nothing more: a verifier with no
   * candidates still rejects the record, and MUST NOT accept it because it cannot name the
   * signer.
   */
  actual_signer: string | null;
}

/**
 * Verify an inbox record against the persona it names.
 *
 * `knownKeys` exists only so a rejection can say WHO signed instead of "somebody". Nothing about
 * acceptance depends on it.
 */
export function verifyInboxRecord(
  candidate: unknown,
  knownKeys: readonly { label: string; persona_id: string }[] = [],
): InboxVerification {
  const parsed = InboxRecord.safeParse(candidate);
  if (!parsed.success) {
    return { accepted: false, rejection_reason: 'malformed-record', actual_signer: null };
  }
  const record = parsed.data as unknown as Record<string, unknown>;

  if (verifyObject(record, parsed.data.persona)) {
    return { accepted: true, rejection_reason: null, actual_signer: null };
  }

  // It did not verify against the persona. Whether some OTHER key signed it decides which of the
  // two failures this is — and that distinction is the point of M-17.
  for (const key of knownKeys) {
    if (key.persona_id === parsed.data.persona) continue;
    if (verifyObject(record, key.persona_id)) {
      return { accepted: false, rejection_reason: 'signer-is-not-the-persona', actual_signer: key.label };
    }
  }
  return { accepted: false, rejection_reason: 'invalid-signature', actual_signer: null };
}

/**
 * The hubs a sender may use, in the order it must try them.
 *
 * Two §6.7 rules are enforced here because this is the only place they can be. The list is
 * returned as the persona wrote it — a sender "MUST NOT reorder the list by its own measurements
 * (latency, past success, operator preference)", since the order is the persona's own statement
 * about where it wants its mail. And an expired record routes nowhere: a record older than 30
 * days names hubs the persona may no longer use, and honouring it would deliver to an address
 * its owner has abandoned.
 *
 * `now` is a parameter rather than a clock read, for the same reason it is everywhere else here:
 * "this record expired" has to be reproducible.
 *
 * "Valid for 30 days FROM `issued_at`" bounds the window at both ends. Only the far end was
 * enforced, so a record dated in the future had an age below the limit at every instant, routed
 * for ever, and never reached the republish half-life — which turns a 30-day statement about
 * where a persona wants its mail, and which X25519 key may be sealed to, into a permanent one.
 * That is the bound that limits how long a single compromise of a persona key keeps steering
 * that persona's mail, so a record that has not started is refused exactly like one that ended.
 * Zero tolerance for skew matches `verifyAttestation`'s `not-yet-issued`.
 */
export function hubsFor(record: InboxRecord, now: string): readonly string[] {
  const age = Date.parse(now) - Date.parse(record.issued_at);
  if (!Number.isFinite(age) || age < 0) return [];
  return age > INBOX_RECORD_LIFETIME_DAYS * 86_400_000 ? [] : record.hubs;
}

/** True once a persona SHOULD republish — half-life, not expiry. */
export function shouldRepublish(record: InboxRecord, now: string): boolean {
  const age = Date.parse(now) - Date.parse(record.issued_at);
  return Number.isFinite(age) && age >= INBOX_RECORD_REPUBLISH_DAYS * 86_400_000;
}

/**
 * The canonical form a record's signature covers — the record minus its own `sig`. Exposed so a
 * test can pin it against the oracle's `canonical` string rather than trusting that two
 * implementations happened to serialize the same way.
 */
export function inboxRecordCanonical(record: InboxRecord): string {
  const { sig: _sig, ...rest } = record;
  return new TextDecoder().decode(canonicalBytes(rest));
}

/**
 * The X25519 key a sender may seal to, or null.
 *
 * This is the join between M-17 and §6.3, and it is one function on purpose. A DH key is only
 * usable if the record carrying it verifies against the persona it names — otherwise a hub that
 * could publish a record could also publish a key it holds the private half of, and read
 * everything addressed to that persona. That is the same attack M-17 exists to stop, one layer
 * along: not moving someone's mail, but reading it.
 *
 * An expired record yields nothing either. Expiry governs where a persona wants its mail; a key
 * from a record its owner has let lapse is no better an answer than a hub they have left.
 */
export function dhKeyFrom(record: unknown, now: string): string | null {
  const verdict = verifyInboxRecord(record);
  if (!verdict.accepted) return null;
  const parsed = InboxRecord.parse(record);
  if (hubsFor(parsed, now).length === 0) return null;
  return parsed.dh_key ?? null;
}

export interface DeliveryAttempt {
  hub: string;
  error: string;
}

export interface DeliveryOutcome {
  /** The hub that accepted it, or null — see below on why that is not an error. */
  delivered: string | null;
  attempts: DeliveryAttempt[];
  /** Set when nothing was attempted at all: an unverified or expired record routes nowhere. */
  refused: InboxRejectionReason | 'record-expired' | null;
}

/**
 * §6.7 store-and-forward: deliver to the persona's declared hubs, in the order they declared.
 *
 * **A failure here is not an error, and that is the design.** §6.7: "Delivery is optimization;
 * reconciliation is the guarantee. Loss of any queued message is healed by the next §6.4 recon
 * exchange between the parties." So this returns an outcome rather than throwing: a caller that
 * had to catch an exception would be pushed toward treating delivery as a durability claim, and
 * a hub is not durable — it queues with a TTL and may drop.
 *
 * Three §6.7 MUSTs live in the ordering:
 *
 *  - hubs are tried in the DECLARED order, never reordered by latency or past success. The order
 *    is the persona's own statement about where it wants its mail.
 *  - an expired record routes nowhere. Honouring it would deliver to an address its owner has
 *    abandoned.
 *  - an unverified record routes nowhere either — M-17. Routing on a record this node has not
 *    checked is exactly the hub-moves-its-users attack, one layer up.
 */
export async function deliverViaInbox(opts: {
  record: unknown;
  now: string;
  recipient: string;
  message: WireMessage;
  /** A sender bound to one hub URL. Injected, so nothing here decides how to reach a network. */
  clientFor: (baseUrl: string) => Pick<Transport, 'send'>;
}): Promise<DeliveryOutcome> {
  const verdict = verifyInboxRecord(opts.record);
  if (!verdict.accepted) {
    return { delivered: null, attempts: [], refused: verdict.rejection_reason };
  }
  const record = InboxRecord.parse(opts.record);

  const hubs = hubsFor(record, opts.now);
  if (hubs.length === 0) {
    return { delivered: null, attempts: [], refused: 'record-expired' };
  }

  const attempts: DeliveryAttempt[] = [];
  for (const hub of hubs) {
    try {
      await opts.clientFor(hub).send(opts.recipient, opts.message);
      return { delivered: hub, attempts, refused: null };
    } catch (error) {
      attempts.push({ hub, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { delivered: null, attempts, refused: null };
}
