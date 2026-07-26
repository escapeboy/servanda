import { describe, expect, it } from 'vitest';
import { signObject } from '@servanda/crypto';
import {
  LinkNotUserInitiated,
  USER_INITIATED,
  linkCore,
  signPersonaLink,
  verifyPersonaLink,
} from '../src/index.js';
import * as identity from '../src/index.js';
import { ATTACKER, DANA, MARIA } from './support/fixture.js';

describe('§1.6 persona linking', () => {
  const link = signPersonaLink({
    privateKeyA: MARIA.privateKey,
    privateKeyB: DANA.privateKey,
    intent: USER_INITIATED,
  });

  it('a link both personas signed verifies', () => {
    const verdict = verifyPersonaLink(link);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.personas).toEqual([MARIA.id, DANA.id]);
  });

  it('carries no root key and no seed material — §1.1 unlinkability is preserved', () => {
    const serialized = JSON.stringify(link);
    for (const secret of [MARIA.privateKey, DANA.privateKey, ATTACKER.privateKey]) {
      expect(serialized).not.toContain(secret);
    }
    expect(Object.keys(link).sort()).toEqual(['personas', 'sig_A', 'sig_B', 'type', 'v']);
  });

  describe('forgeries', () => {
    it('rejects a link where only one persona signed (the other slot is A’s signature)', () => {
      const verdict = verifyPersonaLink({ ...link, sig_B: link.sig_A });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('duplicate-signature');
    });

    it('rejects a link where one persona signed both slots with distinct signatures', () => {
      // A signs the core; A also produces a *different* valid-looking signature for slot B by
      // signing a variant. Slot B must verify against B's key, and it cannot.
      const core = linkCore([MARIA.id, DANA.id]);
      const verdict = verifyPersonaLink({
        ...core,
        personas: [MARIA.id, DANA.id],
        sig_A: signObject(core, MARIA.privateKey),
        sig_B: signObject({ ...core, personas: [DANA.id, MARIA.id] }, MARIA.privateKey),
      });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('sig-b-invalid');
    });

    it('rejects swapped signatures — position is part of the claim', () => {
      const verdict = verifyPersonaLink({ ...link, sig_A: link.sig_B, sig_B: link.sig_A });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('sig-a-invalid');
    });

    it('rejects a link whose personas were substituted after signing', () => {
      // Substituting either name changes the bytes both personas signed, so both signatures
      // fall; the first check to run reports it.
      const verdict = verifyPersonaLink({ ...link, personas: [MARIA.id, ATTACKER.id] });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('sig-a-invalid');
    });

    it('rejects a self-link', () => {
      const verdict = verifyPersonaLink({ ...link, personas: [MARIA.id, MARIA.id] });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('self-link');
    });

    it('rejects malformed input without throwing', () => {
      for (const bad of [null, {}, { type: 'link' }, { ...link, sig_A: 'short' }]) {
        expect(verifyPersonaLink(bad).ok).toBe(false);
      }
    });
  });

  describe('explicitly user-initiated only', () => {
    it('signPersonaLink refuses without the intent token', () => {
      expect(() =>
        signPersonaLink({
          privateKeyA: MARIA.privateKey,
          privateKeyB: DANA.privateKey,
          intent: 'because it seemed useful' as never,
        }),
      ).toThrow(LinkNotUserInitiated);
    });

    it('signPersonaLink is the only export that can emit a link', () => {
      const emitters = Object.entries(identity).filter(([name, value]) => {
        if (typeof value !== 'function') return false;
        if (!/^[a-z]/.test(name)) return false; // classes, incl. the error type, are not emitters
        return /link/i.test(name) && !/^verify/.test(name);
      });
      expect(emitters.map(([name]) => name).sort()).toEqual(['linkCore', 'signPersonaLink']);
      // linkCore builds the unsigned preimage only — it cannot produce a signature.
      expect(Object.keys(linkCore([MARIA.id, DANA.id]))).not.toContain('sig_A');
    });

    it('nothing in the package derives or infers a link from other evidence', () => {
      const suspicious = Object.keys(identity).filter((name) =>
        /^(auto|derive|infer|suggest)/i.test(name),
      );
      expect(suspicious).toEqual([]);
    });
  });
});
