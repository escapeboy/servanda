import { describe, expect, it } from 'vitest';
import { derivePath, derivePersona, personaPath, SERVANDA_PURPOSE } from '../src/slip10.js';
import { mnemonicToSeed, isValidMnemonic, generateRootMnemonic } from '../src/mnemonic.js';
import { toHex } from '../src/hash.js';
import { loadVectors, type DerivationVectors } from './vectors.js';

/**
 * G0 — §1.1–§1.2: BIP-39 seed → SLIP-0010 hardened ed25519 at m/7391'/{i}'.
 */
const v = loadVectors<DerivationVectors>('derivation/persona-keys.json');

describe('G0 derivation (§1.1–§1.2)', () => {
  it('uses the protocol purpose constant 7391', () => {
    expect(v.purpose_constant).toBe(SERVANDA_PURPOSE);
    expect(personaPath(0)).toBe("m/7391'/0'");
  });

  it('BIP-39 mnemonic → 64-byte seed', () => {
    expect(isValidMnemonic(v.mnemonic)).toBe(true);
    expect(toHex(mnemonicToSeed(v.mnemonic, v.passphrase))).toBe(v.seed);
  });

  const seed = mnemonicToSeed(v.mnemonic, v.passphrase);

  for (const p of v.personas) {
    describe(`persona ${p.persona_index} (${p.path})`, () => {
      it('derives the vector private key, public key and chain code', () => {
        const derived = derivePersona(seed, p.persona_index);
        expect(derived.path).toBe(p.path);
        expect(derived.chainCode).toBe(p.chain_code);
        expect(derived.privateKey).toBe(p.private_key);
        expect(derived.publicKey).toBe(p.public_key);
      });

      it('persona_id = hex(pubkey)', () => {
        expect(derivePersona(seed, p.persona_index).personaId).toBe(p.persona_id);
        expect(p.persona_id).toBe(p.public_key);
      });
    });
  }

  it('personas are mutually distinct (unlinkability precondition)', () => {
    const ids = new Set(v.personas.map((p) => p.persona_id));
    expect(ids.size).toBe(v.personas.length);
  });

  it('derivation is deterministic — same seed, same keys (ADR-0014 recovery)', () => {
    const again = mnemonicToSeed(v.mnemonic, v.passphrase);
    expect(derivePersona(again, 0)).toEqual(derivePersona(seed, 0));
  });

  it('the org root seed derives to its vector value', () => {
    expect(toHex(mnemonicToSeed(v.org_root.mnemonic as string, ''))).toBe(v.org_root.seed);
  });

  it('§1.2 requires hardened derivation — an unhardened segment is rejected', () => {
    expect(() => derivePath(seed, "m/7391'/0")).toThrow(/hardened/);
    expect(() => derivePath(seed, "7391'/0'")).toThrow(/must start with/);
  });

  it('generates a 24-word root mnemonic (§1.1)', () => {
    const m = generateRootMnemonic();
    expect(m.split(' ').length).toBe(24);
    expect(isValidMnemonic(m)).toBe(true);
  });
});
