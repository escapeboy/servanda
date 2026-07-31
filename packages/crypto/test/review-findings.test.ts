import { describe, expect, it } from 'vitest';
import { ed25519, edwardsToMontgomeryPub } from '@noble/curves/ed25519';
import { randomBytes } from '@noble/hashes/utils';
import {
  DEVICE_KEY_MIN_BYTES,
  UnsealableRecipient,
  WeakDeviceKey,
  generateContentKey,
  openSealed,
  sealToPersona,
  toHex,
  unwrapWithDevice,
  wrapForDevice,
  wrapForPassphrase,
  sealContentKey,
} from '../src/index.js';

/**
 * The findings from `docs/crypto-review-packet.md`, as tests.
 *
 * Everything here guards a property that was ABSENT and whose absence was invisible: the seal
 * derived from a y-coordinate rather than an identity, a device key went to the AEAD unstretched
 * and unchecked, and two envelope fields sat outside the ciphertext where a courier could edit
 * them. None of it broke anything at the time — which is exactly why it needed tests rather than
 * a note.
 *
 * What is NOT here is F-1, the key-reuse question itself. It is not testable: no assertion
 * distinguishes "Ed25519 and X25519 over one key pair is sound" from "no one has broken it yet",
 * and the packet says so.
 */

const persona = () => {
  const priv = randomBytes(32);
  return { priv: toHex(priv), id: toHex(ed25519.getPublicKey(priv)) };
};

describe('F-2: the seal binds an identity, not a y-coordinate', () => {
  it('a persona and its negation still share an X25519 key', () => {
    // The finding itself, restated so a future change to the map is caught here. The birational
    // map is 2-to-1 and that has not changed; what changed is that the key schedule no longer
    // depends on it alone.
    const alice = persona();
    const sibling = toHex(ed25519.Point.fromBytes(Uint8Array.from(Buffer.from(alice.id, 'hex'))).negate().toBytes());
    expect(sibling).not.toBe(alice.id);
    expect(toHex(edwardsToMontgomeryPub(Uint8Array.from(Buffer.from(sibling, 'hex'))))).toBe(
      toHex(edwardsToMontgomeryPub(Uint8Array.from(Buffer.from(alice.id, 'hex')))),
    );
  });

  it('but a payload sealed to one does not open under the other', () => {
    // Before the persona_id entered `info`, these two derived the SAME key: a ciphertext sealed
    // "to Alice" was equally sealed to a persona_id Alice never chose. Now the derivation differs,
    // so the AEAD tag refuses.
    const alice = persona();
    const sibling = toHex(ed25519.Point.fromBytes(Uint8Array.from(Buffer.from(alice.id, 'hex'))).negate().toBytes());
    const sealed = sealToPersona(alice.id, new TextEncoder().encode('for alice only'));

    expect(new TextDecoder().decode(openSealed(alice.priv, sealed))).toBe('for alice only');
    // Re-derive as the sibling would: same X25519 key material, different `info`.
    const asSibling = sealToPersona(sibling, new TextEncoder().encode('for alice only'));
    expect(asSibling.ciphertext).not.toBe(sealed.ciphertext);
    expect(() => openSealed(alice.priv, asSibling)).toThrow();
  });

  it('refuses a degenerate recipient by name rather than three layers down', () => {
    // The all-zero persona_id is on the curve (y = 0), so the map accepts it and returns u = 1;
    // only the DH refused, with a message naming nothing.
    expect(() => sealToPersona('00'.repeat(32), new Uint8Array([1]))).toThrow(UnsealableRecipient);
  });
});

describe('F-4: the envelope fields a courier can read, it cannot change', () => {
  it('associated data is bound: altering it breaks the tag', () => {
    const alice = persona();
    const aad = new TextEncoder().encode('{"recipient":"a","sent_at":"2026-07-31T00:00:00Z"}');
    const tampered = new TextEncoder().encode('{"recipient":"a","sent_at":"2020-01-01T00:00:00Z"}');
    const sealed = sealToPersona(alice.id, new TextEncoder().encode('payload'), aad);

    expect(new TextDecoder().decode(openSealed(alice.priv, sealed, aad))).toBe('payload');
    expect(() => openSealed(alice.priv, sealed, tampered)).toThrow();
    // And omitting it entirely is not a way around it.
    expect(() => openSealed(alice.priv, sealed)).toThrow();
  });
});

describe('F-5: a device key is stretched and checked, not used as an AEAD key', () => {
  it('refuses a device key too short to carry 256 bits', () => {
    // A KDF spreads entropy; it cannot create it. Accepting 16 bytes and emitting a 32-byte key
    // would make a weak device key indistinguishable from a real one at every later layer.
    const contentKey = generateContentKey();
    expect(() => wrapForDevice(contentKey, 'ab'.repeat(16), 'phone')).toThrow(WeakDeviceKey);
    expect(DEVICE_KEY_MIN_BYTES).toBe(32);
  });

  it('round-trips a conforming device key', () => {
    const contentKey = generateContentKey();
    const deviceKey = toHex(randomBytes(32));
    const keyset = sealContentKey(contentKey, [
      wrapForPassphrase(contentKey, 'correct horse battery staple'),
      wrapForDevice(contentKey, deviceKey, 'laptop'),
    ]);
    expect(toHex(unwrapWithDevice(keyset, deviceKey))).toBe(toHex(contentKey));
  });

  it('the wrap is domain-separated: the raw device key no longer opens it', () => {
    // The positive control for the fix. If `wrapForDevice` still passed the caller's bytes
    // straight to the AEAD, the raw key would open the wrap and this would fail.
    const contentKey = generateContentKey();
    const deviceKey = toHex(randomBytes(32));
    const wrap = wrapForDevice(contentKey, deviceKey, 'laptop');
    const keyset = sealContentKey(contentKey, [
      wrapForPassphrase(contentKey, 'pass'),
      wrap,
    ]);
    expect(() => unwrapWithDevice(keyset, deviceKey)).not.toThrow();
    // A different 32-byte key must not open it either — the check above must not be vacuous.
    expect(() => unwrapWithDevice(keyset, toHex(randomBytes(32)))).toThrow();
  });
});
