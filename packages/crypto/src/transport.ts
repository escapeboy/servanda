import { ed25519, x25519, edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519';
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

/**
 * The key-schedule label, and the `v1` is load-bearing.
 *
 * §6.3 specifies "X25519 (from Ed25519 via birational map) + XChaCha20-Poly1305" and says nothing
 * whatsoever about the KDF — no HKDF, no salt, no info. That silence is the same class of defect
 * as the unbounded envelope was for the §2 `id`: it leaves the key schedule implementation-defined,
 * so two conforming implementations cannot interoperate. Filed upstream; until it is answered this
 * schedule is ours, and the label carries a version so a future change is visible rather than
 * silent.
 */
const HKDF_INFO_LABEL = utf8('servanda/0.1 blind-courier v1');

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
 * Binding the full 32-byte Ed25519 persona_id is the fix for a real gap. The birational map is
 * 2-to-1: `u = (1 + y)/(1 - y)` depends only on the y-coordinate, and a compressed Ed25519 public
 * key is y plus a sign bit, so a persona_id and its negation map to the SAME X25519 key. Deriving
 * from `recipientX` alone therefore binds a y-coordinate, not an identity — while §6.3 claims the
 * payload is "encrypted to the recipient persona key". Folding the persona_id into `info` costs
 * nothing and makes the claim true: the two siblings now derive different keys.
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
 * Encrypt to a recipient's Ed25519 persona public key.
 *
 * `aad` binds context the ciphertext does not itself carry — the hub transport passes the outer
 * envelope fields, which would otherwise be a courier's to rewrite. Optional because the vault
 * has no outer envelope to bind.
 */
export function sealToPersona(
  recipientPersonaIdHex: string,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): SealedForPersona {
  const recipientId = fromHex(recipientPersonaIdHex);
  const recipientX = edwardsToMontgomeryPub(recipientId);
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

/** Open a sealed payload with the recipient's Ed25519 persona private key. */
export function openSealed(
  recipientPrivateKeyHex: string,
  sealed: SealedForPersona,
  aad?: Uint8Array,
): Uint8Array {
  const recipientXPriv = edwardsToMontgomeryPriv(fromHex(recipientPrivateKeyHex));
  const recipientX = x25519.getPublicKey(recipientXPriv);
  const recipientId = ed25519.getPublicKey(fromHex(recipientPrivateKeyHex));
  const epk = fromHex(sealed.epk);
  const key = deriveSharedKey(
    sharedSecretOrThrow(recipientXPriv, epk, toHex(recipientId)),
    epk,
    recipientX,
    recipientId,
  );
  return xchacha20poly1305(key, fromHex(sealed.nonce), aad).decrypt(fromHex(sealed.ciphertext));
}
