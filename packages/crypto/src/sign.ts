import { ed25519 } from '@noble/curves/ed25519';
import { canonicalBytes } from './jcs.js';
import { fromHex, sha256, toHex } from './hash.js';

/**
 * Spec §00 Conventions + §4.2: "All signatures Ed25519 over the SHA-256 of the canonical form."
 * The signing preimage excludes the object's own `sig` field.
 *
 * M-7: signatures cover hashes, never plaintext.
 */

/** The object as it enters the hash: everything except `sig`. */
export function unsigned<T extends Record<string, unknown>>(obj: T): Omit<T, 'sig'> {
  const { sig: _sig, ...rest } = obj as T & { sig?: unknown };
  return rest as Omit<T, 'sig'>;
}

/** sha256(JCS(object minus "sig")) — the exact bytes that get signed. */
export function signingPreimage(obj: Record<string, unknown>): Uint8Array {
  return sha256(canonicalBytes(unsigned(obj)));
}

export function signingPreimageHex(obj: Record<string, unknown>): string {
  return toHex(signingPreimage(obj));
}

/** Sign an object, returning the hex signature (the object itself is not mutated). */
export function signObject(obj: Record<string, unknown>, privateKeyHex: string): string {
  return toHex(ed25519.sign(signingPreimage(obj), fromHex(privateKeyHex)));
}

/** Sign and return a copy carrying its `sig`. */
export function withSignature<T extends Record<string, unknown>>(
  obj: T,
  privateKeyHex: string,
): T & { sig: string } {
  return { ...obj, sig: signObject(obj, privateKeyHex) };
}

/**
 * Verify an object's `sig` against a public key.
 * Returns false rather than throwing on malformed input — a bad signature from the wire is
 * an expected condition, not an exceptional one (§4.3: invalid assertions are discarded).
 */
export function verifyObject(obj: Record<string, unknown>, publicKeyHex: string): boolean {
  const sig = (obj as { sig?: unknown }).sig;
  if (typeof sig !== 'string' || sig.length !== 128) return false;
  try {
    return ed25519.verify(fromHex(sig), signingPreimage(obj), fromHex(publicKeyHex));
  } catch {
    return false;
  }
}

export function publicKeyFromPrivate(privateKeyHex: string): string {
  return toHex(ed25519.getPublicKey(fromHex(privateKeyHex)));
}
