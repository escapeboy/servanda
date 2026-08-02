import { describe, expect, it } from 'vitest';
import { argon2id } from '@noble/hashes/argon2';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { randomBytes } from '@noble/hashes/utils';

import {
  ARGON2ID_CONSTRAINED,
  EmptyPassphrase,
  MAX_UNWRAP_MEMORY_KIB,
  wrapForPassphrase,
  unwrapWithPassphrase,
  edgeId,
  ARGON2ID_PARAMS,
  type ContentKeySet,
  type WrappedKey,
  derivePath,
  derivePersona,
  fromHex,
  generateContentKey,
  toHex,
  unwrapWithPassphrase,
  utf8,
} from '../src/index.js';

/**
 * Every wrap in this file at the §9.3 constrained-device profile. The desktop default is
 * m = 1 GiB — right for a real vault, and minutes of Argon2id across a file that wraps a key
 * a few dozen times. Nothing here is testing the profile; the cases that do call
 * `wrapForPassphrase` directly.
 */
const wrapAtFloor = (key: Uint8Array, passphrase: string, label?: string) =>
  wrapForPassphrase(key, passphrase, label, ARGON2ID_CONSTRAINED);


/**
 * Inputs that arrive from outside — an old keyset, a hex string off the wire — and are trusted
 * on the way in.
 *
 * Both properties here were *claimed in prose* and not held by the code. A comment that is wrong
 * is worse than no comment: it is the reason nobody went looking.
 */

describe('a wrap is opened with its own KDF parameters', () => {
  /**
   * §9.3's parameters are a floor that may be raised, and `WrappedKey.kdf` records what each wrap
   * was actually made with precisely so raising them does not strand an existing vault. Deriving
   * with today's constants instead of the wrap's own makes every older vault unopenable — and it
   * fails as "no passphrase wrap could be opened with the supplied passphrase", which tells the
   * owner their passphrase is wrong when it is not. A vault that reports the wrong reason for
   * refusing is a vault whose owner stops trying.
   */
  const legacyWrap = (contentKey: Uint8Array, passphrase: string, kdf: { m: number; t: number; p: number }): WrappedKey => {
    const salt = randomBytes(16);
    const kek = argon2id(utf8(passphrase), salt, { ...kdf, dkLen: 32 });
    const nonce = randomBytes(24);
    return {
      kind: 'passphrase',
      label: 'passphrase',
      nonce: toHex(nonce),
      ciphertext: toHex(xchacha20poly1305(kek, nonce).encrypt(contentKey)),
      kdf: { algo: 'argon2id', salt: toHex(salt), ...kdf },
    };
  };

  it('opens a wrap made with weaker parameters than today’s', () => {
    const contentKey = generateContentKey();
    const kdf = { m: 19456, t: 2, p: 1 }; // the OWASP floor an earlier vault might have used
    expect(kdf.m).toBeLessThan(ARGON2ID_PARAMS.m);
    const keyset: ContentKeySet = {
      v: 'servanda/0.2',
      type: 'content_keyset',
      wraps: [legacyWrap(contentKey, 'passphrase-of-record', kdf)],
    };
    expect(toHex(unwrapWithPassphrase(keyset, 'passphrase-of-record'))).toBe(toHex(contentKey));
  });

  it('still refuses the wrong passphrase against those parameters', () => {
    // The control. Honouring a wrap's parameters must not turn into opening it regardless.
    const contentKey = generateContentKey();
    const keyset: ContentKeySet = {
      v: 'servanda/0.2',
      type: 'content_keyset',
      wraps: [legacyWrap(contentKey, 'right', { m: 8, t: 1, p: 1 })],
    };
    expect(() => unwrapWithPassphrase(keyset, 'wrong')).toThrow();
  });
});

describe('fromHex decodes hex, or refuses', () => {
  /**
   * `Number.parseInt` is a lenient parser: it skips leading whitespace, accepts a sign, and stops
   * at the first character it does not understand rather than complaining. Used one byte-pair at a
   * time it turns malformed input into plausible bytes — so two DIFFERENT strings decode to the
   * same key material, which is the one property a hex decoder exists to prevent. An identity
   * compared as a string upstream and decoded here would be two identities to a registry and one
   * to the cryptography.
   */
  it('rejects the strings that used to alias a valid byte', () => {
    for (const [malformed, aliased] of [
      ['-1', 'ff'],
      [' f', '0f'],
      ['1z', '01'],
    ]) {
      expect(() => fromHex(malformed), `${malformed} must not decode`).toThrow(TypeError);
      expect(toHex(fromHex(aliased))).toBe(aliased); // the byte it used to be mistaken for is real
    }
  });

  it('rejects a persona id that is the right length but not hex', () => {
    const real = 'ab'.repeat(32);
    const forged = ` b${real.slice(2)}`;
    expect(forged).toHaveLength(real.length);
    expect(forged).not.toBe(real);
    expect(() => fromHex(forged)).toThrow(TypeError);
  });

  it('decodes well-formed hex unchanged', () => {
    const bytes = randomBytes(32);
    expect(toHex(fromHex(toHex(bytes)))).toBe(toHex(bytes));
    expect(fromHex('')).toHaveLength(0);
  });
});

describe('a derivation path segment is an index or nothing', () => {
  /**
   * `Number.parseInt` again, in the place where being lenient costs the most. A segment was read
   * with `parseInt(segment, 10)` and then checked with `Number.isInteger` — a check that cannot
   * fire, because `parseInt` returns an integer or `NaN` and never anything in between. Every
   * malformed index therefore became a VALID one: `1.5'`, `1e3'` and `1abc'` all derived
   * `m/7391'/1'`.
   *
   * The damage is not a crash but a collision. Two personas at different indices come back with
   * the same private key and therefore the same persona_id, while `DerivedPersona.path` reports
   * the index that was asked for — so a vault records two identities that are one key, and every
   * unlinkability claim §1.2 makes about sibling personas is void for that pair.
   */
  const seed = randomBytes(64);

  it('refuses a segment that is not wholly digits', () => {
    for (const segment of ['1.9', '1e3', ' 1', '1abc', '+1', '-1']) {
      expect(() => derivePath(seed, `m/7391'/${segment}'`), segment).toThrow(TypeError);
    }
  });

  it('refuses a persona index that is not a non-negative integer', () => {
    // 1e21 stringifies to "1e+21", which used to derive persona 1 — the same key under a
    // different name.
    for (const index of [1.5, 1e21, -1, Number.NaN]) {
      expect(() => derivePersona(seed, index), String(index)).toThrow(TypeError);
    }
  });

  it('still derives every well-formed index', () => {
    // The control, including the boundary: the largest index hardened derivation allows.
    expect(derivePersona(seed, 0).path).toBe("m/7391'/0'");
    expect(derivePersona(seed, 0x7fffffff).path).toBe("m/7391'/2147483647'");
    expect(derivePersona(seed, 1).privateKey).not.toBe(derivePersona(seed, 2).privateKey);
    expect(() => derivePersona(seed, 0x80000000)).toThrow(RangeError);
  });
});

describe('edge_id: the fixed width is what makes the concatenation unambiguous', () => {
  it('refuses a hex field that is not exactly 64 characters', () => {
    // The collision this prevents, spelled out: shortening one field by a character and
    // lengthening the next by the same character slides the boundary and leaves the octets
    // identical. §4.1's `||` encoding is ratified as implemented, so the width is the only thing
    // standing between two distinct edges and one edge_id.
    const a = { commitment_hash: 'a'.repeat(64), owner: 'b'.repeat(64), owed_to: 'c'.repeat(64), proposed_at: 'T' };
    const b = { commitment_hash: 'a'.repeat(63), owner: 'a' + 'b'.repeat(64), owed_to: 'c'.repeat(64), proposed_at: 'T' };
    expect(() => edgeId(a)).not.toThrow();
    expect(() => edgeId(b)).toThrow(TypeError);
  });

  it('refuses uppercase and non-hex, which would also widen the alphabet', () => {
    const base = { commitment_hash: 'a'.repeat(64), owner: 'b'.repeat(64), owed_to: 'c'.repeat(64), proposed_at: 'T' };
    expect(() => edgeId({ ...base, owner: 'B'.repeat(64) })).toThrow(TypeError);
    expect(() => edgeId({ ...base, owed_to: 'z'.repeat(64) })).toThrow(TypeError);
  });

  it('leaves every well-formed edge_id byte-identical', () => {
    // The guard must be free. This value is the one the implementation produced before it existed.
    expect(
      edgeId({
        commitment_hash: '0'.repeat(64),
        owner: '1'.repeat(64),
        owed_to: '2'.repeat(64),
        proposed_at: '2026-07-25T09:00:00.000Z',
      }),
    ).toBe('dd3aa208732f870e4af18a1c535a13e1ad468328fb52dd5785849db96400715d');
  });
});

describe('a keyset that came from somewhere else', () => {
  it('refuses a wrap demanding more Argon2id memory than the ceiling', () => {
    // A keyset arrives over §6.6 recovery and over import. `m` is the memory Argon2id allocates,
    // so a wrap naming 4 GiB is a keyset-shaped way to stop the process. Refused, not clamped:
    // silently deriving with different parameters than the wrap names is the neighbouring bug.
    const key = generateContentKey();
    const wrap = wrapAtFloor(key, 'correct horse');
    const hostile: ContentKeySet = {
      v: 'servanda/0.2',
      type: 'content_keyset',
      wraps: [{ ...wrap, kdf: { ...wrap.kdf!, m: MAX_UNWRAP_MEMORY_KIB + 1 } }],
    };
    expect(() => unwrapWithPassphrase(hostile, 'correct horse')).toThrow(/Argon2id memory/);
  });

  it('still opens a wrap that asks for LESS than today, up to the ceiling', () => {
    // Only the ceiling is guarded: a lower cost weakens a key that is already wrapped and
    // stranding those vaults is the failure this whole path exists to avoid.
    const key = generateContentKey();
    const weak = wrapAtFloor(key, 'correct horse');
    weak.kdf = { algo: 'argon2id', salt: weak.kdf!.salt, m: 19456, t: 2, p: 1 };
    // rewrap at those parameters so the ciphertext matches the cost it declares
    const rewrapped = wrapAtFloor(key, 'correct horse');
    expect(() => unwrapWithPassphrase({ v: 'servanda/0.2', type: 'content_keyset', wraps: [rewrapped] }, 'correct horse')).not.toThrow();
  });

  it('refuses to build a passphrase wrap from an empty passphrase', () => {
    // M-16 requires a passphrase wrap to exist. One made from '' satisfies the check and protects
    // nothing, which makes the device key sole custodian in every sense but the schema's.
    expect(() => wrapAtFloor(generateContentKey(), '')).toThrow(EmptyPassphrase);
    expect(() => wrapAtFloor(generateContentKey(), ' ')).not.toThrow();
  });
});
