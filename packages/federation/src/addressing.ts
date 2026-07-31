import { canonicalBytes, verifyObject } from '@servanda/crypto';
import { InboxRecord } from '@servanda/types';

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
 */
export function hubsFor(record: InboxRecord, now: string): readonly string[] {
  const age = Date.parse(now) - Date.parse(record.issued_at);
  if (!Number.isFinite(age)) return [];
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
