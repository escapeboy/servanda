import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ARGON2ID_CONSTRAINED,
  derivePersona,
  generateContentKey,
  generateRootMnemonic,
  mnemonicToSeed,
} from '@servanda/crypto';
import { Vault } from '../src/vault.js';
import { readJson, readSealed, writeSealed } from '../src/store.js';

const PASSPHRASE = 'the passphrase this vault was made with';

/**
 * What a power cut during a re-key actually leaves, and whether the documented way out works.
 *
 * `rekey` reads and decrypts everything, re-seals every record under a new content key, writes
 * the new keyset, and makes ONE commit. It is recoverable rather than atomic, and the note saying
 * so has never been exercised: between the last record write and the keyset write, the files on
 * disk are sealed under a key the keyset does not name. Every record is unreadable and the vault
 * looks destroyed.
 *
 * That is the moment this reproduces — by doing the first half of a re-key and stopping — and the
 * claim it checks is the specific one: the last commit is still the whole consistent pre-re-key
 * state, so `git checkout .` returns a working vault that opens with the same passphrase.
 *
 * It matters because the alternative reading is the one a person arrives at on their own, and it
 * is wrong. A vault whose every record fails to open reads as lost. It is not lost; it is dirty.
 */
describe('a re-key interrupted halfway is recoverable, and only because of the commit boundary', () => {
  let dir: string;
  let personaId: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'servanda-rekey-crash-'));
    const p = derivePersona(mnemonicToSeed(generateRootMnemonic()), 0);
    personaId = p.personaId;
    const vault = Vault.create({ dir, passphrase: PASSPHRASE, kdf: ARGON2ID_CONSTRAINED });
    vault.putPersona({
      persona_id: p.personaId,
      persona_index: p.personaIndex,
      label: 'personal',
      scope_kind: 'personal',
      org_root: null,
      private_key: p.privateKey,
      created_at: vault.now(),
    });
    vault.putCommitment(p.personaId, {
      v: 'servanda/0.2',
      type: 'commitment',
      owner: p.personaId,
      owed_to: null,
      intent: 'a promise that must survive a power cut',
      due: null,
      created_at: vault.now(),
      source: 'stated',
    } as never);
  }, 180_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  it('leaves the vault unopenable — the honest failure, not a silent half-state', () => {
    const vault = Vault.open({ dir, passphrase: PASSPHRASE });
    // The first half of `rekey`, and nothing after it: re-seal every record under a fresh content
    // key and stop before the keyset is written. `sealedRecordPaths` is private, so the paths come
    // from the same place the real thing gets them — a git listing of the sealed tree.
    const paths = execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => f.endsWith('.json') && f.includes('personas/'))
      .map((f) => join(dir, f));
    expect(paths.length).toBeGreaterThan(0);

    const orphanKey = generateContentKey();
    for (const path of paths) {
      const kind = readJson<{ kind: string }>(path).kind;
      const value = readSealed<unknown>(dir, path, (vault as unknown as { contentKey: Uint8Array }).contentKey);
      writeSealed(dir, path, orphanKey, kind, value);
    }

    // Re-opening reads the OLD keyset, which no longer opens anything.
    const broken = Vault.open({ dir, passphrase: PASSPHRASE });
    expect(() => broken.getPersona(personaId)).toThrow();
  });

  it('and `git checkout .` gives it back, with the same passphrase', () => {
    // The one commit is the boundary. Everything the interrupted half wrote is uncommitted, so
    // the last commit is still the whole consistent pre-re-key state.
    execFileSync('git', ['-C', dir, 'checkout', '.'], { encoding: 'utf8' });

    const restored = Vault.open({ dir, passphrase: PASSPHRASE });
    expect(restored.getPersona(personaId).label).toBe('personal');
    const commitments = restored.listCommitments(personaId);
    expect(commitments).toHaveLength(1);
    expect(commitments[0]!.commitment.intent).toBe('a promise that must survive a power cut');
  });

  it('and the working tree is clean afterwards, so nothing was left half-written', () => {
    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
    expect(status.trim()).toBe('');
  });
});
