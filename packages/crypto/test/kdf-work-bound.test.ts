import { describe, expect, it } from 'vitest';

import {
  ARGON2ID_CONSTRAINED,
  ARGON2ID_PARAMS,
  MAX_PASSPHRASE_CANDIDATES,
  MAX_UNWRAP_WORK,
  MIN_SALT_BYTES,
  type ContentKeySet,
  generateContentKey,
  unwrapWithPassphrase,
  wrapForPassphrase,
} from '../src/content-key.js';

/**
 * Every wrap in this file at the §9.3 constrained-device profile. The desktop default is
 * m = 1 GiB — right for a real vault, and minutes of Argon2id across a file that wraps a key
 * a few dozen times. Nothing here is testing the profile; the cases that do call
 * `wrapForPassphrase` directly.
 */
const wrapAtFloor = (key: Uint8Array, passphrase: string, label?: string) =>
  wrapForPassphrase(key, passphrase, label, ARGON2ID_CONSTRAINED);


/**
 * `MAX_UNWRAP_MEMORY_KIB` capped `m` and nothing else, and `m` is the one parameter that
 * announces itself — a wrap naming 4 GiB fails to allocate. The cost of Argon2id is m·t·p, so
 * `t` was the unbounded one: at the memory ceiling, `t = 1e6` is thousands of CPU-hours per
 * open, declared in four bytes of JSON. `p` multiplies the same way, and neither needs a byte
 * more memory than a conforming wrap.
 *
 * The wrap COUNT is the third factor and it multiplies the other two: `unwrapWithPassphrase`
 * tries every passphrase candidate in turn, so twenty conforming wraps cost twenty derivations
 * before the failure is reported. A bound on one wrap is not a bound on an open.
 *
 * So the rule is stated over the whole call: opening a keyset costs at most what one maximal
 * conforming wrap costs. That one number bounds `t`, `p` and the candidate count together,
 * which is what the three of them multiplying required.
 */

const PASSPHRASE = 'correct horse battery staple';

function keysetOf(wraps: ContentKeySet['wraps']): ContentKeySet {
  return { v: 'servanda/0.2', type: 'content_keyset', wraps };
}

/** A wrap that opens, then re-declared with hostile parameters it was never made at. */
function declaring(kdf: Partial<{ m: number; t: number; p: number; salt: string }>) {
  const wrap = wrapAtFloor(generateContentKey(), PASSPHRASE);
  return { ...wrap, kdf: { ...wrap.kdf!, ...kdf } };
}

describe('§9.3 unwrap is bounded in total work, not only in memory', () => {
  it('refuses a wrap whose `t` puts it past the work ceiling', () => {
    const hostile = declaring({ t: 1_000_000 });
    expect(() => unwrapWithPassphrase(keysetOf([hostile]), PASSPHRASE)).toThrow(/work/);
  });

  it('refuses a wrap whose `p` does the same, at identical memory', () => {
    const hostile = declaring({ p: 100_000 });
    expect(() => unwrapWithPassphrase(keysetOf([hostile]), PASSPHRASE)).toThrow(/work/);
  });

  it('refuses a keyset whose wraps are each conforming but collectively are not', () => {
    // Every one of these declares exactly the §9.3 parameter set. None is refusable on its own,
    // which is the whole point: the attack is the length of the list. Cloned rather than derived
    // — building 200 real wraps costs the same half-minute the bound exists to refuse.
    const one = wrapAtFloor(generateContentKey(), PASSPHRASE);
    const many = Array.from({ length: 200 }, (_v, i) => ({
      ...one,
      label: `slot-${i}`,
      kdf: { ...one.kdf!, salt: i.toString(16).padStart(32, '0') },
    }));
    expect(() => unwrapWithPassphrase(keysetOf(many), PASSPHRASE)).toThrow(/passphrase wraps/);
  });

  it('and refuses the long list before deriving anything, not after paying for it', () => {
    const one = wrapAtFloor(generateContentKey(), PASSPHRASE);
    const many = Array.from({ length: MAX_PASSPHRASE_CANDIDATES + 1 }, (_v, i) => ({
      ...one,
      label: `slot-${i}`,
      kdf: { ...one.kdf!, salt: i.toString(16).padStart(32, '0') },
    }));
    // One derivation at the §9.3 point is ~100 ms; nine would be a second of wall clock. The
    // refusal reads the length of a list, so it costs none of them. Generous enough that a slow
    // machine does not make this flaky, tight enough that deriving even twice would fail it.
    const started = performance.now();
    expect(() => unwrapWithPassphrase(keysetOf(many), PASSPHRASE)).toThrow();
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('refuses a salt below the §9.3 minimum of 128 bits', () => {
    expect(() => unwrapWithPassphrase(keysetOf([declaring({ salt: 'ab'.repeat(8) })]), PASSPHRASE)).toThrow(
      /salt/,
    );
    expect(MIN_SALT_BYTES).toBe(16);
  });

  it('refuses parameters that are not positive integers at all', () => {
    for (const kdf of [{ t: 0 }, { t: -1 }, { p: 1.5 }, { m: Number.NaN }]) {
      expect(() => unwrapWithPassphrase(keysetOf([declaring(kdf)]), PASSPHRASE), JSON.stringify(kdf)).toThrow();
    }
  });

  it('leaves a real keyset alone: the honest open is far under the ceiling', () => {
    const { m, t, p } = ARGON2ID_PARAMS;
    expect(m * t * p).toBeLessThan(MAX_UNWRAP_WORK);

    const key = generateContentKey();
    const wraps = [wrapAtFloor(key, PASSPHRASE, 'primary'), wrapAtFloor(key, PASSPHRASE, 'recovery')];
    expect(unwrapWithPassphrase(keysetOf(wraps), PASSPHRASE)).toEqual(key);
  });

  it('the ceiling leaves room for a stronger profile than today’s', () => {
    // §9.3 says an implementation MAY raise `m` or `t`; a ceiling that forbade the raise it
    // permits would be a bound on conformance rather than on an attacker. RFC 9106's
    // memory-heavy option (1 GiB, t = 2, p = 4) fits.
    expect(1024 * 1024 * 2 * 4).toBeLessThanOrEqual(MAX_UNWRAP_WORK);
  });
});
