import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ARGON2ID_CONSTRAINED,
  ARGON2ID_DESKTOP,
  M16Violation,
  generateContentKey,
  sealContentKey,
  wrapForDevice,
  wrapForPassphrase,
} from '@servanda/crypto';
import { Vault } from '@servanda/vault';
import { makeFixture, TEST_PASSPHRASE, type Fixture } from '../support/fixture.js';

/**
 * M-16 — A device key MUST NOT be sole custodian of vault content keys.
 *
 * Owned jointly: @servanda/crypto owns the predicate (`sealContentKey` / `assertM16`), the
 * vault owns the guarantee that no vault can come into existence without going through it.
 */

let fx: Fixture;
beforeAll(() => {
  fx = makeFixture();
});
afterAll(() => fx.cleanup());

const DEVICE_KEY = '11'.repeat(32);

describe('M-16: a device key is never sole custodian of the content key', () => {
  it('every vault this code can create has a passphrase wrap', () => {
    const keyset = fx.vault.keyset();
    expect(keyset.wraps.some((w) => w.kind === 'passphrase')).toBe(true);
  });

  it('a device-only keyset cannot be sealed', () => {
    const key = generateContentKey();
    expect(() => sealContentKey(key, [wrapForDevice(key, DEVICE_KEY, 'laptop')])).toThrow(
      M16Violation,
    );
  });

  it('a device wrap is additive, never a replacement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'servanda-m16-'));
    try {
      const vault = Vault.create({
        kdf: ARGON2ID_CONSTRAINED,
        dir,
        passphrase: TEST_PASSPHRASE,
        deviceKeys: [{ label: 'laptop', keyHex: DEVICE_KEY }],
      });
      const kinds = vault.keyset().wraps.map((w) => w.kind).sort();
      expect(kinds).toEqual(['device', 'passphrase']);

      // Both custodians can open it independently; losing the device does not lose the vault.
      expect(() => Vault.open({ dir, passphrase: TEST_PASSPHRASE })).not.toThrow();
      expect(() => Vault.open({ dir, deviceKey: { keyHex: DEVICE_KEY, label: 'laptop' } })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('a passphrase wrap records the §9.3 profile it was made at', () => {
    // §9.3 names two points and the default is the desktop one. Both are asserted, because the
    // parameters are stored PER WRAP and that is what makes a later raise possible at all — a
    // wrap is opened with its own values, never with today's.
    const key = generateContentKey();
    expect(wrapForPassphrase(key, 'a passphrase').kdf).toMatchObject({
      algo: 'argon2id',
      m: ARGON2ID_DESKTOP.m,
      t: ARGON2ID_DESKTOP.t,
      p: ARGON2ID_DESKTOP.p,
    });
    expect(wrapForPassphrase(key, 'a passphrase', 'slot', ARGON2ID_CONSTRAINED).kdf).toMatchObject({
      m: 65536,
      t: 3,
      p: 1,
    });
  });

  it('refuses to make a wrap below the §9.3 floor', () => {
    // The ceilings elsewhere refuse a hostile keyset; this refuses our own code writing a weak
    // one. `MUST NOT lower` had been a write-path rule with nothing enforcing it on the write path.
    expect(() =>
      wrapForPassphrase(generateContentKey(), 'a passphrase', 'weak', { m: 8, t: 1, p: 1, dkLen: 32 }),
    ).toThrow(/§9.3/);
  });

  /**
   * The API-surface case below proves that no code path here BUILDS a device-only keyset. It
   * cannot prove anything about a keyset that already exists, and `keyset.json` is plain,
   * unsigned JSON in a directory its owner can write. Deleting the passphrase wrap left a file
   * that satisfies every schema and violates M-16, and opening it with the device key worked —
   * because the rule was a constructor check and M-16 is stated as a property of custody, which
   * a vault has at rest and not only at the instant it is created.
   */
  it('a keyset stripped of its passphrase wrap does not open, whatever key is offered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'servanda-m16-strip-'));
    try {
      Vault.create({
        kdf: ARGON2ID_CONSTRAINED,
        dir,
        passphrase: TEST_PASSPHRASE,
        deviceKeys: [{ label: 'laptop', keyHex: DEVICE_KEY }],
      });
      const path = join(dir, 'keyset.json');
      const keyset = JSON.parse(readFileSync(path, 'utf8')) as { wraps: { kind: string }[] };
      keyset.wraps = keyset.wraps.filter((w) => w.kind !== 'passphrase');
      writeFileSync(path, JSON.stringify(keyset));

      expect(() => Vault.open({ dir, deviceKey: { keyHex: DEVICE_KEY, label: 'laptop' } })).toThrow(
        M16Violation,
      );
      // And the check is on custody, not on which key was offered: the same file is refused
      // before a passphrase is even tried.
      expect(() => Vault.open({ dir, passphrase: TEST_PASSPHRASE })).toThrow(M16Violation);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('the vault exposes no path to a keyset that bypasses sealContentKey', () => {
    const surface = Object.getOwnPropertyNames(Vault).concat(
      Object.getOwnPropertyNames(Vault.prototype),
    );
    // `create` is the only constructor of a keyset, and it always builds a passphrase wrap.
    expect(surface.filter((n) => /keyset|wrap/i.test(n))).toEqual(['keyset']);
  });
});
