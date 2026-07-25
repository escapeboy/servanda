import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha2';
import { ed25519 } from '@noble/curves/ed25519';
import { concatBytes, toHex, utf8 } from './hash.js';

/**
 * SLIP-0010 hardened Ed25519 derivation (spec §1.2).
 *
 * Ed25519 has no public-key (non-hardened) derivation; SLIP-0010 defines hardened
 * derivation only, which is also what §1.2 requires ("MUST be one-way").
 */

export const HARDENED_OFFSET = 0x80000000;

/** §1.2: 7391 = the protocol's purpose constant. */
export const SERVANDA_PURPOSE = 7391;

export interface ExtendedKey {
  privateKey: Uint8Array;
  chainCode: Uint8Array;
}

export interface DerivedPersona {
  personaIndex: number;
  path: string;
  chainCode: string;
  privateKey: string;
  publicKey: string;
  /** §1.2: persona_id = hex(pubkey). */
  personaId: string;
}

const ED25519_CURVE_KEY = utf8('ed25519 seed');

/** SLIP-0010 master key generation from a BIP-39 seed. */
export function masterKeyFromSeed(seed: Uint8Array): ExtendedKey {
  const I = hmac(sha512, ED25519_CURVE_KEY, seed);
  return { privateKey: I.slice(0, 32), chainCode: I.slice(32, 64) };
}

function ser32(index: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, index >>> 0, false);
  return out;
}

/** SLIP-0010 hardened child derivation. `index` is the raw index; the hardened bit is added here. */
export function deriveHardenedChild(parent: ExtendedKey, index: number): ExtendedKey {
  if (index < 0 || index >= HARDENED_OFFSET) {
    throw new RangeError(`child index out of range for hardened derivation: ${index}`);
  }
  const data = concatBytes(new Uint8Array([0]), parent.privateKey, ser32(HARDENED_OFFSET + index));
  const I = hmac(sha512, parent.chainCode, data);
  return { privateKey: I.slice(0, 32), chainCode: I.slice(32, 64) };
}

/**
 * Derive along a hardened-only path such as `m/7391'/0'`.
 * A non-hardened segment is a protocol violation, not a fallback.
 */
export function derivePath(seed: Uint8Array, path: string): ExtendedKey {
  const parts = path.split('/');
  if (parts[0] !== 'm') throw new TypeError(`derivation path must start with "m": ${path}`);
  let key = masterKeyFromSeed(seed);
  for (const segment of parts.slice(1)) {
    if (!segment.endsWith("'") && !segment.endsWith('h')) {
      throw new TypeError(`§1.2 requires hardened derivation; unhardened segment "${segment}" in ${path}`);
    }
    const index = Number.parseInt(segment.slice(0, -1), 10);
    if (!Number.isInteger(index)) throw new TypeError(`bad path segment "${segment}" in ${path}`);
    key = deriveHardenedChild(key, index);
  }
  return key;
}

export function personaPath(personaIndex: number): string {
  return `m/${SERVANDA_PURPOSE}'/${personaIndex}'`;
}

/** Derive persona `personaIndex` from a seed at `m/7391'/{personaIndex}'`. */
export function derivePersona(seed: Uint8Array, personaIndex: number): DerivedPersona {
  const path = personaPath(personaIndex);
  const key = derivePath(seed, path);
  const publicKey = ed25519.getPublicKey(key.privateKey);
  return {
    personaIndex,
    path,
    chainCode: toHex(key.chainCode),
    privateKey: toHex(key.privateKey),
    publicKey: toHex(publicKey),
    personaId: toHex(publicKey),
  };
}
