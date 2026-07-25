import { x25519, edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { randomBytes } from '@noble/hashes/utils';
import { fromHex, toHex, utf8 } from './hash.js';
import { XCHACHA_NONCE_BYTES } from './content-key.js';

/**
 * §6.3 blind courier — hub-bound payloads MUST be encrypted to the recipient persona key.
 * X25519 ECDH from the Ed25519 keys (birational map, §9.3) + XChaCha20-Poly1305.
 *
 * A conforming hub sees recipient persona_id, ciphertext and timestamps — nothing else.
 * An ephemeral sender key is used so the hub cannot learn the sender from the envelope.
 * HPKE is the targeted profile for v0.2 (§9.6); this is the v0 construction.
 */

const HKDF_INFO = utf8('servanda/0.1 blind-courier v0');

export interface SealedForPersona {
  v: 'servanda/0.1';
  /** Ephemeral X25519 public key, hex. */
  epk: string;
  nonce: string;
  ciphertext: string;
}

function deriveSharedKey(shared: Uint8Array, epk: Uint8Array, recipientX: Uint8Array): Uint8Array {
  const salt = new Uint8Array(epk.length + recipientX.length);
  salt.set(epk, 0);
  salt.set(recipientX, epk.length);
  return hkdf(sha256, shared, salt, HKDF_INFO, 32);
}

/** Encrypt to a recipient's Ed25519 persona public key. */
export function sealToPersona(recipientPersonaIdHex: string, plaintext: Uint8Array): SealedForPersona {
  const recipientX = edwardsToMontgomeryPub(fromHex(recipientPersonaIdHex));
  const ephemeralPriv = x25519.utils.randomPrivateKey();
  const epk = x25519.getPublicKey(ephemeralPriv);
  const key = deriveSharedKey(x25519.getSharedSecret(ephemeralPriv, recipientX), epk, recipientX);
  const nonce = randomBytes(XCHACHA_NONCE_BYTES);
  return {
    v: 'servanda/0.1',
    epk: toHex(epk),
    nonce: toHex(nonce),
    ciphertext: toHex(xchacha20poly1305(key, nonce).encrypt(plaintext)),
  };
}

/** Open a sealed payload with the recipient's Ed25519 persona private key. */
export function openSealed(recipientPrivateKeyHex: string, sealed: SealedForPersona): Uint8Array {
  const recipientXPriv = edwardsToMontgomeryPriv(fromHex(recipientPrivateKeyHex));
  const recipientX = x25519.getPublicKey(recipientXPriv);
  const epk = fromHex(sealed.epk);
  const key = deriveSharedKey(x25519.getSharedSecret(recipientXPriv, epk), epk, recipientX);
  return xchacha20poly1305(key, fromHex(sealed.nonce)).decrypt(fromHex(sealed.ciphertext));
}
