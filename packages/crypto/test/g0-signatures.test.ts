import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/jcs.js';
import { signObject, signingPreimageHex, unsigned, verifyObject, withSignature } from '../src/sign.js';
import { derivePersona } from '../src/slip10.js';
import { mnemonicToSeed } from '../src/mnemonic.js';
import {
  loadVectors,
  type DerivationVectors,
  type SignatureCase,
  type VectorFile,
} from './vectors.js';

/**
 * G0 — Ed25519 over sha256(JCS(object minus "sig")).
 */
const vectors = loadVectors<VectorFile<SignatureCase> & { signing_rule: string }>(
  'signatures/signatures.json',
);
const derivation = loadVectors<DerivationVectors>('derivation/persona-keys.json');

/** Resolve a signer's private key from the derivation vectors by public key. */
function privateKeyFor(personaId: string): string {
  const persona = derivation.personas.find((p) => p.persona_id === personaId);
  if (persona) return persona.private_key;
  const org = derivation.org_root as { personas?: DerivationVectors['personas']; public_key?: string; private_key?: string };
  if (org.personas) {
    const match = org.personas.find((p) => p.persona_id === personaId);
    if (match) return match.private_key;
  }
  if (org.public_key === personaId && org.private_key) return org.private_key;
  throw new Error(`no private key in derivation vectors for signer ${personaId}`);
}

describe('G0 signatures (§00 Conventions, §4.2)', () => {
  it('targets the signing rule the vectors state, and a family that can fail', () => {
    expect(vectors.signing_rule).toBe('ed25519_sign(sha256(JCS(object minus "sig")), private_key)');
    // Not a count. The family carried five positives and NO verdict until v0.2, which a
    // `return true` verifier passed in full — over the primitive M-2, M-14 and §6.2 all reduce
    // to. Pinning the number would have re-frozen that; what matters is that both kinds exist.
    expect(vectors.cases.some((c: { verifies: boolean }) => c.verifies)).toBe(true);
    expect(vectors.cases.some((c: { verifies: boolean }) => !c.verifies)).toBe(true);
  });

  for (const c of vectors.cases) {
    describe(c.name, () => {
      it(`canonical form and preimage: ${c.description}`, () => {
        expect(canonicalize(c.unsigned_object)).toBe(c.canonical);
        expect(signingPreimageHex(c.unsigned_object)).toBe(c.sha256_preimage);
      });

      it(`reaches the verdict the vector pins (verifies=${c.verifies})`, () => {
        expect(verifyObject(c.signed_object, c.signer.persona_id)).toBe(c.verifies);
        // A refusal names a reason; an acceptance names none. "Rejected everything" and
        // "rejected the right thing" are different implementations and only one conforms.
        expect(c.reason === null).toBe(c.verifies);
      });

      if (c.verifies) {
        it('signing reproduces the vector signature byte for byte (Ed25519 is deterministic)', () => {
          expect(signObject(c.unsigned_object, privateKeyFor(c.signer.persona_id))).toBe(c.signature);
        });
      }

      it('the sig field is excluded from its own preimage', () => {
        expect(signingPreimageHex(c.signed_object)).toBe(c.sha256_preimage);
        expect(unsigned(c.signed_object)).toEqual(c.unsigned_object);
      });

      it.skipIf(!c.verifies)('rejects a tampered object', () => {
        const tampered = { ...c.signed_object, asserted_at: '2099-01-01T00:00:00Z', issued_at: '2099-01-01T00:00:00Z' };
        expect(verifyObject(tampered, c.signer.persona_id)).toBe(false);
      });

      it.skipIf(!c.verifies)('rejects verification against a different persona key', () => {
        const other = derivation.personas.find((p) => p.persona_id !== c.signer.persona_id);
        expect(verifyObject(c.signed_object, other!.persona_id)).toBe(false);
      });
    });
  }

  it('round-trips a freshly derived persona', () => {
    const seed = mnemonicToSeed(derivation.mnemonic, derivation.passphrase);
    const persona = derivePersona(seed, 3);
    const obj = { v: 'servanda/0.2', type: 'assertion', state: 'proposed', by: persona.personaId };
    const signed = withSignature(obj, persona.privateKey);
    expect(verifyObject(signed, persona.personaId)).toBe(true);
  });

  it('returns false rather than throwing on a malformed sig', () => {
    expect(verifyObject({ a: 1, sig: 'not-hex' }, derivation.personas[0]!.persona_id)).toBe(false);
    expect(verifyObject({ a: 1 }, derivation.personas[0]!.persona_id)).toBe(false);
  });
});
