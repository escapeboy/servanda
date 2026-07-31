import { x25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { randomBytes } from '@noble/hashes/utils';
import { fromHex, toHex, utf8 } from './hash.js';
import { XCHACHA_NONCE_BYTES } from './content-key.js';

/**
 * §6.3 blind courier — hub-bound payloads are encrypted to the recipient's X25519 key.
 *
 * A conforming hub sees recipient persona_id, ciphertext and timestamps — nothing else.
 * An ephemeral sender key is used so the hub cannot learn the sender from the envelope.
 *
 * **The recipient's key is now a key of its own** (`m/7391'/{n}'/1'`), not the signing key run
 * through the Ed25519 → X25519 birational map. Upstream #7 asks whether one key pair may safely
 * both sign and perform Diffie-Hellman; a separate key does not answer that, it removes the
 * question. Nothing in this module can turn a `persona_id` into a sealing key any more, which is
 * what makes the removal structural rather than remembered — see `sealToPersona`.
 *
 * Upstream proposal: escapeboy/servanda-protocol#33.
 */

/**
 * The key-schedule label, and the `v1` is load-bearing.
 *
 * §6.3 says nothing whatsoever about the KDF — no HKDF, no salt, no info. That silence is the same
 * class of defect as the unbounded envelope was for the §2 `id`: it leaves the key schedule
 * implementation-defined, so two conforming implementations cannot interoperate. Filed as #30;
 * until it is answered this schedule is ours, and the label carries a version so a change is
 * visible rather than silent. `v2` is the move to a dedicated recipient key.
 */
const HKDF_INFO_LABEL = utf8('servanda/0.1 blind-courier v2');

export interface SealedForPersona {
  v: 'servanda/0.1';
  /** Ephemeral X25519 public key, hex. */
  epk: string;
  nonce: string;
  ciphertext: string;
}

/**
 * `info = <label> || 0x00 || recipient persona_id`, matching §0's domain-separation shape.
 *
 * The persona_id binding matters MORE now that the DH key is separate, not less. Without it the
 * ciphertext would be tied only to whichever key an identity currently advertises — and a
 * published key can be replaced by publishing again. Binding the identity ties the payload to
 * *who* it was for, and leaves the DH key as the thing that opens it.
 */
function deriveSharedKey(
  shared: Uint8Array,
  epk: Uint8Array,
  recipientX: Uint8Array,
  recipientPersonaId: Uint8Array,
): Uint8Array {
  const salt = new Uint8Array(epk.length + recipientX.length);
  salt.set(epk, 0);
  salt.set(recipientX, epk.length);

  const info = new Uint8Array(HKDF_INFO_LABEL.length + 1 + recipientPersonaId.length);
  info.set(HKDF_INFO_LABEL, 0);
  info[HKDF_INFO_LABEL.length] = 0x00;
  info.set(recipientPersonaId, HKDF_INFO_LABEL.length + 1);

  return hkdf(sha256, shared, salt, info, 32);
}

export class UnsealableRecipient extends Error {
  override name = 'UnsealableRecipient';
}

/**
 * A persona_id that decodes to a curve point but carries no usable Diffie-Hellman.
 *
 * The all-zero persona_id is the case that reaches here: `y = 0` IS on the curve, so the map
 * accepts it and returns `u = 1`, and only the DH itself refuses. Left alone it surfaces as
 * `invalid private or public key received` from three layers down. Caught here it says which
 * persona could not be sealed to, which is what a caller can act on.
 */
function sharedSecretOrThrow(priv: Uint8Array, pub: Uint8Array, who: string): Uint8Array {
  try {
    return x25519.getSharedSecret(priv, pub);
  } catch (cause) {
    throw new UnsealableRecipient(
      `persona ${who.slice(0, 16)}… has no usable X25519 key (low-order or degenerate point)`,
      { cause },
    );
  }
}

/**
 * Encrypt to a recipient's X25519 key, for the identity named by `recipientPersonaIdHex`.
 *
 * **Both arguments are required and neither can be computed from the other.** That is the point:
 * a caller must have obtained the DH key from somewhere that authenticated it — in this
 * implementation, a §6.7 inbox record whose signature verifies against the persona it names
 * (M-17). There is no path from a persona_id alone to a sealing key, so the silent fallback to
 * the birational map is not a mistake to avoid; it is unreachable.
 *
 * `aad` binds context the ciphertext does not itself carry — the hub transport passes the outer
 * envelope fields, which would otherwise be a courier's to rewrite. Optional because the vault
 * has no outer envelope to bind.
 */
export function sealToPersona(
  recipientPersonaIdHex: string,
  recipientDhKeyHex: string,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): SealedForPersona {
  const recipientId = fromHex(recipientPersonaIdHex);
  const recipientX = fromHex(recipientDhKeyHex);
  const ephemeralPriv = x25519.utils.randomPrivateKey();
  const epk = x25519.getPublicKey(ephemeralPriv);
  const shared = sharedSecretOrThrow(ephemeralPriv, recipientX, recipientPersonaIdHex);
  const key = deriveSharedKey(shared, epk, recipientX, recipientId);
  const nonce = randomBytes(XCHACHA_NONCE_BYTES);
  return {
    v: 'servanda/0.1',
    epk: toHex(epk),
    nonce: toHex(nonce),
    ciphertext: toHex(xchacha20poly1305(key, nonce, aad).encrypt(plaintext)),
  };
}

/**
 * Open a sealed payload with the recipient's X25519 private key.
 *
 * The persona_id is passed rather than derived, because it no longer can be: the DH key and the
 * signing key are independent, so nothing about one reveals the other. A recipient knows both.
 */
export function openSealed(
  recipientDhPrivateKeyHex: string,
  recipientPersonaIdHex: string,
  sealed: SealedForPersona,
  aad?: Uint8Array,
): Uint8Array {
  const recipientXPriv = fromHex(recipientDhPrivateKeyHex);
  const recipientX = x25519.getPublicKey(recipientXPriv);
  const recipientId = fromHex(recipientPersonaIdHex);
  const epk = fromHex(sealed.epk);
  const key = deriveSharedKey(
    sharedSecretOrThrow(recipientXPriv, epk, recipientPersonaIdHex),
    epk,
    recipientX,
    recipientId,
  );
  return xchacha20poly1305(key, fromHex(sealed.nonce), aad).decrypt(fromHex(sealed.ciphertext));
}
