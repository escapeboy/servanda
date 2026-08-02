import { describe, expect, it } from 'vitest';
import {
  ARGON2ID_CONSTRAINED,
  ARGON2ID_DESKTOP,
  MAX_UNWRAP_MEMORY_KIB,
  MAX_UNWRAP_WORK,
  M16Violation,
  assertConformingProfile,
  assertM16,
  generateContentKey,
  rewrapPassphrase,
  sealContentKey,
  unwrapWithPassphrase,
  wrapForDevice,
  wrapForPassphrase,
} from '../src/content-key.js';

/**
 * Two guards written earlier the same day, and the step past each of them.
 *
 * **M-16 was reading a label.** `assertM16` asked whether some wrap had `kind: 'passphrase'`. The
 * attack it was written for was deleting the passphrase wrap; one step further is to leave the
 * wrap and delete its `kdf`. `unwrapWithPassphrase` skips a wrap with no `kdf`, so the passphrase
 * opens nothing, the device key opens everything, and the keyset passes the custody check — sole
 * custody, which is the exact thing M-16 forbids.
 *
 * **The write path and the read path disagreed about what a wrap is.** The write path checked only
 * §9.3's floor; the read path enforces a memory ceiling and a work budget. Nothing looked at the
 * gap, so `upgradeKdf` would write a keyset its own `Vault.open` refuses. A parameter set nobody
 * can open is not a strong parameter set.
 */

const PASSPHRASE = 'correct horse battery staple';
const DEVICE_KEY = '11'.repeat(32);

function keysetWith(mutate: (w: ReturnType<typeof wrapForPassphrase>) => void) {
  const key = generateContentKey();
  const pass = wrapForPassphrase(key, PASSPHRASE, 'passphrase', ARGON2ID_CONSTRAINED);
  mutate(pass);
  return { key, wraps: [pass, wrapForDevice(key, DEVICE_KEY, 'laptop')] };
}

describe('M-16 asks whether the passphrase route exists, not whether something claims it', () => {
  it('a passphrase wrap with its `kdf` deleted is not custody', () => {
    const { wraps } = keysetWith((w) => {
      delete (w as { kdf?: unknown }).kdf;
    });
    expect(() => assertM16(wraps)).toThrow(M16Violation);
  });

  it('nor one whose `kdf` names a salt too short to be one', () => {
    const { wraps } = keysetWith((w) => {
      w.kdf!.salt = 'ab';
    });
    expect(() => assertM16(wraps)).toThrow(M16Violation);
  });

  it('nor one whose parameters are not positive integers', () => {
    const { wraps } = keysetWith((w) => {
      w.kdf!.t = 0;
    });
    expect(() => assertM16(wraps)).toThrow(M16Violation);
  });

  it('nor one with no ciphertext to open', () => {
    const { wraps } = keysetWith((w) => {
      w.ciphertext = '';
    });
    expect(() => assertM16(wraps)).toThrow(M16Violation);
  });

  it('a real passphrase wrap still is', () => {
    // The control. A guard that refused every keyset would pass all four negatives above.
    const { key, wraps } = keysetWith(() => {});
    expect(() => assertM16(wraps)).not.toThrow();
    expect(unwrapWithPassphrase(sealContentKey(key, wraps), PASSPHRASE)).toEqual(key);
  });

  it('and what this cannot see is stated rather than implied', () => {
    // A corrupted CIPHERTEXT is indistinguishable from a good wrap without the passphrase itself.
    // The check goes as far as structure and no further, and its owner finds out on the next open.
    const { wraps } = keysetWith((w) => {
      w.ciphertext = 'ff'.repeat(48);
    });
    expect(() => assertM16(wraps)).not.toThrow();
  });
});

describe('§9.3 a wrap is only writable at parameters some open would accept', () => {
  it('refuses a profile past the memory ceiling', () => {
    expect(() =>
      assertConformingProfile({ m: MAX_UNWRAP_MEMORY_KIB + 1, t: 2, p: 1, dkLen: 32 }),
    ).toThrow(/allocate past/);
  });

  it('refuses a profile past the work budget', () => {
    // A plain §9.3 "raise m and t", with `m` exactly at the memory ceiling — and unopenable.
    expect(() => assertConformingProfile({ m: MAX_UNWRAP_MEMORY_KIB, t: 3, p: 4, dkLen: 32 })).toThrow(
      /spend past/,
    );
  });

  it('so `upgradeKdf` can no longer brick a vault', () => {
    const key = generateContentKey();
    const keyset = sealContentKey(key, [
      wrapForPassphrase(key, PASSPHRASE, 'passphrase', ARGON2ID_CONSTRAINED),
    ]);
    expect(() => rewrapPassphrase(keyset, PASSPHRASE, { m: 65536, t: 1, p: 257, dkLen: 32 })).toThrow();
  });

  it('and both shipped profiles remain writable', () => {
    // The control that keeps the ceilings honest: a bound that excluded the values this
    // specification recommends would be a bound on conformance rather than on a mistake.
    expect(() => assertConformingProfile(ARGON2ID_CONSTRAINED)).not.toThrow();
    expect(() => assertConformingProfile(ARGON2ID_DESKTOP)).not.toThrow();
    const work = (k: typeof ARGON2ID_DESKTOP) => k.m * k.t * k.p;
    expect(work(ARGON2ID_DESKTOP)).toBeLessThanOrEqual(MAX_UNWRAP_WORK);
  });
});
