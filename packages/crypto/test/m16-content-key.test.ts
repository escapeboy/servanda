import { describe, expect, it } from 'vitest';
import {
  M16Violation,
  assertM16,
  decryptContent,
  encryptContent,
  generateContentKey,
  sealContentKey,
  unwrapWithDevice,
  unwrapWithPassphrase,
  wrapForDevice,
  wrapForPassphrase,
  ARGON2ID_PARAMS,
} from '../src/content-key.js';
import { openSealed, sealToPersona } from '../src/transport.js';
import { toHex, utf8 } from '../src/hash.js';
import { derivePersona } from '../src/slip10.js';
import { mnemonicToSeed } from '../src/mnemonic.js';
import { loadVectors, type DerivationVectors } from './vectors.js';

/**
 * M-16 — "A device key MUST NOT be sole custodian of vault content keys."
 * §9.3 crypto parameters. §6.3 blind courier.
 */
describe('M-16 vault content-key custody', () => {
  const deviceKey = toHex(generateContentKey());

  it('refuses to seal a keyset wrapped only by device keys', () => {
    const ck = generateContentKey();
    const deviceOnly = [wrapForDevice(ck, deviceKey, 'laptop')];
    expect(() => sealContentKey(ck, deviceOnly)).toThrow(M16Violation);
    expect(() => assertM16(deviceOnly)).toThrow(/M-16/);
  });

  it('refuses a keyset with several device wraps but no passphrase wrap', () => {
    const ck = generateContentKey();
    const wraps = [
      wrapForDevice(ck, deviceKey, 'laptop'),
      wrapForDevice(ck, toHex(generateContentKey()), 'phone'),
    ];
    expect(() => sealContentKey(ck, wraps)).toThrow(M16Violation);
  });

  it('accepts a keyset carrying a passphrase wrap', () => {
    const ck = generateContentKey();
    const keyset = sealContentKey(ck, [
      wrapForPassphrase(ck, 'correct horse battery staple'),
      wrapForDevice(ck, deviceKey, 'laptop'),
    ]);
    expect(keyset.type).toBe('content_keyset');
    expect(keyset.wraps.some((w) => w.kind === 'passphrase')).toBe(true);
  });

  it('unwraps the same content key by passphrase and by device (independent wrapping)', () => {
    const ck = generateContentKey();
    const keyset = sealContentKey(ck, [
      wrapForPassphrase(ck, 'correct horse battery staple'),
      wrapForDevice(ck, deviceKey, 'laptop'),
    ]);
    expect(toHex(unwrapWithPassphrase(keyset, 'correct horse battery staple'))).toBe(toHex(ck));
    expect(toHex(unwrapWithDevice(keyset, deviceKey, 'laptop'))).toBe(toHex(ck));
  });

  it('a lost device does not lose the vault — the passphrase still opens it', () => {
    const ck = generateContentKey();
    const keyset = sealContentKey(ck, [
      wrapForPassphrase(ck, 'passphrase-of-record'),
      wrapForDevice(ck, deviceKey, 'stolen-laptop'),
    ]);
    const survivors = { ...keyset, wraps: keyset.wraps.filter((w) => w.label !== 'stolen-laptop') };
    expect(toHex(unwrapWithPassphrase(survivors, 'passphrase-of-record'))).toBe(toHex(ck));
  });

  it('rejects the wrong passphrase and the wrong device key', () => {
    const ck = generateContentKey();
    const keyset = sealContentKey(ck, [
      wrapForPassphrase(ck, 'right'),
      wrapForDevice(ck, deviceKey, 'laptop'),
    ]);
    expect(() => unwrapWithPassphrase(keyset, 'wrong')).toThrow();
    expect(() => unwrapWithDevice(keyset, toHex(generateContentKey()))).toThrow();
  });

  it('uses the §9.3 Argon2id minimum parameters', () => {
    expect(ARGON2ID_PARAMS).toMatchObject({ m: 65536, t: 3, p: 1, dkLen: 32 });
  });

  it('encrypts and decrypts vault content under the content key', () => {
    const ck = generateContentKey();
    const plaintext = utf8('Add integration tests for PaymentRetryService');
    const blob = encryptContent(ck, plaintext);
    expect(blob.ciphertext).not.toContain('PaymentRetry');
    expect(new TextDecoder().decode(decryptContent(ck, blob))).toBe(
      'Add integration tests for PaymentRetryService',
    );
  });

  it('detects tampering with sealed content (AEAD)', () => {
    const ck = generateContentKey();
    const blob = encryptContent(ck, utf8('hello'));
    const flipped = blob.ciphertext.slice(0, -2) + (blob.ciphertext.endsWith('00') ? '01' : '00');
    expect(() => decryptContent(ck, { ...blob, ciphertext: flipped })).toThrow();
  });
});

describe('§6.3 blind courier', () => {
  const v = loadVectors<DerivationVectors>('derivation/persona-keys.json');
  const seed = mnemonicToSeed(v.mnemonic, v.passphrase);
  const alice = derivePersona(seed, 0);
  const bob = derivePersona(seed, 1);

  it('seals to a persona key and only that persona can open it', () => {
    const sealed = sealToPersona(bob.personaId, utf8('{"type":"propose"}'));
    expect(new TextDecoder().decode(openSealed(bob.privateKey, sealed))).toBe('{"type":"propose"}');
    expect(() => openSealed(alice.privateKey, sealed)).toThrow();
  });

  it('exposes nothing but an ephemeral key, nonce and ciphertext to the hub', () => {
    const sealed = sealToPersona(bob.personaId, utf8('confidential intent text'));
    expect(Object.keys(sealed).sort()).toEqual(['ciphertext', 'epk', 'nonce', 'v']);
    expect(JSON.stringify(sealed)).not.toContain('confidential');
    // The sender's persona is not derivable from the envelope: the sender key is ephemeral.
    expect(sealed.epk).not.toBe(alice.personaId);
  });

  it('produces a distinct ciphertext per send (no deterministic linkage)', () => {
    const a = sealToPersona(bob.personaId, utf8('same message'));
    const b = sealToPersona(bob.personaId, utf8('same message'));
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.epk).not.toBe(b.epk);
  });
});
