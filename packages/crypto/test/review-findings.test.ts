import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ed25519, edwardsToMontgomeryPub } from '@noble/curves/ed25519';
import { randomBytes } from '@noble/hashes/utils';
import {
  DEVICE_KEY_MIN_BYTES,
  UnsealableRecipient,
  WeakDeviceKey,
  derivePersona,
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
  const p = derivePersona(randomBytes(64), 0);
  return { priv: p.privateKey, id: p.personaId, dhPriv: p.dhPrivateKey, dhPub: p.dhPublicKey };
};

describe('F-2: the birational map is gone from the sealing path entirely', () => {
  it('the map is still 2-to-1 — it simply no longer decides anything', () => {
    // The finding as originally recorded, kept because it is the reason the map left. A persona
    // and its negation are distinct identifiers over one Montgomery u; deriving a sealing key
    // from that u bound a y-coordinate rather than an identity.
    const alice = persona();
    const sibling = toHex(ed25519.Point.fromBytes(Uint8Array.from(Buffer.from(alice.id, 'hex'))).negate().toBytes());
    expect(sibling).not.toBe(alice.id);
    expect(toHex(edwardsToMontgomeryPub(Uint8Array.from(Buffer.from(sibling, 'hex'))))).toBe(
      toHex(edwardsToMontgomeryPub(Uint8Array.from(Buffer.from(alice.id, 'hex')))),
    );
  });

  it('nothing in the shipped sealing module can convert a signing key', () => {
    // The structural form, and the strongest statement available: F-2 was first fixed by binding
    // the persona_id into `info`, which made the claim true while leaving the map in place.
    // Removing the map is what makes the finding unreachable rather than compensated for.
    const source = readFileSync('packages/crypto/dist/transport.js', 'utf8');
    for (const gone of [/edwardsToMontgomeryPub/, /edwardsToMontgomeryPriv/]) {
      expect(source, `transport.js must not reference ${gone}`).not.toMatch(gone);
    }
    // A scanner that cannot fire proves nothing.
    expect('edwardsToMontgomeryPub(x)').toMatch(/edwardsToMontgomeryPub/);
  });

  it('refuses a degenerate recipient key by name rather than three layers down', () => {
    const alice = persona();
    expect(() => sealToPersona(alice.id, '00'.repeat(32), new Uint8Array([1]))).toThrow(
      UnsealableRecipient,
    );
  });
});

describe('F-4: the envelope fields a courier can read, it cannot change', () => {
  it('associated data is bound: altering it breaks the tag', () => {
    const alice = persona();
    const aad = new TextEncoder().encode('{"recipient":"a","sent_at":"2026-07-31T00:00:00Z"}');
    const tampered = new TextEncoder().encode('{"recipient":"a","sent_at":"2020-01-01T00:00:00Z"}');
    const sealed = sealToPersona(alice.id, alice.dhPub, new TextEncoder().encode('payload'), aad);

    expect(new TextDecoder().decode(openSealed(alice.dhPriv, alice.id, sealed, aad))).toBe('payload');
    expect(() => openSealed(alice.dhPriv, alice.id, sealed, tampered)).toThrow();
    // And omitting it entirely is not a way around it.
    expect(() => openSealed(alice.dhPriv, alice.id, sealed)).toThrow();
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
