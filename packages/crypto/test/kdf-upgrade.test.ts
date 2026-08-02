import { describe, expect, it } from 'vitest';
import {
  ARGON2ID_CONSTRAINED,
  ARGON2ID_DESKTOP,
  generateContentKey,
  kdfProfileOf,
  rewrapPassphrase,
  sealContentKey,
  unwrapWithDevice,
  unwrapWithPassphrase,
  wrapForDevice,
  wrapForPassphrase,
} from '../src/content-key.js';
import { GENERATED_PASSPHRASE_BITS, generatePassphrase } from '../src/mnemonic.js';
import { toHex } from '../src/hash.js';

/**
 * §9.3: "An implementation MAY raise `m` or `t`."
 *
 * That permission was empty for as long as it existed. A wrap is opened with its OWN stored
 * parameters — which is the right rule, and is what keeps a raise from stranding an existing
 * vault — but with no way to re-wrap, the value a vault was created at was the value for the rest
 * of its life. "MAY raise" described something no code could do, and the note in the source saying
 * a later raise "does not strand an existing vault" was true only because the raise was impossible.
 */

const PASSPHRASE = 'correct horse battery staple';
const DEVICE_KEY = '11'.repeat(32);

/**
 * A raise, not THE raise. What these cases test is the mechanism — that a wrap can be re-made at
 * a profile it was not created at — and that is a property of any two distinct conforming
 * profiles. Deriving at the real desktop point (m = 1 GiB) costs seconds a piece and would prove
 * nothing extra; the one thing that genuinely needs the real constant is asserted below without
 * deriving anything at all.
 */
const RAISED = { m: 131072, t: 3, p: 1, dkLen: 32 } as const;

function constrainedKeyset() {
  const key = generateContentKey();
  return {
    key,
    keyset: sealContentKey(key, [
      wrapForPassphrase(key, PASSPHRASE, 'passphrase', ARGON2ID_CONSTRAINED),
      wrapForDevice(key, DEVICE_KEY, 'laptop'),
    ]),
  };
}

describe('§9.3 a passphrase wrap can be raised to a stronger profile', () => {
  it('reports the profile a keyset was made at', () => {
    const { keyset } = constrainedKeyset();
    expect(kdfProfileOf(keyset)).toMatchObject({ m: 65536, t: 3, p: 1 });
  });

  it('re-wraps at the new profile and still opens with the same passphrase', () => {
    const { key, keyset } = constrainedKeyset();
    const raised = rewrapPassphrase(keyset, PASSPHRASE, RAISED);

    expect(kdfProfileOf(raised)).toMatchObject({ m: RAISED.m, t: RAISED.t, p: RAISED.p });
    expect(toHex(unwrapWithPassphrase(raised, PASSPHRASE))).toBe(toHex(key));
  });

  it('keeps the content key, so every device wrap still opens', () => {
    // The distinction that makes this cheap: raising the KDF changes the key-ENCRYPTION key, not
    // the content key. A device wrap does not carry KDF parameters and does not need re-making,
    // and — more to the point — the device keys are not available to re-make them with.
    const { key, keyset } = constrainedKeyset();
    const raised = rewrapPassphrase(keyset, PASSPHRASE, RAISED);

    expect(toHex(unwrapWithDevice(raised, DEVICE_KEY, 'laptop'))).toBe(toHex(key));
    expect(raised.wraps.filter((w) => w.kind === 'device')).toEqual(
      keyset.wraps.filter((w) => w.kind === 'device'),
    );
  });

  it('draws a fresh salt, so the new wrap is not the old one re-labelled', () => {
    const { keyset } = constrainedKeyset();
    const raised = rewrapPassphrase(keyset, PASSPHRASE, RAISED);
    const saltOf = (k: typeof keyset) => k.wraps.find((w) => w.kind === 'passphrase')!.kdf!.salt;
    expect(saltOf(raised)).not.toBe(saltOf(keyset));
  });

  it('refuses the wrong passphrase rather than producing an unopenable keyset', () => {
    const { keyset } = constrainedKeyset();
    expect(() => rewrapPassphrase(keyset, 'wrong', RAISED)).toThrow();
  });

  it('the shipped desktop profile is a legal target for this path', () => {
    // The constant, not a derivation: what a raise to m = 1 GiB proves about the MECHANISM is
    // exactly what `RAISED` proves, and it proves it in a third of a second rather than six.
    // What only the real value can show is that it clears the floor the re-wrap path enforces.
    expect(() => rewrapPassphrase({ v: 'servanda/0.2', type: 'content_keyset', wraps: [] }, PASSPHRASE, ARGON2ID_DESKTOP))
      .toThrow(/M-16|passphrase wrap/);
    const work = (k: { m: number; t: number; p: number }) => k.m * k.t * k.p;
    expect(ARGON2ID_DESKTOP.m).toBeGreaterThanOrEqual(ARGON2ID_CONSTRAINED.m);
    expect(work(ARGON2ID_DESKTOP)).toBeGreaterThan(work(ARGON2ID_CONSTRAINED));
  });

  it('cannot be used to lower a vault below the §9.3 floor', () => {
    const { keyset } = constrainedKeyset();
    expect(() => rewrapPassphrase(keyset, PASSPHRASE, { m: 8, t: 1, p: 1, dkLen: 32 })).toThrow(/§9.3/);
  });
});

describe('§9.3 a generated passphrase carries the entropy the KDF assumes', () => {
  it('is at least 128 bits', () => {
    expect(GENERATED_PASSPHRASE_BITS).toBeGreaterThanOrEqual(128);
    expect(generatePassphrase().split(' ')).toHaveLength(12);
  });

  it('is drawn fresh every time', () => {
    // Not a proof of randomness — a check that the draw happens per call rather than once at
    // module load, which is the way a generator silently becomes a constant.
    const drawn = new Set(Array.from({ length: 20 }, () => generatePassphrase()));
    expect(drawn.size).toBe(20);
  });

  it('refuses to generate below the floor rather than returning something short', () => {
    expect(() => generatePassphrase(8)).toThrow(/128/);
  });
});
