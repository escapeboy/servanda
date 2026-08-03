import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARGON2ID_CONSTRAINED } from '@servanda/crypto';
import {
  kdfAdvisoryFor,
  runInit,
  upgradeKeyCommand,
  type Env,
  type InitIo,
} from '../src/bin/servanda-init.js';
import { makeFixture, TEST_PASSPHRASE, type Fixture } from './support/fixture.js';

/**
 * The owner of a weak vault learns it is weak, and has a command that fixes it.
 *
 * Every published version through 0.4.0-pre made vaults at `{m: 65536, t: 3, p: 1}`; the raise to
 * the desktop point landed after that tag. A wrap is opened at the profile it was WRITTEN at, so
 * those vaults stay at the floor for the rest of their lives — `Vault.upgradeKdf` and
 * `rewrapPassphrase` both existed and no command reached either, which made §9.3's "MAY raise" a
 * permission its holder could not exercise.
 *
 * COST. The re-wrap in `beforeAll` is a real Argon2id at m = 1 GiB, and so is the open that proves
 * the result is usable: roughly fifty seconds between them on a laptop. That is why they are in a
 * hook (180 s) rather than in a case (30 s), and why they happen ONCE for the whole block. Every
 * assertion below reads what those two calls produced. Faking the profile would leave the only
 * thing worth proving — that the numbers written down are the numbers actually spent — unproven.
 */

const trash: (() => void)[] = [];
afterAll(() => {
  while (trash.length > 0) trash.pop()?.();
});

function collect(): InitIo & { out_(): string; log_(): string } {
  const out: string[] = [];
  const log: string[] = [];
  return {
    out: (t) => out.push(t),
    log: (t) => log.push(t),
    out_: () => out.join(''),
    log_: () => log.join(''),
  };
}

function fixture(): Fixture {
  const fx = makeFixture({ personas: [{ index: 0, label: 'me' }] });
  trash.push(() => fx.cleanup());
  return fx;
}

describe('a vault made by an older build is told so', () => {
  let fx: Fixture;
  beforeAll(() => {
    fx = fixture();
  });

  it('the fixture is the shape the published 0.4.0-pre build produced', () => {
    const { m, t, p } = ARGON2ID_CONSTRAINED;
    expect(fx.vault.kdfProfile()).toMatchObject({ m, t, p, behindDefault: true });
  });

  it('says it in words, and names the command that raises it', () => {
    const said = kdfAdvisoryFor(fx.vault, fx.dir);
    expect(said).not.toBeNull();
    expect(said).toContain(upgradeKeyCommand(fx.dir));
    expect(said).toContain(fx.dir);
  });

  it('says it on the add-persona path, where a person meets an existing vault', () => {
    // stderr, not stdout: the persona block is this command's answer and something may be reading
    // it. Asserted on the stream because which stream it lands on is the property, not a detail.
    const io = collect();
    runInit(
      {
        SERVANDA_VAULT: fx.dir,
        SERVANDA_PASSPHRASE: TEST_PASSPHRASE,
        SERVANDA_MNEMONIC:
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
          'abandon abandon abandon art',
        SERVANDA_INDEX: '4',
        SERVANDA_LABEL: 'another',
      },
      io,
    );
    expect(io.log_()).toContain(upgradeKeyCommand(fx.dir));
    expect(io.out_()).not.toContain('SERVANDA_UPGRADE_KEY');
  });
});

describe('SERVANDA_UPGRADE_KEY refuses before it spends anything', () => {
  let fx: Fixture;
  beforeAll(() => {
    fx = fixture();
  });

  const refusal = (env: Env): string => {
    try {
      runInit(env, collect());
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error('expected a refusal');
  };

  it('refuses a value it does not recognise rather than reading it as false', () => {
    // "0" is the case: a person who believed the variable's PRESENCE was the switch, and a person
    // who believed its VALUE was, disagree about whether key material gets rewritten.
    expect(
      refusal({ SERVANDA_VAULT: fx.dir, SERVANDA_PASSPHRASE: TEST_PASSPHRASE, SERVANDA_UPGRADE_KEY: '0' }),
    ).toMatch(/SERVANDA_UPGRADE_KEY must be "1"/u);
  });

  it('refuses where there is no vault, rather than creating one and calling it an upgrade', () => {
    expect(
      refusal({
        SERVANDA_VAULT: `${fx.dir}-does-not-exist`,
        SERVANDA_PASSPHRASE: TEST_PASSPHRASE,
        SERVANDA_UPGRADE_KEY: '1',
      }),
    ).toMatch(/there is no vault at/u);
  });

  it('refuses the wrong passphrase with the vault untouched', () => {
    const before = JSON.stringify(fx.vault.keyset());
    expect(
      refusal({ SERVANDA_VAULT: fx.dir, SERVANDA_PASSPHRASE: 'not it', SERVANDA_UPGRADE_KEY: '1' }),
    ).toMatch(/cannot open the vault/u);
    expect(JSON.stringify(fx.vault.keyset())).toBe(before);
  });
});

/**
 * The SUCCESS path of `SERVANDA_UPGRADE_KEY` is not here, and cannot be.
 *
 * Raising a vault means one Argon2id at m = 1 GiB — about twenty-four seconds of a synchronous
 * call inside a vitest worker, which is long enough that the worker stops answering the reporter's
 * RPC. Written as a test, it passed ten cases out of ten and the RUN exited 1 with
 * `Timeout calling "onTaskUpdate"` — a red suite with no failing assertion in it, which is the
 * shape of failure that teaches people to re-run until green. Measured, not guessed at.
 *
 * That is not a limitation of this file; it is the reason the divergence it exists for went
 * unnoticed. NO test in this suite can spend the default profile, so no test could ever have
 * observed which profile the default actually is — every vault here is at `ARGON2ID_CONSTRAINED`
 * by necessity. A property no test can hold has to be held somewhere else, and it is:
 * `gates/gm-release.sh` runs the built bin against a floor vault in a plain node process, where a
 * twenty-four-second call blocks nobody, and asserts the profile it lands at, the words it prints
 * and that the same passphrase still opens the result.
 */
