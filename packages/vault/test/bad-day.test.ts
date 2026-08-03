import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ARGON2ID_CONSTRAINED, derivePersona, mnemonicToSeed } from '@servanda/crypto';
import { PROTOCOL_VERSION, type Commitment } from '@servanda/types';
import {
  GIT_CONFIG,
  SealedRecordError,
  StrayVaultFile,
  Vault,
  VaultError,
  VaultGitError,
  type PersonaRecord,
} from '../src/index.js';

/**
 * The bad day: the laptop is gone, the passphrase is wrong, the disk half-wrote a file.
 *
 * Everything here is about what a person is TOLD. The vault's other tests establish that it keeps
 * its promises when nothing goes wrong; these establish that when something does, the sentence a
 * frightened person reads at 2am is true, names the file, and names the next move. "Error: invalid
 * tag" is a true sentence about a vault and a useless one about a life.
 */

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon art';
const PASSPHRASE = 'correct horse battery staple';
const seed = mnemonicToSeed(MNEMONIC);
const p0 = derivePersona(seed, 0);
const p1 = derivePersona(seed, 1);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function personaRecord(d: ReturnType<typeof derivePersona>, index: number, label: string): PersonaRecord {
  return {
    persona_id: d.personaId,
    persona_index: index,
    label,
    scope_kind: 'personal',
    org_root: null,
    private_key: d.privateKey,
    created_at: '2026-07-25T09:00:00Z',
  };
}

function commitment(intent: string): Commitment {
  return {
    v: PROTOCOL_VERSION,
    type: 'commitment',
    intent,
    owner: p0.personaId,
    owed_to: p1.personaId,
    due: null,
    conditions: [],
    created_at: '2026-07-25T10:00:00Z',
  };
}

/**
 * A vault with two personas and two promises, which is the smallest thing worth losing.
 *
 * Built ONCE and copied per test, and the reason is a gate that reported red over 311 green
 * tests. Vitest's worker→main `onTaskUpdate` call carries birpc's 60 s timeout, and the timer
 * that enforces it lives in the WORKER. A file of synchronous tests never reaches the poll
 * phase, so the main process's reply sits unread in the IPC queue while the timer runs; the
 * clock is therefore CUMULATIVE OVER THE FILE, not per test. Measured: five tests blocking
 * 14 s each — none of them near any timeout — produce `Timeout calling "onTaskUpdate"` with
 * 5 of 5 passing and a non-zero exit.
 *
 * Building this vault per test cost one Argon2id derivation (~1.4 s at the constrained
 * profile) plus about thirty git subprocesses, eight times over, and that is what carried the
 * file across 60 s. A copy is a few milliseconds and is the same bytes and the same git
 * history, so every test below still gets a vault nothing else has touched.
 *
 * What did NOT change is what any test checks. This is scaffolding cost only — the per-test
 * `Vault.open` that each scenario actually exercises is still a real open, at the real KDF
 * profile, against a real repository.
 */
let template: string;

beforeAll(() => {
  template = mkdtempSync(join(tmpdir(), 'servanda-bad-day-template-'));
  const vault = Vault.create({ dir: template, passphrase: PASSPHRASE, kdf: ARGON2ID_CONSTRAINED });
  vault.putPersona(personaRecord(p0, 0, 'me'));
  vault.putPersona(personaRecord(p1, 1, 'them'));
  vault.putCommitment(p0.personaId, commitment('send Maria the quote'));
  vault.putCommitment(p0.personaId, commitment('call the accountant'));
});

afterAll(() => {
  rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function newVault(): string {
  const dir = mkdtempSync(join(tmpdir(), 'servanda-bad-day-'));
  dirs.push(dir);
  cpSync(template, dir, { recursive: true });
  return dir;
}

function commitmentsDir(dir: string): string {
  return join(dir, 'personas', p0.personaId, 'commitments');
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', [...GIT_CONFIG, ...args], { cwd: dir, encoding: 'utf8' });
}

describe('a half-written record', () => {
  it('names the file, and everything else in the vault still reads', () => {
    const dir = newVault();
    const names = readdirSync(commitmentsDir(dir));
    const torn = names[0]!;
    const intact = names[1]!;
    const good = readFileSync(join(commitmentsDir(dir), torn), 'utf8');
    // What a power loss during `writeFileSync` leaves: a prefix of a record.
    writeFileSync(join(commitmentsDir(dir), torn), good.slice(0, Math.floor(good.length / 2)));

    const vault = Vault.open({ dir, passphrase: PASSPHRASE });

    let err: unknown;
    try {
      vault.listCommitments(p0.personaId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SealedRecordError);
    // The whole point: WHICH file. A listing walks every record, so one damaged file fails the
    // listing — the difference between a vault to repair and a vault to give up on is the path.
    expect((err as SealedRecordError).record).toContain(torn);
    expect((err as SealedRecordError).message).toContain('written only partly');

    // And the message's own claims, checked rather than asserted in prose: the other record is
    // readable by id right now …
    expect(vault.getCommitment(p0.personaId, intact.replace(/\.json$/, ''))).not.toBeNull();
    // … and moving the damaged file out of the vault restores the listing, which is exactly the
    // instruction the message gives.
    renameSync(join(commitmentsDir(dir), torn), join(tmpdir(), `rescued-${torn}`));
    dirs.push(join(tmpdir(), `rescued-${torn}`));
    expect(vault.listCommitments(p0.personaId)).toHaveLength(1);
  });
});

describe('a file that moved inside the vault', () => {
  it('says where it belongs, and putting it back opens it', () => {
    const dir = newVault();
    const name = readdirSync(commitmentsDir(dir))[0]!;
    const elsewhere = join(dir, 'personas', p1.personaId, 'commitments');
    mkdirSync(elsewhere, { recursive: true });
    renameSync(join(commitmentsDir(dir), name), join(elsewhere, name));

    const vault = Vault.open({ dir, passphrase: PASSPHRASE });
    let err: unknown;
    try {
      vault.listCommitments(p1.personaId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SealedRecordError);
    // A record is sealed to its own path (§5.3 M-5 rests on it), so this is a REVERSIBLE mistake
    // and the message has to say so rather than reading as corruption.
    expect((err as SealedRecordError).message).toContain('moved, renamed or copied');

    renameSync(join(elsewhere, name), join(commitmentsDir(dir), name));
    expect(vault.listCommitments(p0.personaId)).toHaveLength(2);
  });
});

describe('a vault directory two machines both wrote', () => {
  it('names the sync conflict copy instead of failing to decrypt it', () => {
    const dir = newVault();
    const name = readdirSync(commitmentsDir(dir))[0]!;
    // Exactly what Dropbox and iCloud leave behind, in the directory they leave it in.
    const conflict = `${name.replace(/\.json$/, '')} (Nikola's conflicted copy 2026-08-01).json`;
    writeFileSync(join(commitmentsDir(dir), conflict), readFileSync(join(commitmentsDir(dir), name)));

    const vault = Vault.open({ dir, passphrase: PASSPHRASE });
    let err: unknown;
    try {
      vault.listCommitments(p0.personaId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StrayVaultFile);
    expect((err as Error).message).toContain(conflict);
    expect((err as Error).message).toContain('Move it out of the vault directory');
  });
});

describe('the passphrase that did not work', () => {
  it('says there is no lockout, and says the other thing it might be', () => {
    const dir = newVault();
    let err: unknown;
    try {
      Vault.open({ dir, passphrase: 'not the passphrase' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VaultError);
    // Two claims a person needs at 2am and cannot get from "no passphrase wrap could be opened":
    // trying again is free, and the file itself is the other suspect.
    expect((err as Error).message).toContain('no lockout');
    expect((err as Error).message).toContain('keyset.json has been altered');
  });

  it('is not what a damaged keyset says', () => {
    const dir = newVault();
    const path = join(dir, 'keyset.json');
    writeFileSync(path, readFileSync(path, 'utf8').slice(0, 40));
    let err: unknown;
    try {
      Vault.open({ dir, passphrase: PASSPHRASE });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VaultError);
    expect((err as Error).message).toContain('not readable JSON');
    expect((err as Error).message).not.toContain('passphrase is wrong');
  });

  it('is not what a missing keyset says', () => {
    const dir = newVault();
    rmSync(join(dir, 'keyset.json'));
    expect(() => Vault.open({ dir, passphrase: PASSPHRASE })).toThrow(/keyset\.json is missing/);
  });
});

describe('a vault written by a newer Servanda', () => {
  it('is refused by version, not misreported as a wrong passphrase', () => {
    const dir = newVault();
    const marker = join(dir, 'servanda-vault.json');
    const descriptor = JSON.parse(readFileSync(marker, 'utf8')) as { v: string };
    descriptor.v = 'servanda/0.9';
    writeFileSync(marker, JSON.stringify(descriptor, null, 2));

    let err: unknown;
    try {
      Vault.open({ dir, passphrase: PASSPHRASE });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VaultError);
    expect((err as Error).message).toContain('servanda/0.9');
    expect((err as Error).message).toContain(PROTOCOL_VERSION);
    expect((err as Error).message).toContain('the passphrase is not the problem');
  });
});

describe('a vault checked out at an old commit', () => {
  it('refuses to write, because a commit made there belongs to no branch', () => {
    const dir = newVault();
    const shas = git(dir, ['log', '--format=%H']).trim().split('\n');
    const older = shas[2]!;
    git(dir, ['checkout', '--quiet', older]);

    // Reading is fine — this is how a person looks at what they had promised in June …
    const past = Vault.open({ dir, passphrase: PASSPHRASE });
    expect(past.listCommitments(p0.personaId)).toHaveLength(0);

    // … and writing is not, because nothing else would ever tell them where they are.
    //
    // The write goes through the SAME handle that just read, rather than through a second one
    // opened before the checkout. `commitAll` reads `.git/HEAD` on every call and a `Vault` holds
    // no branch state at all, so the two are one code path — and one handle that reads and is then
    // refused a write is the closer reading of the sentence above it.
    let err: unknown;
    try {
      past.putCommitment(p0.personaId, commitment('a promise made in the past'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VaultGitError);
    expect((err as Error).message).toContain('detached HEAD');
    expect((err as Error).message).toContain('checkout main');

    // The proof that this is data loss and not tidiness: no commit was made off-branch, where the
    // next checkout would have unreferenced it.
    expect(git(dir, ['log', '--format=%H']).trim().split('\n')).toHaveLength(shas.length - 2);

    // And the message's promise, checked: the register comes back whole AND the promise made at
    // the detached HEAD is still there — written, uncommitted, carried across the checkout. The
    // refusal stops the commit, not the person.
    git(dir, ['checkout', '--quiet', 'main']);
    const home = Vault.open({ dir, passphrase: PASSPHRASE });
    expect(home.listCommitments(p0.personaId).map((c) => c.commitment.intent).sort()).toEqual([
      'a promise made in the past',
      'call the accountant',
      'send Maria the quote',
    ]);
    expect(existsSync(commitmentsDir(dir))).toBe(true);
  });
});
