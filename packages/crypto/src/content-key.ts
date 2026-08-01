import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { argon2id } from '@noble/hashes/argon2';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { randomBytes } from '@noble/hashes/utils';
import { fromHex, toHex, utf8 } from './hash.js';

/**
 * §1.7 / §9.3 / M-16 — vault content-key hierarchy.
 *
 * A random 256-bit content key encrypts vault content. That key is wrapped independently
 * by each device key and by a passphrase-derived key. M-16: "A device key MUST NOT be sole
 * custodian of vault content keys" — enforced in `sealContentKey`, which refuses to produce
 * a keyset without a passphrase wrap.
 */

/**
 * §9.3: "Argon2id (m=64MiB, t=3, p=1 minimum) for passphrase keys."
 *
 * The three move TOGETHER. §9.3's word "minimum" reads as though each is independently tunable,
 * and it is not: `m`, `t` and `p` describe one analysed point, and lowering any of them while
 * claiming to meet the minimum is how a parameter set gets quietly weakened. RFC 9106's second
 * recommended option is the same `t = 3, m = 64 MiB` with `p = 4`; `p` bounds the parallelism an
 * ATTACKER is assumed to have, so `p = 1` is not the weaker choice, and this sits above the
 * common OWASP floor (m = 19 MiB, t = 2, p = 1) on every axis.
 *
 * Every wrap stores the values it was made with (see `WrappedKey.kdf`), so raising them later
 * does not strand an existing vault — a wrap is opened with its own parameters, not with these.
 * The wording is filed upstream; the values are not in dispute.
 */
export const ARGON2ID_PARAMS = { m: 65536, t: 3, p: 1, dkLen: 32 } as const;

/**
 * The most Argon2id memory this code will allocate to open somebody else's keyset.
 *
 * §9.3 fixes the cost a NEW wrap is made at; nothing bounded the cost an EXISTING one may ask for,
 * and a keyset arrives over §6.6 recovery and over import. 16× the current parameter leaves room
 * for a future raise (the §9.3 floor has moved once already) while keeping a hostile keyset from
 * naming a number the machine cannot serve.
 */
export const MAX_UNWRAP_MEMORY_KIB = ARGON2ID_PARAMS.m * 16;

/**
 * Device-key wraps derive a key rather than using the device key as one.
 *
 * §1.7 and §9.3 say a device key wraps the content key and do not say how, so this is ours to
 * decide. Passing the caller's bytes straight to the AEAD — which is what this did — is sound
 * only if every caller supplies 32 uniformly random bytes, and nothing in the type system, the
 * schema or the vault said so. One HKDF removes the assumption: any accepted input becomes a
 * uniform 32-byte key, and the label keeps device wrapping domain-separated from every other use
 * of the same bytes.
 */
const DEVICE_WRAP_LABEL = utf8('servanda/0.1 device-wrap v1');
export const DEVICE_KEY_MIN_BYTES = 32;

export class WeakDeviceKey extends Error {
  override name = 'WeakDeviceKey';
}

function deviceWrapKey(deviceKeyHex: string): Uint8Array {
  const raw = fromHex(deviceKeyHex);
  // A KDF spreads entropy; it cannot create it. Short input is refused rather than stretched,
  // because a 16-byte device key that produces a 32-byte AEAD key looks exactly as strong as a
  // real one from the outside.
  if (raw.length < DEVICE_KEY_MIN_BYTES) {
    throw new WeakDeviceKey(
      `a device key must be at least ${DEVICE_KEY_MIN_BYTES} bytes; got ${raw.length}`,
    );
  }
  return hkdf(sha256, raw, undefined, DEVICE_WRAP_LABEL, 32);
}

export const CONTENT_KEY_BYTES = 32;
export const XCHACHA_NONCE_BYTES = 24;
export const SALT_BYTES = 16;

export type WrapKind = 'passphrase' | 'device';

export interface WrappedKey {
  kind: WrapKind;
  /** Device label or passphrase-slot label; local bookkeeping only. */
  label: string;
  nonce: string;
  ciphertext: string;
  /** Present for passphrase wraps: the Argon2id salt and parameters used. */
  kdf?: { algo: 'argon2id'; salt: string; m: number; t: number; p: number };
}

export interface ContentKeySet {
  v: 'servanda/0.1';
  type: 'content_keyset';
  wraps: WrappedKey[];
}

export function generateContentKey(): Uint8Array {
  return randomBytes(CONTENT_KEY_BYTES);
}

/**
 * `params` defaults to today's values for wrapping, and is the WRAP's own values for unwrapping.
 * That asymmetry is the whole point of storing them: new wraps are made at the current cost,
 * existing ones are opened at the cost they were made at.
 */
export function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  params: { m: number; t: number; p: number } = ARGON2ID_PARAMS,
): Uint8Array {
  return argon2id(utf8(passphrase), salt, {
    m: params.m,
    t: params.t,
    p: params.p,
    dkLen: ARGON2ID_PARAMS.dkLen,
  });
}

function wrapWith(key: Uint8Array, contentKey: Uint8Array): { nonce: string; ciphertext: string } {
  const nonce = randomBytes(XCHACHA_NONCE_BYTES);
  return {
    nonce: toHex(nonce),
    ciphertext: toHex(xchacha20poly1305(key, nonce).encrypt(contentKey)),
  };
}

/**
 * An empty passphrase is refused, and this is the narrowest possible line rather than a policy.
 *
 * M-16 is enforced structurally: a keyset must carry a passphrase wrap, so device keys cannot be
 * sole custodian. `wrapForPassphrase(key, '')` satisfied that check while protecting nothing —
 * anyone holding the vault opens it, and the device key IS the only custodian in every sense but
 * the schema's. A structural guarantee that an empty string satisfies is not one.
 *
 * Length, composition and entropy are product decisions and the spec takes none of them, so none
 * is taken here. Zero is not a judgement about strength; it is the case where the wrap is absent
 * while claiming to be present.
 */
export class EmptyPassphrase extends Error {
  override name = 'EmptyPassphrase';
}

export function wrapForPassphrase(
  contentKey: Uint8Array,
  passphrase: string,
  label = 'passphrase',
): WrappedKey {
  if (passphrase.length === 0) {
    throw new EmptyPassphrase('M-16: a passphrase wrap made with an empty passphrase protects nothing');
  }
  const salt = randomBytes(SALT_BYTES);
  const kek = deriveKeyFromPassphrase(passphrase, salt);
  const { nonce, ciphertext } = wrapWith(kek, contentKey);
  return {
    kind: 'passphrase',
    label,
    nonce,
    ciphertext,
    kdf: {
      algo: 'argon2id',
      salt: toHex(salt),
      m: ARGON2ID_PARAMS.m,
      t: ARGON2ID_PARAMS.t,
      p: ARGON2ID_PARAMS.p,
    },
  };
}

export function wrapForDevice(
  contentKey: Uint8Array,
  deviceKeyHex: string,
  label: string,
): WrappedKey {
  const { nonce, ciphertext } = wrapWith(deviceWrapKey(deviceKeyHex), contentKey);
  return { kind: 'device', label, nonce, ciphertext };
}

export class M16Violation extends Error {
  override name = 'M16Violation';
}

/**
 * Build a keyset. M-16 is enforced structurally: at least one passphrase wrap must exist,
 * so no set of device keys alone can be the sole custodian of the content key.
 */
export function sealContentKey(
  contentKey: Uint8Array,
  wraps: WrappedKey[],
): ContentKeySet {
  assertM16(wraps);
  return { v: 'servanda/0.1', type: 'content_keyset', wraps };
}

/** M-16 check, exported so vault code and the M-suite can assert on the same predicate. */
export function assertM16(wraps: WrappedKey[]): void {
  if (!wraps.some((w) => w.kind === 'passphrase')) {
    throw new M16Violation(
      'M-16: a device key MUST NOT be sole custodian of the vault content key; ' +
        'at least one passphrase wrap is required',
    );
  }
}

function unwrapWith(key: Uint8Array, wrap: WrappedKey): Uint8Array {
  return xchacha20poly1305(key, fromHex(wrap.nonce)).decrypt(fromHex(wrap.ciphertext));
}

export function unwrapWithPassphrase(keyset: ContentKeySet, passphrase: string, label?: string): Uint8Array {
  const candidates = keyset.wraps.filter(
    (w) => w.kind === 'passphrase' && (label === undefined || w.label === label),
  );
  for (const wrap of candidates) {
    if (!wrap.kdf) continue;
    // The wrap's own parameters, not today's: a vault made before the cost was raised must still
    // open, and deriving with the current constants would tell its owner the passphrase is wrong.
    //
    // Bounded above, because a keyset is not always your own. Recovery and import paths hand this
    // function a structure that came from somewhere else, and `m` is the memory Argon2id will
    // allocate: a wrap declaring m = 4 GiB is a keyset-shaped way to stop the process. Reading a
    // LOWER cost than today's is harmless — it only ever weakens a key that is already wrapped —
    // so only the ceiling needs guarding, and it is a refusal rather than a clamp because
    // silently deriving with different parameters is exactly the bug above.
    if (wrap.kdf.m > MAX_UNWRAP_MEMORY_KIB) {
      throw new Error(
        `refusing a wrap demanding ${wrap.kdf.m} KiB of Argon2id memory; the ceiling is ${MAX_UNWRAP_MEMORY_KIB} KiB`,
      );
    }
    const kek = deriveKeyFromPassphrase(passphrase, fromHex(wrap.kdf.salt), wrap.kdf);
    try {
      return unwrapWith(kek, wrap);
    } catch {
      // wrong passphrase for this slot; try the next
    }
  }
  throw new Error('no passphrase wrap could be opened with the supplied passphrase');
}

export function unwrapWithDevice(keyset: ContentKeySet, deviceKeyHex: string, label?: string): Uint8Array {
  const candidates = keyset.wraps.filter(
    (w) => w.kind === 'device' && (label === undefined || w.label === label),
  );
  const kek = deviceWrapKey(deviceKeyHex);
  for (const wrap of candidates) {
    try {
      return unwrapWith(kek, wrap);
    } catch {
      // not this device's wrap
    }
  }
  throw new Error('no device wrap could be opened with the supplied device key');
}

/** Content encryption with the unwrapped content key (§9.3: XChaCha20-Poly1305). */
export interface SealedBlob {
  nonce: string;
  ciphertext: string;
}

export function encryptContent(contentKey: Uint8Array, plaintext: Uint8Array): SealedBlob {
  const nonce = randomBytes(XCHACHA_NONCE_BYTES);
  return {
    nonce: toHex(nonce),
    ciphertext: toHex(xchacha20poly1305(contentKey, nonce).encrypt(plaintext)),
  };
}

export function decryptContent(contentKey: Uint8Array, blob: SealedBlob): Uint8Array {
  return xchacha20poly1305(contentKey, fromHex(blob.nonce)).decrypt(fromHex(blob.ciphertext));
}
