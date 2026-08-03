import { describe, expect, it } from 'vitest';
import {
  ARGON2ID_CONSTRAINED,
  ARGON2ID_DESKTOP,
  ARGON2ID_PARAMS,
  kdfAdvisory,
} from '../src/content-key.js';

/**
 * The owner of a vault made at the old default has no way to find out.
 *
 * Every published version up to and including 0.4.0-pre made vaults at `{m: 65536, t: 3, p: 1}`,
 * because that was `ARGON2ID_PARAMS` at every one of those tags. The raise to the desktop point
 * landed after v0.4.0-pre and changed nothing about the vaults already made: a wrap is opened at
 * the profile it was WRITTEN at, so those vaults are at the floor for the rest of their lives.
 *
 * `Vault.kdfProfile()` has reported `behindDefault: true` for them the whole time, to nobody —
 * no surface called it, and the numbers it returns are not a sentence anyone acts on. These cases
 * pin the sentence: that it appears exactly when the vault is behind, that it carries the command
 * that fixes it, and that a reader who has never heard of Argon2id can act on every line but the
 * last.
 */

const FIX = 'SERVANDA_UPGRADE_KEY=1 npx servanda-init';

describe('§9.3 a weak vault says so, in words, with the command that raises it', () => {
  it('says nothing about a vault at the current profile', () => {
    expect(kdfAdvisory(ARGON2ID_PARAMS, FIX)).toBeNull();
  });

  it('says nothing about a keyset with no passphrase wrap', () => {
    // Null there means "no passphrase wrap at all", which is an M-16 violation and is refused
    // long before anyone would read a paragraph about memory costs. Not this function's finding.
    expect(kdfAdvisory(null, FIX)).toBeNull();
  });

  it('says nothing about a vault made STRONGER than this build makes', () => {
    // §9.3 permits a raise, so a vault opened by an older build must not be told it is weak by a
    // build that is itself behind. Above-default is silence, exactly like at-default.
    const stronger = { m: ARGON2ID_DESKTOP.m, t: ARGON2ID_DESKTOP.t + 1, p: ARGON2ID_DESKTOP.p };
    expect(kdfAdvisory(stronger, FIX)).toBeNull();
  });

  it('names the published 0.4.0-pre floor as weaker, and by how much', () => {
    const said = kdfAdvisory(ARGON2ID_CONSTRAINED, FIX);
    expect(said).not.toBeNull();

    // 1048576 / 65536 = 16 exactly, and (1048576·2·4) / (65536·3·1) ≈ 42.7. Both are asserted
    // because they are different claims: memory is what bounds an attacker's parallelism, total
    // work is what one guess costs them. Computed from the constants rather than typed, so a
    // future raise moves the expectation with the code instead of staling a literal.
    const memory = ARGON2ID_DESKTOP.m / ARGON2ID_CONSTRAINED.m;
    const work =
      (ARGON2ID_DESKTOP.m * ARGON2ID_DESKTOP.t * ARGON2ID_DESKTOP.p) /
      (ARGON2ID_CONSTRAINED.m * ARGON2ID_CONSTRAINED.t * ARGON2ID_CONSTRAINED.p);
    expect(said).toContain(`${Math.round(memory)}× less memory`);
    expect(said).toContain(`${Math.round(work)}× less work`);
  });

  it('carries the caller’s command verbatim, because a fix nobody can run is not a fix', () => {
    expect(kdfAdvisory(ARGON2ID_CONSTRAINED, FIX)).toContain(FIX);
    // A different surface, a different command. The sentence is shared; the instruction is not.
    expect(kdfAdvisory(ARGON2ID_CONSTRAINED, 'some other command')).toContain('some other command');
  });

  it('is readable by somebody who has never heard of Argon2id', () => {
    const said = kdfAdvisory(ARGON2ID_CONSTRAINED, FIX)!;
    // The word may appear once, in the bracketed line that exists for the reader who DOES know it.
    // Everything above that line has to stand without it, so a second occurrence would mean the
    // explanation had started depending on the jargon.
    expect(said.match(/Argon2id/gu) ?? []).toHaveLength(1);
    const beforeNumbers = said.slice(0, said.indexOf('(Argon2id'));
    expect(beforeNumbers).not.toMatch(/KiB|m=|KDF|derivation|parallelism/u);

    // And it must not read like a breach. The vault is fine; only guessing got cheaper. A warning
    // that sounds like a compromise gets a vault deleted by somebody trying to be safe.
    expect(beforeNumbers).toContain('Nothing has leaked and nothing is broken');
    expect(beforeNumbers).toMatch(/same passphrase/u);
  });
});
