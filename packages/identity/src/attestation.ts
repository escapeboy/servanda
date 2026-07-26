import { verifyObject } from '@servanda/crypto';
import { Attestation, Revocation } from '@servanda/types';

/**
 * §1.3 — org attestation and revocation.
 *
 * An attestation is an org's *claim* about a subject key, not a protocol truth (§9). This
 * module's only job is to decide whether the claim is one this verifier may stand behind at
 * a given moment; what a client does with the answer is §1.6's ladder and M-12's problem.
 */

export type AttestationRejection =
  /** Not a well-formed §1.3 attestation. */
  | 'malformed'
  /** `sig` does not verify against `org`. Includes "signed by some other key". */
  | 'signature-invalid'
  /** The attestation is about a different subject than the one being verified. */
  | 'subject-mismatch'
  /** The attestation is by a different org than the one being verified. */
  | 'org-mismatch'
  /** `issued_at` is in the future of the moment being evaluated. */
  | 'not-yet-issued'
  /** `expires_at` has passed at the moment being evaluated. */
  | 'expired'
  /** A valid revocation by the same org covers the signature being evaluated (§1.3). */
  | 'revoked';

export interface AttestationContext {
  /** Verification time. §1.5 requires anchors be checked *at verification time*; so is validity. */
  readonly now: Date;
  /**
   * §1.3 offboarding semantics: "edges signed after `revoked_at` are not org-attested; edges
   * signed before remain valid." This is the time of the signature under evaluation. Omitted
   * means "evaluate as of `now`" — i.e. the question is about the key, not a specific edge.
   */
  readonly signedAt?: Date | null;
  /** The subject key the caller is verifying. A mismatch is refused, never silently ignored. */
  readonly subject?: string;
  /** The org root the caller expects. A mismatch is refused. */
  readonly org?: string;
  /** Revocations the verifier holds. Only same-org, same-subject, validly signed ones count. */
  readonly revocations?: readonly unknown[];
}

export type AttestationVerdict =
  | {
      readonly ok: true;
      readonly attestation: Attestation;
      /** Set when a valid revocation exists but does not cover the signature being evaluated. */
      readonly revokedAt: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: AttestationRejection;
      readonly detail: string | null;
      /** Present when the object parsed but failed a later check — useful for downgrade copy. */
      readonly attestation: Attestation | null;
    };

function reject(
  reason: AttestationRejection,
  detail: string | null = null,
  attestation: Attestation | null = null,
): AttestationVerdict {
  return { ok: false, reason, detail, attestation };
}

/** A revocation is only honoured when it verifies against the org root it names. */
export function verifyRevocation(input: unknown): Revocation | null {
  const parsed = Revocation.safeParse(input);
  if (!parsed.success) return null;
  return verifyObject(parsed.data, parsed.data.org) ? parsed.data : null;
}

/**
 * The earliest valid revocation this org has issued for this subject.
 *
 * Earliest rather than latest: an org that revokes twice has said "not attested from T" twice,
 * and the earlier statement is the one that refuses more. §1.3 does not say which wins.
 */
export function earliestRevocation(
  revocations: readonly unknown[] | undefined,
  org: string,
  subject: string,
): Revocation | null {
  let best: Revocation | null = null;
  for (const raw of revocations ?? []) {
    const rev = verifyRevocation(raw);
    if (rev === null || rev.org !== org || rev.subject !== subject) continue;
    if (best === null || Date.parse(rev.revoked_at) < Date.parse(best.revoked_at)) best = rev;
  }
  return best;
}

/**
 * Verify an attestation, honouring §1.3 offboarding semantics.
 *
 * NARROWEST READING (§1.3 is silent on which clock validity is read against). An attestation
 * covers a signature only when it is valid at BOTH moments:
 *   - now              — §1.5's "at signature-verification time" applied to validity as well;
 *   - signedAt ?? now  — the moment the signature under evaluation was made.
 * An expired attestation therefore never confers a level, even for an edge signed while it
 * was live. That refuses more than the alternative reading, which is the rule for §1 gaps.
 *
 * Revocation is evaluated only against `signedAt ?? now`, because §1.3 states that rule
 * explicitly and states it in terms of the edge's signing time.
 */
export function verifyAttestation(input: unknown, ctx: AttestationContext): AttestationVerdict {
  const parsed = Attestation.safeParse(input);
  if (!parsed.success) return reject('malformed', parsed.error.issues[0]?.message ?? null);
  const att = parsed.data;

  if (ctx.subject !== undefined && att.subject !== ctx.subject) {
    return reject('subject-mismatch', `attests ${att.subject}`, att);
  }
  if (ctx.org !== undefined && att.org !== ctx.org) {
    return reject('org-mismatch', `signed by org ${att.org}`, att);
  }
  // The signature is checked against the org named *inside* the object. A forged attestation
  // signed by any other key — including the subject's own — fails here.
  if (!verifyObject(att, att.org)) {
    return reject('signature-invalid', `does not verify against org ${att.org}`, att);
  }

  const issued = Date.parse(att.issued_at);
  const expires = Date.parse(att.expires_at);
  const now = ctx.now.getTime();
  const at = (ctx.signedAt ?? ctx.now).getTime();

  for (const [t, label] of [
    [now, 'now'],
    [at, 'signing time'],
  ] as const) {
    if (t < issued) return reject('not-yet-issued', `issued_at is after ${label}`, att);
    // Half-open interval: an attestation is dead at the instant it expires.
    if (t >= expires) return reject('expired', `expires_at is at or before ${label}`, att);
  }

  const rev = earliestRevocation(ctx.revocations, att.org, att.subject);
  if (rev !== null) {
    // NARROWEST READING: §1.3 says "after `revoked_at`" is not attested and "before" remains
    // valid, leaving the exact instant undefined. The instant is treated as revoked.
    if (at >= Date.parse(rev.revoked_at)) {
      return reject('revoked', `revoked_at ${rev.revoked_at}`, att);
    }
    return { ok: true, attestation: att, revokedAt: rev.revoked_at };
  }

  return { ok: true, attestation: att, revokedAt: null };
}
