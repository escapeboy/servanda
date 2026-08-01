import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519';
import { _internals, openBase, sealBase } from '../src/hpke.js';
import { fromHex, toHex } from '../src/hash.js';

/**
 * RFC 9180 Appendix A.2 — DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305, Base mode.
 *
 * This is the point of migrating to HPKE, and it is worth saying plainly: these numbers were
 * written by people who have never seen this protocol. The construction §6.3 used to specify was
 * assembled here, so its correctness was whatever this implementation happened to do — there was
 * no outside answer to check against, and `docs/crypto-review-packet.md` had to record that the
 * one question that mattered could not be settled by reading.
 *
 * Every intermediate the RFC pins is checked, not just the ciphertext. A wrong key schedule that
 * happens to round-trip with itself would pass an end-to-end test and fail here.
 */
const V = {
  info: '4f6465206f6e2061204772656369616e2055726e',
  skEm: 'f4ec9b33b792c372c1d2c2063507b684ef925b8c75a42dbcbf57d63ccd381600',
  pkEm: '1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a',
  skRm: '8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb',
  pkRm: '4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a',
  enc: '1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a',
  shared_secret: '0bbe78490412b4bbea4812666f7916932b828bba79942424abb65244930d69a7',
  key: 'ad2744de8e17f4ebba575b3f5f5a8fa1f69c2a07f6e7500bc60ca6e3e3ec1c91',
  base_nonce: '5c4d98150661b848853b547f',
  // Sequence number 0 — the only one a single-shot seal ever uses.
  pt: '4265617574792069732074727574682c20747275746820626561757479',
  aad: '436f756e742d30',
  ct: '1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28',
} as const;

describe('HPKE against RFC 9180 A.2', () => {
  it('derives the public keys the RFC pins from the private ones', () => {
    expect(toHex(x25519.getPublicKey(fromHex(V.skEm)))).toBe(V.pkEm);
    expect(toHex(x25519.getPublicKey(fromHex(V.skRm)))).toBe(V.pkRm);
  });

  it('Encap produces the RFC’s shared secret and encapsulation', () => {
    const { sharedSecret, enc } = _internals.encap(fromHex(V.pkRm), fromHex(V.skEm));
    expect(toHex(enc)).toBe(V.enc);
    expect(toHex(sharedSecret)).toBe(V.shared_secret);
  });

  it('Decap recovers the same shared secret from the encapsulation alone', () => {
    expect(toHex(_internals.decap(fromHex(V.enc), fromHex(V.skRm)))).toBe(V.shared_secret);
  });

  it('the key schedule produces the RFC’s key and base nonce', () => {
    // The intermediate that a round-trip test cannot see. An implementation with a wrong label,
    // a wrong suite id, or a missing I2OSP(L,2) still decrypts its own output perfectly.
    const ctx = _internals.keySchedule(fromHex(V.shared_secret), fromHex(V.info));
    expect(toHex(ctx.key)).toBe(V.key);
    expect(toHex(ctx.baseNonce)).toBe(V.base_nonce);
  });

  it('SealBase produces the RFC’s ciphertext, byte for byte', () => {
    const { enc, ciphertext } = sealBase(
      fromHex(V.pkRm),
      fromHex(V.info),
      fromHex(V.aad),
      fromHex(V.pt),
      fromHex(V.skEm),
    );
    expect(toHex(enc)).toBe(V.enc);
    expect(toHex(ciphertext)).toBe(V.ct);
  });

  it('OpenBase recovers the RFC’s plaintext', () => {
    expect(
      toHex(openBase(fromHex(V.enc), fromHex(V.skRm), fromHex(V.info), fromHex(V.aad), fromHex(V.ct))),
    ).toBe(V.pt);
  });

  it('the aad and the info both bind: changing either refuses', () => {
    // Not in the RFC's vector list, and it is the property §6.3 actually relies on — the courier
    // may read the envelope fields and must not be able to change them.
    const open = (info: string, aad: string) =>
      openBase(fromHex(V.enc), fromHex(V.skRm), fromHex(info), fromHex(aad), fromHex(V.ct));
    expect(() => open(V.info, V.aad)).not.toThrow();
    expect(() => open(V.info, '436f756e742d31')).toThrow();
    expect(() => open('4f6465206f6e2061204772656369616e205552ff', V.aad)).toThrow();
  });

  it('a fresh ephemeral key is used when none is supplied', () => {
    const a = sealBase(fromHex(V.pkRm), new Uint8Array(), new Uint8Array(), fromHex(V.pt));
    const b = sealBase(fromHex(V.pkRm), new Uint8Array(), new Uint8Array(), fromHex(V.pt));
    expect(toHex(a.enc)).not.toBe(toHex(b.enc));
    expect(toHex(a.ciphertext)).not.toBe(toHex(b.ciphertext));
    expect(toHex(openBase(a.enc, fromHex(V.skRm), new Uint8Array(), new Uint8Array(), a.ciphertext))).toBe(V.pt);
  });
});
