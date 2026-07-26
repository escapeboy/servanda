import { describe, expect, it } from 'vitest';
import { signObject, withSignature } from '@servanda/crypto';
import { PROTOCOL_VERSION, Rotation } from '@servanda/types';
import {
  MAX_ROTATION_DEPTH,
  isSuccessorOf,
  resolveSuccessor,
  rotationCore,
  signRotation,
  verifyRotation,
} from '../src/index.js';
import { ATTACKER, DANA, FRESH, MARIA, ORG } from './support/fixture.js';

const ROTATED_AT = '2026-05-01T00:00:00Z';

function core(oldKey: string, newKey: string, rotatedAt = ROTATED_AT) {
  return {
    v: PROTOCOL_VERSION,
    type: 'rotation' as const,
    old: oldKey,
    new: newKey,
    rotated_at: rotatedAt,
  };
}

describe('§1.7 rotation', () => {
  it('emits and verifies the single-`sig` encoding signed by the old key', () => {
    const r = signRotation({
      oldPrivateKey: MARIA.privateKey,
      newPublicKey: FRESH.id,
      rotatedAt: ROTATED_AT,
    });
    expect(r.old).toBe(MARIA.id);
    expect(r.new).toBe(FRESH.id);
    expect(Object.keys(r)).not.toContain('sig_old');

    const verdict = verifyRotation(r);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.encoding).toBe('sig');
  });

  describe('the attacks this object exists to stop', () => {
    it('a rotation nobody signed does not parse', () => {
      const verdict = verifyRotation(core(MARIA.id, ATTACKER.id));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('malformed');
    });

    it('a rotation signed only by the NEW key never transfers continuity', () => {
      // The takeover: an attacker publishes "Maria's key is now mine", signed by their own key.
      const forged = withSignature(core(MARIA.id, ATTACKER.id), ATTACKER.privateKey);
      const verdict = verifyRotation(forged);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('not-signed-by-old-key');
      expect(resolveSuccessor(MARIA.id, [forged]).current).toBe(MARIA.id);
    });

    it('a rotation carrying only §1.7 `sig_new` does not parse (no old-key signature)', () => {
      const verdict = verifyRotation({
        ...core(MARIA.id, ATTACKER.id),
        sig_new: signObject(core(MARIA.id, ATTACKER.id), ATTACKER.privateKey),
      });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('malformed');
    });

    it('a rotation with a signature by an unrelated third party is rejected', () => {
      const forged = withSignature(core(MARIA.id, FRESH.id), ORG.privateKey);
      const verdict = verifyRotation(forged);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('not-signed-by-old-key');
    });

    it('a signature lifted from another rotation does not transfer to this one', () => {
      const genuine = signRotation({
        oldPrivateKey: MARIA.privateKey,
        newPublicKey: FRESH.id,
        rotatedAt: ROTATED_AT,
      });
      const replayed = { ...genuine, new: ATTACKER.id };
      const verdict = verifyRotation(replayed);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('not-signed-by-old-key');
    });

    it('a rotation whose rotated_at was altered is rejected', () => {
      const genuine = signRotation({
        oldPrivateKey: MARIA.privateKey,
        newPublicKey: FRESH.id,
        rotatedAt: ROTATED_AT,
      });
      const verdict = verifyRotation({ ...genuine, rotated_at: '2026-05-02T00:00:00Z' });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('not-signed-by-old-key');
    });

    it('old === new is refused: a self-rotation is a free replay, not a rotation', () => {
      const r = withSignature(core(MARIA.id, MARIA.id), MARIA.privateKey);
      const verdict = verifyRotation(r);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('self-rotation');
    });

    it('a malformed sig is rejected without throwing', () => {
      const genuine = signRotation({
        oldPrivateKey: MARIA.privateKey,
        newPublicKey: FRESH.id,
        rotatedAt: ROTATED_AT,
      });
      expect(verifyRotation({ ...genuine, sig: 'zz'.repeat(64) }).ok).toBe(false);
      expect(verifyRotation({ ...genuine, sig: '00'.repeat(64) }).ok).toBe(false);
    });
  });

  describe('the §1.7 `sig_old` encoding (protocol issue #17)', () => {
    const legacy = {
      ...core(MARIA.id, FRESH.id),
      sig_old: signObject(core(MARIA.id, FRESH.id), MARIA.privateKey),
    };

    it('does not verify by default — the spec defines no preimage for it', () => {
      const verdict = verifyRotation(legacy);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('legacy-sig-old-encoding-unverifiable');
      expect(resolveSuccessor(MARIA.id, [legacy]).current).toBe(MARIA.id);
    });

    it('verifies only when the caller opts in to the documented interpretation', () => {
      const verdict = verifyRotation(legacy, { acceptLegacySigOld: true });
      expect(verdict.ok).toBe(true);
      if (verdict.ok) expect(verdict.encoding).toBe('sig_old');
    });

    it('the opt-in still refuses a sig_old that is not by the old key', () => {
      const forged = {
        ...core(MARIA.id, ATTACKER.id),
        sig_old: signObject(core(MARIA.id, ATTACKER.id), ATTACKER.privateKey),
      };
      const verdict = verifyRotation(forged, { acceptLegacySigOld: true });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('not-signed-by-old-key');
    });

    it('rotationCore drops every signature field', () => {
      const withBoth = Rotation.parse({ ...legacy, sig_new: 'ab'.repeat(64) });
      expect(rotationCore(withBoth)).toEqual(core(MARIA.id, FRESH.id));
    });
  });

  describe('successor resolution — §1.7 "treat `new` as the successor for all open edges"', () => {
    const r1 = signRotation({
      oldPrivateKey: MARIA.privateKey,
      newPublicKey: FRESH.id,
      rotatedAt: ROTATED_AT,
    });
    const r2 = signRotation({
      oldPrivateKey: FRESH.privateKey,
      newPublicKey: DANA.id,
      rotatedAt: '2026-06-01T00:00:00Z',
    });

    it('follows a verified chain to its end', () => {
      const res = resolveSuccessor(MARIA.id, [r2, r1]);
      expect(res.current).toBe(DANA.id);
      expect(res.chain).toHaveLength(2);
      expect(res.stoppedBecause).toBe('end');
      expect(isSuccessorOf(DANA.id, MARIA.id, [r1, r2])).toBe(true);
    });

    it('a key with no rotations is its own successor', () => {
      const res = resolveSuccessor(ORG.id, [r1, r2]);
      expect(res.current).toBe(ORG.id);
      expect(res.chain).toHaveLength(0);
    });

    it('an unverified rotation in the set is surfaced but never applied', () => {
      const forged = withSignature(core(MARIA.id, ATTACKER.id), ATTACKER.privateKey);
      const res = resolveSuccessor(MARIA.id, [forged, r1]);
      expect(res.current).toBe(FRESH.id);
      expect(res.rejected).toHaveLength(1);
      expect(res.rejected[0]?.reason).toBe('not-signed-by-old-key');
    });

    it('a fork stops resolution rather than picking a successor', () => {
      // Both are genuinely signed by Maria's old key. §1.7 gives no tie-break, so a verifier
      // that picked one would let anyone who ever held the key re-point the identity later.
      const fork = signRotation({
        oldPrivateKey: MARIA.privateKey,
        newPublicKey: ATTACKER.id,
        rotatedAt: '2026-07-01T00:00:00Z',
      });
      const res = resolveSuccessor(MARIA.id, [r1, fork]);
      expect(res.stoppedBecause).toBe('fork');
      expect(res.current).toBe(MARIA.id);
      expect(isSuccessorOf(FRESH.id, MARIA.id, [r1, fork])).toBe(false);
      expect(isSuccessorOf(ATTACKER.id, MARIA.id, [r1, fork])).toBe(false);
    });

    it('a cycle terminates', () => {
      const back = signRotation({
        oldPrivateKey: FRESH.privateKey,
        newPublicKey: MARIA.id,
        rotatedAt: '2026-08-01T00:00:00Z',
      });
      const res = resolveSuccessor(MARIA.id, [r1, back]);
      expect(res.stoppedBecause).toBe('cycle');
      expect(res.current).toBe(FRESH.id);
    });

    it('MAX_ROTATION_DEPTH bounds the walk', () => {
      expect(MAX_ROTATION_DEPTH).toBeGreaterThan(0);
      expect(MAX_ROTATION_DEPTH).toBeLessThanOrEqual(64);
    });
  });
});
