import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARGON2ID_CONSTRAINED, derivePersona, mnemonicToSeed } from '@servanda/crypto';
import { PROTOCOL_VERSION, type Attestation, type DomainAnchor, type Revocation } from '@servanda/types';
import { Vault, VaultError, type PersonaRecord } from '../src/index.js';

/**
 * The vault is persona-scoped, and scoping is only as strong as the weakest side of it.
 *
 * Every READ ran its identifier through `assertHexId` before joining it into a path. Three WRITES
 * did not — attestations, revocations and domain anchors are filed under an id taken from the
 * record itself, and that id arrives from the wire. A record is a `PublicKeyHex` in the schema and
 * a path segment here; nothing made the two agree, and TypeScript cannot, because the value is
 * only a `string` at run time.
 *
 * The asymmetry is what made it invisible: `getAttestation` refuses `../..`, so nobody reading the
 * class from the top sees a path that trusts a caller.
 */

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon art';
const PASSPHRASE = 'correct horse battery staple';
const seed = mnemonicToSeed(MNEMONIC);
const mine = derivePersona(seed, 0);
const theirs = derivePersona(seed, 1);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function personaRecord(derived: ReturnType<typeof derivePersona>, index: number, label: string): PersonaRecord {
  return {
    persona_id: derived.personaId,
    persona_index: index,
    label,
    scope_kind: 'personal',
    org_root: null,
    private_key: derived.privateKey,
    created_at: '2026-07-25T09:00:00Z',
  };
}

/**
 * The vault sits one level DOWN inside a temp directory of its own, so `resolve(dir, '..')` is
 * somewhere this test owns. Pointed at the shared temp root instead, "did a file escape?" is
 * answered by whatever any earlier run left lying there — which it was: the first red run of the
 * anchor case wrote `escaped.json` into the system temp directory, and the fixed code then failed
 * on the corpse of its own bug.
 */
function newVault(): { dir: string; vault: Vault } {
  const parent = mkdtempSync(join(tmpdir(), 'servanda-scope-test-'));
  dirs.push(parent);
  const dir = join(parent, 'vault');
  const vault = Vault.create({ dir, passphrase: PASSPHRASE, kdf: ARGON2ID_CONSTRAINED });
  vault.putPersona(personaRecord(mine, 0, 'me'));
  vault.putPersona(personaRecord(theirs, 1, 'them'));
  return { dir, vault };
}

function attestation(subject: string): Attestation {
  return {
    v: PROTOCOL_VERSION,
    type: 'attestation',
    org: mine.personaId,
    subject,
    subject_kind: 'persona',
    claims: { display_name: 'planted' },
    issued_at: '2026-07-25T09:00:00Z',
    expires_at: '2027-07-25T09:00:00Z',
    sig: 'ab'.repeat(64),
  } as Attestation;
}

describe('vault: an id that is written is checked like an id that is read', () => {
  it('refuses to file an attestation into another persona’s subtree', () => {
    // The escape that matters: not a crash, a FORGERY. `../../<them>/attestations/<hex>` puts a
    // record inside the other persona's tree under a name that persona will happily read back —
    // so one persona hands another an attestation it never received, through a store whose entire
    // contract is that a persona sees only its own subtree.
    const { vault } = newVault();
    const forged = 'd'.repeat(64);
    expect(() =>
      vault.putAttestation(mine.personaId, attestation(`../../${theirs.personaId}/attestations/${forged}`)),
    ).toThrow(TypeError);
    expect(vault.getAttestation(theirs.personaId, forged)).toBeNull();
  });

  it('refuses to write a domain anchor outside the vault directory', () => {
    // `..` enough times and the file lands beside the vault rather than inside it: outside the
    // git repository, so the write is not even in history.
    const { dir, vault } = newVault();
    const anchor = { v: PROTOCOL_VERSION, org_root: '../../../../escaped', hubs: [] } as unknown as DomainAnchor;
    expect(() => vault.putDomainAnchor(mine.personaId, anchor)).toThrow(TypeError);
    expect(existsSync(resolve(dir, '..', 'escaped.json'))).toBe(false);
  });

  it('refuses to write a revocation outside the persona’s subtree', () => {
    const { dir, vault } = newVault();
    const revocation = {
      v: PROTOCOL_VERSION,
      type: 'revocation',
      org: mine.personaId,
      subject: '../../../revoked',
      revoked_at: '2026-07-25T09:00:00Z',
      sig: 'ab'.repeat(64),
    } as Revocation;
    expect(() => vault.putRevocation(mine.personaId, revocation)).toThrow(TypeError);
    expect(existsSync(join(dir, 'revoked.json'))).toBe(false);
  });

  it('still stores and reads back a well-formed record', () => {
    // The control. A check that refuses everything is not a check.
    const { vault } = newVault();
    vault.putAttestation(mine.personaId, attestation(theirs.personaId));
    expect(vault.getAttestation(mine.personaId, theirs.personaId)?.claims.display_name).toBe('planted');
    expect(vault.getAttestation(theirs.personaId, theirs.personaId)).toBeNull();
  });
});

describe('vault: creation does not adopt a repository it finds', () => {
  /**
   * `git.ts` states the safety property plainly — this code "must never be able to commit into the
   * repository it is developed in" — and `assertVaultRepo` was believed to hold it. It does not
   * hold it at CREATION: `assertVaultRepo` only asks whether the directory is the root of its own
   * repo and carries the marker, and `Vault.create` writes the marker itself. Point it at an
   * existing repository root and the vault takes the repo over: `git config` overwrites the
   * owner's name and email, and the first vault commit sweeps up every uncommitted file with
   * `add -A`. Nothing warns, and the vault works perfectly afterwards.
   */
  it('refuses a directory that is already a git repository', () => {
    const host = mkdtempSync(join(tmpdir(), 'servanda-host-repo-'));
    dirs.push(host);
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: host });
    execFileSync('git', ['config', 'user.name', 'Real Human'], { cwd: host });
    execFileSync('git', ['config', 'user.email', 'human@example.com'], { cwd: host });
    writeFileSync(join(host, 'work-in-progress.txt'), 'uncommitted work');

    expect(() => Vault.create({ dir: host, passphrase: PASSPHRASE, kdf: ARGON2ID_CONSTRAINED })).toThrow(VaultError);

    // The damage the throw prevents, asserted rather than assumed: the owner's work is still
    // untracked and their git identity is still theirs.
    expect(execFileSync('git', ['ls-files'], { cwd: host, encoding: 'utf8' }).trim()).toBe('');
    expect(execFileSync('git', ['config', 'user.name'], { cwd: host, encoding: 'utf8' }).trim()).toBe(
      'Real Human',
    );
    // And it did not leave half a vault behind for a second attempt to trip over.
    expect(existsSync(join(host, 'keyset.json'))).toBe(false);
    expect(readFileSync(join(host, 'work-in-progress.txt'), 'utf8')).toBe('uncommitted work');
  });
});

