import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateRootMnemonic } from '@servanda/crypto';
import { InitError, normalizeMnemonic, runInit, type Env, type InitIo } from '../src/bin/servanda-init.js';
import { openNode } from '../src/bin/servanda-node.js';
import { makeFixture, persona, TEST_MNEMONIC, TEST_PASSPHRASE, type Fixture } from './support/fixture.js';

/**
 * The first hour, from the outside.
 *
 * Everything here is a refusal or a message a person meets before they have any protocol
 * vocabulary, driven through the two bins' own entry points. The bins are exercised in-process
 * rather than by spawning `dist/`: a subprocess test proves things about the last build, and
 * `pnpm test` does not build.
 *
 * Every vault is the fixture's, at `ARGON2ID_CONSTRAINED`, and they are shared per block rather
 * than per test. `runInit` creating one of its own would use the desktop profile — ten seconds
 * and a gigabyte apiece — so the cases here are the ones that refuse before a vault is made,
 * plus the add-persona path against a vault that already exists. Even at the constrained
 * profile each open is a real Argon2id, so the count of opens is the cost of this file.
 */

const trash: (() => void)[] = [];
afterAll(() => {
  while (trash.length > 0) trash.pop()?.();
});

function fixture(personas: { index: number; label: string }[]): Fixture {
  const fx = makeFixture({ personas });
  trash.push(() => fx.cleanup());
  return fx;
}

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'servanda-first-hour-'));
  // Same teardown contract as the fixture: retries, because git may still be letting go.
  trash.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}

function collect(): InitIo & { text(): string } {
  const chunks: string[] = [];
  return { out: (t) => chunks.push(t), log: () => undefined, text: () => chunks.join('') };
}

/** The message a person actually sees, or `null` when the command succeeded. */
function refusal(env: Env, io: InitIo = collect()): string | null {
  try {
    runInit(env, io);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function baseEnv(dir: string): Env {
  return { SERVANDA_VAULT: dir, SERVANDA_PASSPHRASE: TEST_PASSPHRASE };
}

/** Refusals that never reach a vault: no directory, no key derivation, no cost. */
describe('refused before anything is written', () => {
  let dir = '';
  beforeAll(() => {
    dir = scratchDir();
  });

  it('names the word count when the count is what is wrong', () => {
    const short = TEST_MNEMONIC.split(' ').slice(0, 23).join(' ');
    expect(refusal({ ...baseEnv(dir), SERVANDA_MNEMONIC: short })).toMatch(/24 words; got 23/u);
  });

  it('says something different when there are 24 words but they do not check out', () => {
    const wrong = [...TEST_MNEMONIC.split(' ').slice(0, 23), 'zebra'].join(' ');
    const message = refusal({ ...baseEnv(dir), SERVANDA_MNEMONIC: wrong });
    expect(message).toMatch(/24 words but is not a valid BIP-39 phrase/u);
    expect(message).not.toMatch(/got 23/u);
  });

  /** The index is part of the derivation path, so a silently-different index is a different persona. */
  it('refuses a SERVANDA_INDEX it would have to truncate', () => {
    expect(refusal({ ...baseEnv(dir), SERVANDA_INDEX: '1.9' })).toMatch(/non-negative integer/u);
    expect(refusal({ ...baseEnv(dir), SERVANDA_INDEX: '2x' })).toMatch(/non-negative integer/u);
  });

  it('refuses a SERVANDA_INDEX past the 31-bit hardened range with a sentence, not a RangeError', () => {
    const message = refusal({ ...baseEnv(dir), SERVANDA_INDEX: String(2 ** 31) });
    expect(message).toMatch(/at most 2147483647/u);
    expect(message).not.toMatch(/child index out of range/u);
  });

  it('does not describe a git repository as a vault', () => {
    const repo = scratchDir();
    mkdirSync(join(repo, '.git'));
    const message = refusal(baseEnv(repo));
    expect(message).toMatch(/existing git repository/u);
    expect(message).not.toMatch(/vault already exists/u);
  });

  it('says so when the path is a file', () => {
    const file = join(dir, 'notadir');
    writeFileSync(file, 'x');
    const message = refusal(baseEnv(file));
    expect(message).toMatch(/must be a directory/u);
    expect(message).not.toMatch(/EEXIST/u);
  });
});

describe('the recovery phrase a person wrote down', () => {
  /**
   * The phrase is printed six words to a line and told to be written down. It comes back
   * transcribed: down a column, in capitals, with a stray space. Those are the same 24 words,
   * and refusing them tells its holder — on USAGE.md's own authority that the phrase is the only
   * way back — that they have lost the vault.
   */
  it('survives every shape a transcription takes', () => {
    const shapes: Record<string, string> = {
      'one word per line': TEST_MNEMONIC.split(' ').join('\n'),
      'shouted in capitals': TEST_MNEMONIC.toUpperCase(),
      'padded and double-spaced': `  ${TEST_MNEMONIC.split(' ').join('  ')}  `,
      'wrapped six to a line, as it was printed': TEST_MNEMONIC.replace(
        /((?:\S+ ){5}\S+) /gu,
        '$1\n  ',
      ),
    };
    for (const [shape, phrase] of Object.entries(shapes)) {
      expect(normalizeMnemonic(phrase), shape).toBe(TEST_MNEMONIC);
    }
  });

});

describe('adding a persona to a vault that exists', () => {
  /**
   * USAGE.md §1 documents `SERVANDA_INDEX=1 SERVANDA_LABEL=work` against the vault §1 just made,
   * and §4 documents choosing between the personas that produces. Until this worked, the only
   * thing that could put a persona in a vault refused every vault it had already made.
   *
   * The phrase arrives here down a column, because a normaliser nothing calls does not exist.
   */
  it('is what the second documented init command does', () => {
    const fx = fixture([{ index: 0, label: 'personal' }]);
    const io = collect();
    const message = refusal(
      {
        ...baseEnv(fx.dir),
        SERVANDA_MNEMONIC: TEST_MNEMONIC.split(' ').join('\n'),
        SERVANDA_INDEX: '1',
        SERVANDA_LABEL: 'work',
      },
      io,
    );
    expect(message).toBeNull();
    expect(io.text()).toContain(persona(1).personaId);
    expect(io.text()).toContain("m/7391'/1'");
    // The phrase was supplied, so nothing is generated and nothing is printed to write down.
    expect(io.text()).not.toContain('RECOVERY PHRASE');
    expect(fx.vault.listPersonaIds()).toHaveLength(2);
  });

  describe('and refusing to', () => {
    let fx: Fixture;
    beforeAll(() => {
      fx = fixture([
        { index: 0, label: 'personal' },
        { index: 1, label: 'work' },
      ]);
    });

    it('claim an overwrite when what is missing is the phrase', () => {
      const message = refusal({ ...baseEnv(fx.dir), SERVANDA_INDEX: '2', SERVANDA_LABEL: 'other' });
      expect(message).toMatch(/SERVANDA_MNEMONIC/u);
      expect(message).toMatch(/holds persona keys, not the/u);
      expect(message).not.toMatch(/refusing to overwrite/u);
    });

    /** One vault holding two seeds is a vault no single phrase restores. */
    it('take a valid phrase that is not this vault’s', () => {
      const message = refusal({
        ...baseEnv(fx.dir),
        SERVANDA_MNEMONIC: generateRootMnemonic(),
        SERVANDA_INDEX: '2',
        SERVANDA_LABEL: 'other',
      });
      expect(message).toMatch(/not the phrase this vault/u);
      expect(fx.vault.listPersonaIds()).toHaveLength(2);
    });

    it('reuse an index, and it says what that persona is called', () => {
      const message = refusal({
        ...baseEnv(fx.dir),
        SERVANDA_MNEMONIC: TEST_MNEMONIC,
        SERVANDA_INDEX: '0',
        SERVANDA_LABEL: 'other',
      });
      expect(message).toMatch(/index 0 is already in this vault, labelled "personal"/u);
    });

    /** A label is a selector (§1.2, and SERVANDA_PERSONA); two of them make selection a coin toss. */
    it('reuse a label', () => {
      const message = refusal({
        ...baseEnv(fx.dir),
        SERVANDA_MNEMONIC: TEST_MNEMONIC,
        SERVANDA_INDEX: '2',
        SERVANDA_LABEL: 'work',
      });
      expect(message).toMatch(/label "work" is already used/u);
    });
  });
});

describe('starting the node', () => {
  let fx: Fixture;
  beforeAll(() => {
    fx = fixture([
      { index: 0, label: 'personal' },
      { index: 1, label: 'work' },
    ]);
  });

  it('accepts SERVANDA_PERSONA as a label, which is what the register documents', () => {
    expect(openNode({ ...baseEnv(fx.dir), SERVANDA_PERSONA: 'work' }).activePersona).toBe(
      persona(1).personaId,
    );
  });

  /**
   * An unresolvable persona used to start the server anyway and fail one tool call later, inside
   * the assistant, as "persona_id must be lowercase hex".
   */
  it('refuses at startup when SERVANDA_PERSONA matches nothing', () => {
    expect(() => openNode({ ...baseEnv(fx.dir), SERVANDA_PERSONA: 'nosuch' })).toThrow(
      /matches SERVANDA_PERSONA/u,
    );
  });

  /**
   * `InitError` is the type `main` catches and turns into `exit 2` with one line on stderr.
   * Anything else leaves the process as an uncaught exception — which under an MCP client is a
   * server that "failed to start" and a reason printed where nobody is reading.
   */
  it('turns a wrong passphrase and a directory that is no vault into refusals, not crashes', () => {
    const caught = (env: Env): Error => {
      try {
        openNode(env);
      } catch (err) {
        return err as Error;
      }
      throw new Error('expected openNode to refuse');
    };

    const wrongPassphrase = caught({ SERVANDA_VAULT: fx.dir, SERVANDA_PASSPHRASE: 'not the passphrase' });
    const notAVault = caught({ SERVANDA_VAULT: scratchDir(), SERVANDA_PASSPHRASE: TEST_PASSPHRASE });

    expect(wrongPassphrase).toBeInstanceOf(InitError);
    expect(notAVault).toBeInstanceOf(InitError);
    // And the two are still told apart, with the crypto layer's own sentence carried through.
    expect(wrongPassphrase.message).toMatch(/passphrase is wrong/u);
    expect(wrongPassphrase.message).toMatch(/altered since it was written/u);
    expect(notAVault.message).toMatch(/not a servanda vault/u);
    expect(notAVault.message).not.toMatch(/passphrase is wrong/u);
  });
});
