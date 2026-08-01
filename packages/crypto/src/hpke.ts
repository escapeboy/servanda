import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { extract, expand } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { concatBytes, utf8 } from './hash.js';

/**
 * HPKE — RFC 9180, Base mode, single shot.
 *
 * Ciphersuite: DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305
 * (`kem_id = 0x0020`, `kdf_id = 0x0001`, `aead_id = 0x0003`).
 *
 * ## Why this replaces the construction that was here
 *
 * §6.3 used to say "X25519 ECDH + XChaCha20-Poly1305", which is exactly the assembly RFC 9180
 * exists to stop people performing by hand. Every decision it left open — how the DH output
 * becomes a key, what binds the ciphertext to a recipient and a version, how the nonce is
 * derived, whether the sender is authenticated — HPKE has already made, published and had
 * reviewed. Upstream #6 asked for the migration and #30 recorded that the schedule was
 * unspecified; both are answered by not having a schedule of our own.
 *
 * The gain that matters most is not elegance. **RFC 9180 ships test vectors**, so this code has
 * an external oracle written by people who do not work on this protocol. The hand-rolled version
 * could never have one: its correctness was whatever the implementation happened to do.
 *
 * ## Implemented here rather than depended upon
 *
 * `@servanda/crypto` reaches only for `@noble` and `@scure`, and that narrow graph is a security
 * property of a package whose whole job is key material. HPKE Base mode over primitives noble
 * already provides is a few dozen lines of exactly-specified derivation, verified against the
 * RFC's own vectors — a smaller risk than a new transitive tree.
 *
 * Base mode only. Auth mode binds a sender's static key into the KEM, which this protocol does
 * not want: §6.3's courier is anonymous ON PURPOSE, so a hub cannot learn who sent what.
 * Authentication lives in the Ed25519 signature inside the ciphertext, and the recipient binding
 * that signature was missing is now a `recipient` member of the signed message (§6.2).
 */

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0003;

/** RFC 9180 §7: sizes for this ciphersuite. */
const NSECRET = 32;
const NK = 32;
const NN = 12;

const MODE_BASE = 0x00;
const HPKE_V1 = utf8('HPKE-v1');

/** RFC 9180 §4: `I2OSP(n, 2)` — a two-byte big-endian integer. */
function i2osp2(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

/** `suite_id` for the KEM: "KEM" || I2OSP(kem_id, 2). */
const KEM_SUITE_ID = concatBytes(utf8('KEM'), i2osp2(KEM_ID));
/** `suite_id` for the rest of HPKE: "HPKE" || kem_id || kdf_id || aead_id. */
const HPKE_SUITE_ID = concatBytes(
  utf8('HPKE'),
  i2osp2(KEM_ID),
  i2osp2(KDF_ID),
  i2osp2(AEAD_ID),
);

/**
 * RFC 9180 §4: `LabeledExtract(salt, label, ikm) = Extract(salt, "HPKE-v1" || suite_id || label || ikm)`.
 *
 * The label and suite id are what make one derivation unusable as another — the domain separation
 * that the hand-rolled schedule had to invent for itself, and got a version string rather than a
 * ciphersuite identifier.
 */
function labeledExtract(suiteId: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Uint8Array {
  return extract(sha256, concatBytes(HPKE_V1, suiteId, utf8(label), ikm), salt);
}

/** RFC 9180 §4: `LabeledExpand(prk, label, info, L)`, with `I2OSP(L, 2)` leading. */
function labeledExpand(
  suiteId: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
): Uint8Array {
  return expand(
    sha256,
    prk,
    concatBytes(i2osp2(length), HPKE_V1, suiteId, utf8(label), info),
    length,
  );
}

/** RFC 9180 §4.1 DHKEM `ExtractAndExpand`. */
function extractAndExpand(dh: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const eaePrk = labeledExtract(KEM_SUITE_ID, new Uint8Array(0), 'eae_prk', dh);
  return labeledExpand(KEM_SUITE_ID, eaePrk, 'shared_secret', kemContext, NSECRET);
}

/**
 * RFC 9180 §4.1 `Encap`. The ephemeral key is a parameter rather than generated here so the
 * whole operation is a pure function of its inputs — which is what lets the RFC's vectors, which
 * pin `skEm`, be replayed against it at all.
 */
function encap(pkR: Uint8Array, skE: Uint8Array): { sharedSecret: Uint8Array; enc: Uint8Array } {
  const enc = x25519.getPublicKey(skE);
  const dh = x25519.getSharedSecret(skE, pkR);
  return { sharedSecret: extractAndExpand(dh, concatBytes(enc, pkR)), enc };
}

/** RFC 9180 §4.1 `Decap`. */
function decap(enc: Uint8Array, skR: Uint8Array): Uint8Array {
  const dh = x25519.getSharedSecret(skR, enc);
  const pkR = x25519.getPublicKey(skR);
  return extractAndExpand(dh, concatBytes(enc, pkR));
}

interface Context {
  key: Uint8Array;
  baseNonce: Uint8Array;
}

/**
 * RFC 9180 §5.1 `KeySchedule`, Base mode.
 *
 * `psk` and `psk_id` are empty in Base mode, and the empty `psk_id_hash` is not a formality: it
 * is what makes a Base-mode context provably distinct from a PSK-mode one carrying the same
 * shared secret.
 */
function keySchedule(sharedSecret: Uint8Array, info: Uint8Array): Context {
  const empty = new Uint8Array(0);
  const pskIdHash = labeledExtract(HPKE_SUITE_ID, empty, 'psk_id_hash', empty);
  const infoHash = labeledExtract(HPKE_SUITE_ID, empty, 'info_hash', info);
  const keyScheduleContext = concatBytes(new Uint8Array([MODE_BASE]), pskIdHash, infoHash);

  const secret = labeledExtract(HPKE_SUITE_ID, sharedSecret, 'secret', empty);
  return {
    key: labeledExpand(HPKE_SUITE_ID, secret, 'key', keyScheduleContext, NK),
    baseNonce: labeledExpand(HPKE_SUITE_ID, secret, 'base_nonce', keyScheduleContext, NN),
  };
}

/**
 * RFC 9180 §6.1 `SealBase`, at sequence number 0.
 *
 * Single shot: one message per context, so the nonce is the base nonce unmodified
 * (`base_nonce XOR I2OSP(0, Nn)`). A context is never reused here, which is what keeps that safe
 * — §6.3 seals one wire message per envelope and never encrypts twice under one encapsulation.
 *
 * `skE` is injected. In production it is fresh randomness; the RFC's vectors supply their own,
 * which is the only way this can be checked against them.
 */
export function sealBase(
  pkR: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
  skE: Uint8Array = x25519.utils.randomPrivateKey(),
): { enc: Uint8Array; ciphertext: Uint8Array } {
  const { sharedSecret, enc } = encap(pkR, skE);
  const ctx = keySchedule(sharedSecret, info);
  return { enc, ciphertext: chacha20poly1305(ctx.key, ctx.baseNonce, aad).encrypt(plaintext) };
}

/** RFC 9180 §6.1 `OpenBase`, at sequence number 0. */
export function openBase(
  enc: Uint8Array,
  skR: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  const ctx = keySchedule(decap(enc, skR), info);
  return chacha20poly1305(ctx.key, ctx.baseNonce, aad).decrypt(ciphertext);
}

/** Exposed for the RFC 9180 vector replay, which pins every intermediate value. */
export const _internals = { encap, decap, keySchedule, KEM_SUITE_ID, HPKE_SUITE_ID };
