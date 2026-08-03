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

export interface Argon2idParams {
  readonly m: number;
  readonly t: number;
  readonly p: number;
  readonly dkLen: number;
}

/**
 * §9.3 names two points, and which one applies is a property of the machine, not of the vault.
 *
 * `m`, `t` and `p` describe ONE analysed point each; lowering any of them while claiming to meet
 * a profile is how a parameter set gets quietly weakened, so the profiles are whole values rather
 * than three independently tunable knobs.
 *
 * **Why memory and not iterations.** This passphrase does not guard content — `PersonaRecord`'s
 * `private_key` is sealed under the same content key every record is, so what the passphrase
 * guards is the IDENTITIES. Memory is the only parameter that cuts an attacker's parallelism:
 * a 24 GB GPU holds roughly 350 concurrent instances at 64 MiB and roughly 22 at 1 GiB. Raising
 * `t` costs the attacker and the owner in the same proportion; raising `m` does not.
 *
 * 64 MiB was RFC 9106's constrained-device point, and it stays here under that name — a phone or
 * a container with a hard memory limit is a real deployment, and naming it explicitly is better
 * than a silent fallback. It is the FLOOR: nothing conforming goes below it.
 */
export const ARGON2ID_DESKTOP: Argon2idParams = { m: 1048576, t: 2, p: 4, dkLen: 32 };
export const ARGON2ID_CONSTRAINED: Argon2idParams = { m: 65536, t: 3, p: 1, dkLen: 32 };

/** What a new wrap is made at unless the caller names the constrained profile. */
export const ARGON2ID_PARAMS = ARGON2ID_DESKTOP;

/**
 * The most Argon2id memory this code will allocate to open somebody else's keyset.
 *
 * §9.3 fixes the cost a NEW wrap is made at; nothing bounded the cost an EXISTING one may ask for,
 * and a keyset arrives over §6.6 recovery and over import. Twice the desktop profile: enough that
 * a raise beyond today's point is not foreclosed, small enough that a hostile keyset cannot name
 * a number the machine will try to serve. A further raise moves this constant deliberately, which
 * is right — it is a real commitment of the opener's memory, not a formality.
 */
export const MAX_UNWRAP_MEMORY_KIB = ARGON2ID_DESKTOP.m * 2;

/**
 * The most Argon2id WORK a single call to open a keyset may cost, in KiB-passes (m·t·p).
 *
 * The memory ceiling above bounds one parameter of three, and it is the one that announces
 * itself: a wrap naming 4 GiB fails to allocate. Cost is m·t·p, so `t` was the parameter with no
 * bound at all — at the memory ceiling, `t = 1e6` is thousands of CPU-hours per open, declared in
 * four bytes of JSON that no schema objected to. `p` multiplies identically and needs no extra
 * memory. And the candidate COUNT multiplies both, because every passphrase wrap is tried in
 * turn: twenty conforming wraps cost twenty derivations before the failure is even reported.
 *
 * So the bound is stated over the whole call rather than per wrap — opening a keyset costs at
 * most what one maximal conforming wrap costs — which is the only form that bounds all three
 * factors, since it is their product that hurts.
 *
 * Twice the desktop profile, which is the same headroom the memory ceiling carries and for the
 * same reason: §9.3 permits a raise, so a ceiling that refused one would bound conformance rather
 * than an attacker — but a desktop open already costs seconds, so the multiplier has to be small
 * or the bound stops bounding anything a person would notice.
 */
export const MAX_UNWRAP_WORK =
  ARGON2ID_DESKTOP.m * ARGON2ID_DESKTOP.t * ARGON2ID_DESKTOP.p * 2;

/**
 * How many passphrase wraps an open will consider at all, checked before a single derivation.
 *
 * The work budget bounds the total, but it is only ever reached by SPENDING it: sixty-four
 * conforming wraps stay inside it until the sixty-fourth, which is sixty-four real derivations
 * before anything is refused. A budget you have to pay to discover is a poor bound, and the
 * length of a list costs nothing to read. Eight is far past what a real vault carries — a
 * passphrase slot and a recovery slot is the normal shape — and refusing outright rather than
 * truncating keeps this from silently ignoring a wrap that would have opened.
 */
export const MAX_PASSPHRASE_CANDIDATES = 8;

/** §9.3: "The salt MUST be at least 128 bits, fresh per wrap, from a CSPRNG". */
export const MIN_SALT_BYTES = 16;

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
  v: 'servanda/0.2';
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
    dkLen: ARGON2ID_PARAMS.dkLen, // 32 in every profile; the KEK is an XChaCha20 key
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
  params: Argon2idParams = ARGON2ID_PARAMS,
): WrappedKey {
  if (passphrase.length === 0) {
    throw new EmptyPassphrase('M-16: a passphrase wrap made with an empty passphrase protects nothing');
  }
  assertConformingProfile(params);
  const salt = randomBytes(SALT_BYTES);
  const kek = deriveKeyFromPassphrase(passphrase, salt, params);
  const { nonce, ciphertext } = wrapWith(kek, contentKey);
  return {
    kind: 'passphrase',
    label,
    nonce,
    ciphertext,
    kdf: { algo: 'argon2id', salt: toHex(salt), m: params.m, t: params.t, p: params.p },
  };
}

/**
 * §9.3's floor, enforced where a wrap is MADE.
 *
 * The ceilings elsewhere in this file refuse a hostile keyset; this refuses our own code writing
 * a weak one. It is deliberately not applied on the read path: a wrap already made below the
 * floor protects a key that is already wrapped, and refusing to open it would strand the vault
 * rather than the attacker. Weakening on write is preventable; weakening already done is not
 * undone by locking the owner out.
 */
export function assertConformingProfile(params: Argon2idParams): void {
  const floor = ARGON2ID_CONSTRAINED;
  // TWO conditions, and not one per axis. The desktop profile has t = 2 against the constrained
  // profile's t = 3, so a per-axis floor would reject the very point §9.3 recommends — the
  // parameters are one analysed value each, not three independent dials, which is the whole
  // reason the profiles are named rather than assembled.
  //
  // Total work is the first condition because it is what a guess costs an attacker. Memory is the
  // second and separate one because it is the only parameter that cuts their PARALLELISM: without
  // it, a profile could buy its way to the work floor with iterations alone and be far weaker
  // against the hardware that actually does this.
  if (params.m < floor.m) {
    throw new Error(`§9.3: m = ${params.m} KiB is below the floor of ${floor.m} KiB`);
  }
  const work = params.m * params.t * params.p;
  const floorWork = floor.m * floor.t * floor.p;
  if (work < floorWork) {
    throw new Error(`§9.3: m·t·p = ${work} is below the floor of ${floorWork}`);
  }

  // And the CEILINGS, because the write path and the read path have to agree about what a wrap is.
  //
  // This checked only the floor while `unwrapWithPassphrase` enforces `MAX_UNWRAP_MEMORY_KIB` and
  // `MAX_UNWRAP_WORK`, and nothing looked at the gap between them. `upgradeKdf` would therefore
  // happily write a keyset that its own `Vault.open` refuses — `{m: 2 GiB, t: 3, p: 4}` is a plain
  // §9.3 "raise m and t" and is unopenable by any credential. The vault bricks silently and the
  // owner finds out at the next open, by which time the old keyset is only recoverable from git.
  //
  // A parameter set nobody can open is not a strong parameter set.
  if (params.m > MAX_UNWRAP_MEMORY_KIB) {
    throw new Error(
      `refusing to write a wrap at m = ${params.m} KiB; no open would allocate past ${MAX_UNWRAP_MEMORY_KIB} KiB`,
    );
  }
  if (work > MAX_UNWRAP_WORK) {
    throw new Error(
      `refusing to write a wrap costing ${work} KiB-passes; no open would spend past ${MAX_UNWRAP_WORK}`,
    );
  }
}

/**
 * Re-wrap a keyset's passphrase slots at `params`, keeping the same content key.
 *
 * §9.3 says an implementation MAY raise `m` or `t`. Until this existed that permission was
 * empty: a wrap is opened with its OWN stored parameters, so the value a vault was created at was
 * the value for its whole life, and "MAY raise" described something no code could do. Every
 * device wrap is carried through untouched — the content key does not change, so they still open.
 *
 * Deliberately not automatic on open. Rewriting key material is not a side effect a caller should
 * discover afterwards, and an open that silently costs six seconds more than the last one is a
 * bug report. `kdfProfileOf` reports; this acts.
 */
export function rewrapPassphrase(
  keyset: ContentKeySet,
  passphrase: string,
  params: Argon2idParams = ARGON2ID_PARAMS,
): ContentKeySet {
  const contentKey = unwrapWithPassphrase(keyset, passphrase);
  const wraps = keyset.wraps.map((w) =>
    w.kind === 'passphrase' ? wrapForPassphrase(contentKey, passphrase, w.label, params) : w,
  );
  return sealContentKey(contentKey, wraps);
}

/** The weakest passphrase wrap in a keyset, by total work. Null when there is none. */
export function kdfProfileOf(keyset: ContentKeySet): { m: number; t: number; p: number } | null {
  const kdfs = keyset.wraps.flatMap((w) => (w.kind === 'passphrase' && w.kdf ? [w.kdf] : []));
  if (kdfs.length === 0) return null;
  return kdfs.reduce((weakest, k) => (k.m * k.t * k.p < weakest.m * weakest.t * weakest.p ? k : weakest));
}

/**
 * What to tell the owner of a vault whose passphrase wrap is weaker than the one this build makes.
 *
 * `kdfProfileOf` answers the question and answers it in numbers, which is the right shape for a
 * caller and the wrong one for a person: `{m: 65536, t: 3, p: 1}` is not a sentence, and the
 * `behindDefault: true` that `Vault.kdfProfile` adds to it was reaching nobody at all. A vault made
 * by an older build stays at the profile it was made at for its whole life — that is what storing
 * the parameters per wrap MEANS — so "weaker than today's" is a permanent state that nothing was
 * going to announce.
 *
 * Three things this has to say, and it is the third that makes the first two worth saying:
 *
 *   - It is weaker, and by how much, in a unit somebody can weigh.
 *   - Nothing is on fire. A warning that reads like a breach gets a vault deleted at 2am.
 *   - The exact command that fixes it. `rewrapPassphrase` has existed since the raise landed and
 *     no surface named it, which is a permission nobody could exercise — the same shape of defect
 *     as §9.3's "MAY raise" before `rewrapPassphrase` existed at all.
 *
 * `howToFix` is the caller's because the command differs per surface, and a sentence that told
 * every reader to run the same binary would be wrong for most of them. The word "Argon2id" appears
 * once, in the last line and in brackets: the reader who knows it wants the numbers, and the reader
 * who does not must never need it to understand what to do.
 *
 * Returns null when there is nothing to say — no passphrase wrap, or one at or above today's
 * profile. Null rather than an empty string so a caller cannot print a blank line for a vault that
 * is fine.
 */
export function kdfAdvisory(
  profile: { m: number; t: number; p: number } | null,
  howToFix: string,
): string | null {
  if (profile === null) return null;
  const current = ARGON2ID_PARAMS;
  const work = profile.m * profile.t * profile.p;
  const currentWork = current.m * current.t * current.p;
  if (work >= currentWork) return null;

  // Memory and work are reported separately because they buy different things, and the gap between
  // them is the point §9.3 is making: the published 0.4.0-pre floor is 16× less memory but only
  // ~43× less work, and it is the memory factor that decides how many guesses fit on one GPU.
  const times = (ratio: number): string => (ratio >= 10 ? `${Math.round(ratio)}` : ratio.toFixed(1));
  const memoryFactor = times(current.m / profile.m);
  const workFactor = times(currentWork / work);

  return (
    "This vault's key was made by an older build of servanda, and it is weaker than the one this " +
    'build makes.\n' +
    '\n' +
    'Nothing has leaked and nothing is broken — the vault opens normally and its contents are as ' +
    'private today as they were yesterday. What is weaker is GUESSING: somebody who takes a copy ' +
    `of this directory and tries passphrases against it needs about ${memoryFactor}× less memory ` +
    `and about ${workFactor}× less work per guess than they would against a vault made today.\n` +
    '\n' +
    'To raise it — about a minute, asks for the same passphrase, changes nothing else about the ' +
    'vault:\n' +
    '\n' +
    `  ${howToFix}\n` +
    '\n' +
    `(Argon2id m=${profile.m} t=${profile.t} p=${profile.p}; this build makes m=${current.m} ` +
    `t=${current.t} p=${current.p}.)\n`
  );
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
  return { v: 'servanda/0.2', type: 'content_keyset', wraps };
}

/** M-16 check, exported so vault code and the M-suite can assert on the same predicate. */
export function assertM16(wraps: WrappedKey[]): void {
  // A wrap counts toward M-16 only if it could actually be OPENED. `kind: 'passphrase'` is a
  // label, and the check was reading the label.
  //
  // The attack this morning's fix was written for was deleting the passphrase wrap outright. One
  // step further: delete its `kdf` and leave the wrap in place. `unwrapWithPassphrase` skips a
  // wrap with no `kdf` (`if (!wrap.kdf) continue`), so the passphrase opens nothing and the device
  // key opens everything — sole custody, with a keyset that satisfied the custody check. The
  // guard has to ask whether the passphrase route still exists, not whether something claims it.
  //
  // Structural validity is as far as this can go without the passphrase itself: a wrap whose
  // CIPHERTEXT has been corrupted is indistinguishable from a good one here, and its owner finds
  // out on the next open. That limit is real and is why this checks what it can rather than
  // implying more.
  const usable = wraps.some(
    (w) =>
      w.kind === 'passphrase' &&
      w.kdf !== undefined &&
      w.kdf.algo === 'argon2id' &&
      [w.kdf.m, w.kdf.t, w.kdf.p].every((n) => Number.isSafeInteger(n) && n >= 1) &&
      w.kdf.salt.length >= MIN_SALT_BYTES * 2 &&
      typeof w.ciphertext === 'string' &&
      w.ciphertext.length > 0,
  );
  if (!usable) {
    throw new M16Violation(
      'M-16: a device key MUST NOT be sole custodian of the vault content key; ' +
        'at least one passphrase wrap that can actually be opened is required',
    );
  }
}

function unwrapWith(key: Uint8Array, wrap: WrappedKey): Uint8Array {
  return xchacha20poly1305(key, fromHex(wrap.nonce)).decrypt(fromHex(wrap.ciphertext));
}

/**
 * Everything a wrap's declared KDF parameters must satisfy before this process will spend
 * anything on them. Throws rather than skipping the wrap: a keyset naming a cost nobody can pay
 * is hostile, and moving on to the next candidate is what it wants. `remainingWork` is the
 * call's unspent budget, so the last check is the one that bounds the candidate count too.
 */
function assertSpendable(kdf: NonNullable<WrappedKey['kdf']>, remainingWork: number): number {
  for (const [name, value] of [['m', kdf.m], ['t', kdf.t], ['p', kdf.p]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`refusing a wrap whose Argon2id ${name} is not a positive integer: ${value}`);
    }
  }
  if (fromHex(kdf.salt).length < MIN_SALT_BYTES) {
    throw new Error(
      `refusing a wrap whose salt is under the §9.3 minimum of ${MIN_SALT_BYTES * 8} bits`,
    );
  }
  // Memory and work are different resources and both are bounded: `m` is what gets allocated at
  // once, m·t·p is what gets spent over time. A wrap can be modest in one and absurd in the other.
  if (kdf.m > MAX_UNWRAP_MEMORY_KIB) {
    throw new Error(
      `refusing a wrap demanding ${kdf.m} KiB of Argon2id memory; the ceiling is ${MAX_UNWRAP_MEMORY_KIB} KiB`,
    );
  }
  const cost = kdf.m * kdf.t * kdf.p;
  if (cost > remainingWork) {
    throw new Error(
      `refusing a wrap demanding ${cost} KiB-passes of Argon2id work; ${remainingWork} remain of a ${MAX_UNWRAP_WORK} budget for this open`,
    );
  }
  return remainingWork - cost;
}

export function unwrapWithPassphrase(keyset: ContentKeySet, passphrase: string, label?: string): Uint8Array {
  const candidates = keyset.wraps.filter(
    (w) => w.kind === 'passphrase' && (label === undefined || w.label === label),
  );
  if (candidates.length > MAX_PASSPHRASE_CANDIDATES) {
    throw new Error(
      `refusing a keyset offering ${candidates.length} passphrase wraps; more Argon2id work than ${MAX_PASSPHRASE_CANDIDATES} slots is not an open, it is a stall`,
    );
  }
  let budget = MAX_UNWRAP_WORK;
  for (const wrap of candidates) {
    if (!wrap.kdf) continue;
    // The wrap's own parameters, not today's: a vault made before the cost was raised must still
    // open, and deriving with the current constants would tell its owner the passphrase is wrong.
    //
    // Bounded above, because a keyset is not always your own: recovery and import paths hand this
    // function a structure that came from somewhere else. Reading a LOWER cost than today's is
    // harmless — it only ever weakens a key that is already wrapped, and stranding those vaults is
    // the failure this whole path exists to avoid — so only the ceilings are guarded, and they
    // refuse rather than clamp, because silently deriving with different parameters than the wrap
    // names is exactly the bug above.
    budget = assertSpendable(wrap.kdf, budget);
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

/**
 * `aad` is authenticated but NOT encrypted and NOT stored — the caller recomputes it from the
 * context the ciphertext was found in. That is what makes it a binding rather than a label: a
 * value carried alongside the ciphertext would travel with it, and an attacker relocating the
 * record would relocate its AAD too.
 */
export function encryptContent(
  contentKey: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): SealedBlob {
  const nonce = randomBytes(XCHACHA_NONCE_BYTES);
  return {
    nonce: toHex(nonce),
    ciphertext: toHex(xchacha20poly1305(contentKey, nonce, aad).encrypt(plaintext)),
  };
}

export function decryptContent(
  contentKey: Uint8Array,
  blob: SealedBlob,
  aad?: Uint8Array,
): Uint8Array {
  return xchacha20poly1305(contentKey, fromHex(blob.nonce), aad).decrypt(fromHex(blob.ciphertext));
}
