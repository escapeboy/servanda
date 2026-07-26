import { describe, expect, it } from 'vitest';
import { earliestRevocation, verifyAttestation, verifyRevocation } from '../src/index.js';
import {
  ATTACKER,
  DANA,
  MARIA,
  ORG,
  OTHER_ORG,
  T,
  at,
  attestation,
  revocation,
} from './support/fixture.js';

describe('§1.3 attestation verification', () => {
  it('accepts an attestation signed by the org it names', () => {
    const verdict = verifyAttestation(attestation(), { now: at(T.before), subject: MARIA.id });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.attestation.claims.display_name).toBe('Maria Ivanova');
  });

  it('rejects an attestation signed by anyone other than the org', () => {
    for (const forger of [ATTACKER, MARIA, OTHER_ORG]) {
      const verdict = verifyAttestation(attestation({ signWith: forger }), { now: at(T.before) });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('signature-invalid');
    }
  });

  it('rejects a tampered claim even though the signature is present', () => {
    const att = attestation();
    const tampered = { ...att, claims: { ...att.claims, display_name: 'Chief Executive' } };
    const verdict = verifyAttestation(tampered, { now: at(T.before) });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('signature-invalid');
  });

  it('refuses an attestation about a different subject', () => {
    const verdict = verifyAttestation(attestation({ subject: DANA.id }), {
      now: at(T.before),
      subject: MARIA.id,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('subject-mismatch');
  });

  it('refuses an attestation by a different org than the caller expects', () => {
    const verdict = verifyAttestation(attestation({ org: OTHER_ORG }), {
      now: at(T.before),
      org: ORG.id,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('org-mismatch');
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of [null, undefined, 42, {}, { type: 'attestation' }, '{"type":"attestation"}']) {
      const verdict = verifyAttestation(bad, { now: at(T.before) });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('malformed');
    }
  });

  describe('validity window', () => {
    it('rejects once expires_at has passed', () => {
      const verdict = verifyAttestation(attestation(), { now: at(T.afterExpiry) });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('expired');
    });

    it('treats the instant of expiry as expired (half-open interval)', () => {
      const verdict = verifyAttestation(attestation(), { now: at(T.expires) });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('expired');
    });

    it('rejects before issued_at', () => {
      const verdict = verifyAttestation(attestation(), { now: at('2025-12-31T00:00:00Z') });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('not-yet-issued');
    });

    it('refuses an expired attestation even for an edge signed while it was live', () => {
      // The narrowest reading, documented at the code site: validity is required at BOTH
      // `now` and `signedAt`. A verifier reading today does not resurrect a dead attestation.
      const verdict = verifyAttestation(attestation(), {
        now: at(T.afterExpiry),
        signedAt: at(T.before),
      });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('expired');
    });
  });

  describe('§1.3 offboarding semantics — the revocation boundary', () => {
    const revoked = [revocation()];

    it('an edge signed BEFORE revoked_at remains valid', () => {
      const verdict = verifyAttestation(attestation(), {
        now: at(T.after),
        signedAt: at(T.before),
        revocations: revoked,
      });
      expect(verdict.ok).toBe(true);
      // The revocation is still reported, so a client can say "this org has since offboarded".
      if (verdict.ok) expect(verdict.revokedAt).toBe(T.revoked);
    });

    it('an edge signed AFTER revoked_at is not org-attested', () => {
      const verdict = verifyAttestation(attestation(), {
        now: at(T.after),
        signedAt: at(T.after),
        revocations: revoked,
      });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('revoked');
    });

    it('an edge signed AT the exact instant of revoked_at is refused', () => {
      // §1.3 defines "after" and "before" and leaves the instant itself undefined. Refusing is
      // the narrower reading, and one second on either side is tested above and below.
      const verdict = verifyAttestation(attestation(), {
        now: at(T.after),
        signedAt: at(T.revoked),
        revocations: revoked,
      });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('revoked');
    });

    it('one second before the instant is still valid; one second after is not', () => {
      const ms = Date.parse(T.revoked);
      const justBefore = verifyAttestation(attestation(), {
        now: at(T.after),
        signedAt: new Date(ms - 1000),
        revocations: revoked,
      });
      const justAfter = verifyAttestation(attestation(), {
        now: at(T.after),
        signedAt: new Date(ms + 1000),
        revocations: revoked,
      });
      expect(justBefore.ok).toBe(true);
      expect(justAfter.ok).toBe(false);
    });

    it('with no signedAt, the question is about the key now — a past revocation refuses', () => {
      const verdict = verifyAttestation(attestation(), { now: at(T.after), revocations: revoked });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('revoked');
    });

    it('ignores a revocation that does not verify against the org it names', () => {
      const forged = revocation({ signWith: ATTACKER });
      expect(verifyRevocation(forged)).toBeNull();
      const verdict = verifyAttestation(attestation(), {
        now: at(T.after),
        signedAt: at(T.after),
        revocations: [forged],
      });
      expect(verdict.ok).toBe(true);
    });

    it('ignores a revocation by a different org, or for a different subject', () => {
      const verdict = verifyAttestation(attestation(), {
        now: at(T.after),
        signedAt: at(T.after),
        revocations: [revocation({ org: OTHER_ORG }), revocation({ subject: DANA.id })],
      });
      expect(verdict.ok).toBe(true);
    });

    it('honours the earliest of several revocations', () => {
      const early = revocation({ revoked_at: '2026-02-01T00:00:00Z' });
      const late = revocation({ revoked_at: '2026-11-01T00:00:00Z' });
      const picked = earliestRevocation([late, early], ORG.id, MARIA.id);
      expect(picked?.revoked_at).toBe('2026-02-01T00:00:00Z');
    });
  });

  it('grades a group subject the same way a persona is graded (§1.4)', () => {
    const verdict = verifyAttestation(
      attestation({ subject_kind: 'group', members: [MARIA.id, DANA.id], display_name: 'Ops' }),
      { now: at(T.before) },
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.attestation.subject_kind).toBe('group');
  });
});
