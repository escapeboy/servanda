import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
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

  it('the passphrase wrap uses the §9.3 Argon2id parameters', () => {
    const key = generateContentKey();
    const wrap = wrapForPassphrase(key, 'a passphrase');
    expect(wrap.kdf).toMatchObject({ algo: 'argon2id', m: 65536, t: 3, p: 1 });
  });

  it('the vault exposes no path to a keyset that bypasses sealContentKey', () => {
    const surface = Object.getOwnPropertyNames(Vault).concat(
      Object.getOwnPropertyNames(Vault.prototype),
    );
    // `create` is the only constructor of a keyset, and it always builds a passphrase wrap.
    expect(surface.filter((n) => /keyset|wrap/i.test(n))).toEqual(['keyset']);
  });
});
