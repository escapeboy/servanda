import { x25519 } from '@noble/curves/ed25519';
import { openBase, sealBase } from './hpke.js';
import { fromHex, toHex, utf8 } from './hash.js';

/**
 * §6.3 blind courier — hub-bound payloads are encrypted to the recipient's X25519 key with
 * **HPKE (RFC 9180), Base mode**: DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305.
 *
 * A conforming hub sees recipient persona_id, ciphertext and timestamps — nothing else. The
 * sender's key is ephemeral, so the hub cannot learn who sent what.
 *
 * What this file no longer does is decide anything. It used to assemble ECDH and an AEAD by hand
 * and choose its own key schedule — the construction upstream #6 asked to replace and #30
 * recorded as unspecified. Every choice now comes from the RFC, and `hpke.ts` is checked against
 * the RFC's own test vectors, so the transport finally has an oracle written by people outside
 * this protocol.
 *
 * Base mode, not Auth: binding a sender's static key into the KEM is exactly what §6.3 does not
 * want. Authentication is the Ed25519 signature inside the ciphertext, and the recipient binding
 * that signature used to lack is now a `recipient` member of the signed message (§6.2).
 */

/**
 * `info` — what the ciphertext is bound to beyond the keys.
 *
 * The recipient's `persona_id` rather than only its X25519 key: the DH key is published in a
 * §6.7 inbox record and a persona may publish a new one, so binding the key alone would tie a
 * payload to whichever key an identity currently advertises rather than to the identity. `v2`
 * marks the move to HPKE; a change here changes every ciphertext, so it is visible rather than
 * silent.
 */
const INFO_LABEL = utf8('servanda/0.1 blind-courier v2');

export interface SealedForPersona {
  v: 'servanda/0.1';
  /** The HPKE encapsulated key (an ephemeral X25519 public key), hex. */
  epk: string;
  ciphertext: string;
}

function info(recipientPersonaId: Uint8Array): Uint8Array {
  const out = new Uint8Array(INFO_LABEL.length + 1 + recipientPersonaId.length);
  out.set(INFO_LABEL, 0);
  out[INFO_LABEL.length] = 0x00;
  out.set(recipientPersonaId, INFO_LABEL.length + 1);
  return out;
}

export class UnsealableRecipient extends Error {
  override name = 'UnsealableRecipient';
}

/**
 * Encrypt to a recipient's X25519 key, for the identity named by `recipientPersonaIdHex`.
 *
 * **Both are required and neither can be computed from the other.** A caller must have obtained
 * the DH key somewhere that authenticated it — in this implementation a §6.7 inbox record whose
 * signature verifies against the persona it names (M-17). There is no path from a persona_id
 * alone to a sealing key, so falling back to the old birational-map construction is not a mistake
 * to avoid; it is unreachable.
 *
 * `aad` binds context the ciphertext does not carry — the hub transport passes the outer envelope
 * fields, which would otherwise be a courier's to rewrite.
 */
export function sealToPersona(
  recipientPersonaIdHex: string,
  recipientDhKeyHex: string,
  plaintext: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): SealedForPersona {
  const recipientId = fromHex(recipientPersonaIdHex);
  try {
    const { enc, ciphertext } = sealBase(
      fromHex(recipientDhKeyHex),
      info(recipientId),
      aad,
      plaintext,
    );
    return { v: 'servanda/0.1', epk: toHex(enc), ciphertext: toHex(ciphertext) };
  } catch (cause) {
    // A degenerate or low-order recipient key surfaces from three layers down as "invalid private
    // or public key received", naming nobody. Caught here it says which persona could not be
    // sealed to, which is what a caller can act on.
    throw new UnsealableRecipient(
      `persona ${recipientPersonaIdHex.slice(0, 16)}… has no usable X25519 key`,
      { cause },
    );
  }
}

/** Open a sealed payload with the recipient's X25519 private key. */
export function openSealed(
  recipientDhPrivateKeyHex: string,
  recipientPersonaIdHex: string,
  sealed: SealedForPersona,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array {
  return openBase(
    fromHex(sealed.epk),
    fromHex(recipientDhPrivateKeyHex),
    info(fromHex(recipientPersonaIdHex)),
    aad,
    fromHex(sealed.ciphertext),
  );
}

/** The X25519 public key for a persona's DH private key. */
export function dhPublicKey(dhPrivateKeyHex: string): string {
  return toHex(x25519.getPublicKey(fromHex(dhPrivateKeyHex)));
}
