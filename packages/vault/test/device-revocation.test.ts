import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ARGON2ID_CONSTRAINED,
  type ContentKeySet,
  decryptContent,
  derivePersona,
  kdfProfileOf,
  mnemonicToSeed,
  unwrapWithDevice,
} from '@servanda/crypto';
import { PROTOCOL_VERSION, type Commitment } from '@servanda/types';
import { GIT_CONFIG, recordBinding, Vault, VaultError, type PersonaRecord } from '../src/index.js';

/**
 * Withdrawing a device's access to a vault, and the exact size of what that buys.
 *
 * The naive shape of this feature — `removeDeviceKey(label)`, deleting a wrap from `keyset.json`
 * — is tested here as the thing that DOES NOT WORK, because it is the shape a reader expects and
 * the reason it fails is not visible from the outside. A vault is a directory. Somebody holding
 * the laptop holds the keyset as it was and every ciphertext it opened; nothing written into the
 * owner's copy afterwards reaches theirs.
 *
 * So the API is `rekey`, and these tests fix both halves of what it promises: the forward
 * boundary it really does draw, and the past it really does not touch — including through this
 * vault's own git history, which is the hole most likely to be assumed closed.
 */

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon art';
const PASSPHRASE = 'correct horse battery staple';
const LAPTOP = { label: 'laptop', keyHex: 'a1'.repeat(32) };
const PHONE = { label: 'phone', keyHex: 'b2'.repeat(32) };

const seed = mnemonicToSeed(MNEMONIC);
const p0 = derivePersona(seed, 0);
const p1 = derivePersona(seed, 1);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function personaRecord(): PersonaRecord {
  return {
    persona_id: p0.personaId,
    persona_index: 0,
    label: 'me',
    scope_kind: 'personal',
    org_root: null,
    private_key: p0.privateKey,
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
 * One vault, built once and copied per test — see `bad-day.test.ts` for the measurement behind
 * that. It carries both devices, because "revoke one and keep the other" is the case that has to
 * work; a vault with a single device would let a wrong implementation pass by dropping all of them.
 */
let template: string;

beforeAll(() => {
  template = mkdtempSync(join(tmpdir(), 'servanda-revoke-template-'));
  const vault = Vault.create({
    dir: template,
    passphrase: PASSPHRASE,
    kdf: ARGON2ID_CONSTRAINED,
    deviceKeys: [LAPTOP, PHONE],
  });
  vault.putPersona(personaRecord());
  vault.putCommitment(p0.personaId, commitment('send Maria the quote'));
});

afterAll(() => {
  rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function newVault(): string {
  const dir = mkdtempSync(join(tmpdir(), 'servanda-revoke-'));
  dirs.push(dir);
  cpSync(template, dir, { recursive: true });
  return dir;
}

/** The thief's copy: the whole directory as it stood, git history and all. */
function stolenCopy(dir: string): string {
  const copy = mkdtempSync(join(tmpdir(), 'servanda-stolen-'));
  dirs.push(copy);
  cpSync(dir, copy, { recursive: true });
  return copy;
}

function passphraseWrapOf(dir: string) {
  const keyset = JSON.parse(readFileSync(join(dir, 'keyset.json'), 'utf8')) as ContentKeySet;
  return keyset.wraps.find((w) => w.kind === 'passphrase');
}

function git(dir: string, args: string[]): string {
  // stderr piped rather than inherited: one call below is EXPECTED to fail (a record that exists
  // in the working tree and not in history) and git's `fatal:` on the suite's console reads as a
  // broken test to anyone watching the run.
  return execFileSync('git', [...GIT_CONFIG, ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Opened with a DEVICE key throughout, where a handle is only scaffolding.
 *
 * Not a shortcut around the KDF for its own sake: these tests are about device custody, so the
 * device path is the honest one to drive, and it keeps a file that performs several re-keys —
 * each of which really does derive twice at the §9.3 constrained profile — inside its budget.
 */
function open(dir: string, deviceKey: { label: string; keyHex: string }): Vault {
  return Vault.open({ dir, deviceKey });
}

describe('adding a device to a vault that already exists', () => {
  it('lets that device open it, and refuses a label already in use', () => {
    const dir = newVault();
    const vault = open(dir, PHONE);
    const tablet = { label: 'tablet', keyHex: 'c3'.repeat(32) };

    vault.addDeviceKey(tablet);
    expect(vault.deviceKeyLabels()).toEqual(['laptop', 'phone', 'tablet']);
    expect(open(dir, tablet).listCommitments(p0.personaId)).toHaveLength(1);

    // A label is how a device is NAMED on the day custody is withdrawn, so it has to be unique
    // then — which means it has to be unique now.
    expect(() => vault.addDeviceKey({ label: 'phone', keyHex: 'd4'.repeat(32) })).toThrow(VaultError);
  });
});

describe('deleting a wrap from the keyset — the thing this library deliberately does not offer', () => {
  it('revokes nothing, because the thief is not reading the owner’s copy', () => {
    const dir = newVault();
    // The thief took the laptop, and with it the directory as it stood.
    const stolen = stolenCopy(dir);

    // The owner does what `removeDeviceKey(label)` would have done: drops the wrap.
    const keyset = JSON.parse(readFileSync(join(dir, 'keyset.json'), 'utf8')) as ContentKeySet;
    keyset.wraps = keyset.wraps.filter((w) => w.label !== 'laptop');
    writeFileSync(join(dir, 'keyset.json'), JSON.stringify(keyset, null, 2));

    // Their own copy now refuses the laptop, which is the reassuring half and the worthless half.
    expect(() => open(dir, LAPTOP)).toThrow();

    // And the vault the thief actually has opens exactly as before. This is why the API is a
    // re-key: an edit to one directory is not a revocation, it is a note to oneself.
    expect(open(stolen, LAPTOP).listCommitments(p0.personaId)[0]?.commitment.intent).toBe(
      'send Maria the quote',
    );
  });
});

/**
 * A re-key costs three constrained-profile Argon2id derivations — one to verify the passphrase
 * before anything moves, one to wrap the new content key, one for the passphrase open that checks
 * the result — and that is the security property, not overhead to tune away. So it happens ONCE
 * per scenario in `beforeAll`, where slow setup belongs, and the assertions below are cheap.
 */
describe('re-keying a vault to withdraw one device', () => {
  let dir: string;
  let report: ReturnType<Vault['rekey']>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'servanda-revoke-done-'));
    cpSync(template, dir, { recursive: true });
    report = open(dir, PHONE).rekey({ passphrase: PASSPHRASE, deviceKeys: [PHONE] });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('keeps the vault whole for every credential named, and shuts out the one that is not', () => {
    expect(report.deviceLabelsBefore).toEqual(['laptop', 'phone']);
    expect(report.deviceLabelsAfter).toEqual(['phone']);
    // Two records exist — the persona and the commitment — and both had to be re-sealed. A count
    // of zero would mean a keyset swapped under records nobody rewrote, which opens and reads
    // nothing.
    expect(report.resealed).toBeGreaterThanOrEqual(2);
    expect(report.commit).not.toBeNull();

    // Everything the owner kept still works, through a fresh open rather than the live handle.
    expect(open(dir, PHONE).listCommitments(p0.personaId)[0]?.commitment.intent).toBe(
      'send Maria the quote',
    );
    expect(
      Vault.open({ dir, passphrase: PASSPHRASE }).getPersona(p0.personaId).label,
    ).toBe('me');

    // And the withdrawn device is out.
    expect(() => open(dir, LAPTOP)).toThrow();
  });

  it('leaves M-16 satisfied and the vault’s KDF profile where it was', () => {
    const keyset = passphraseWrapOf(dir);
    // M-16: withdrawing a device must never be the step that leaves devices in sole custody.
    expect(keyset).toBeDefined();
    // A re-key is about custody. Silently moving a constrained-device vault to the desktop
    // profile would make the next open cost seconds it did not cost before — a change nobody
    // asked for while asking for a different one.
    expect(keyset!.kdf).toMatchObject({
      m: ARGON2ID_CONSTRAINED.m,
      t: ARGON2ID_CONSTRAINED.t,
      p: ARGON2ID_CONSTRAINED.p,
    });
    // A FRESH salt, not the one the old wrap used. Reusing it would re-derive the same KEK for a
    // different content key, which is the one thing a new wrap must never do — and it is the
    // shortcut a re-key implemented as "swap the ciphertext" would take.
    expect(keyset!.kdf?.salt).toMatch(/^[0-9a-f]{32,}$/);
    expect(keyset!.kdf?.salt).not.toBe(passphraseWrapOf(template)!.kdf?.salt);
  });

  it('refuses a passphrase that is not this vault’s, before anything is written', () => {
    const untouched = newVault();
    const before = readFileSync(join(untouched, 'keyset.json'), 'utf8');

    expect(() =>
      open(untouched, PHONE).rekey({ passphrase: 'not the passphrase', deviceKeys: [PHONE] }),
    ).toThrow(VaultError);

    // The check earns its extra derivation only if it happens FIRST: a re-key builds the new
    // keyset from the passphrase it is handed, so proceeding on a typo would leave a vault whose
    // only passphrase wrap opens with a string nobody knows.
    expect(readFileSync(join(untouched, 'keyset.json'), 'utf8')).toBe(before);
    expect(open(untouched, LAPTOP).listCommitments(p0.personaId)).toHaveLength(1);
  });
});

/**
 * One theft, one re-key, one promise recorded afterwards — and then both halves of the answer
 * read off the same directory, which is the only way the two are comparable at all.
 */
describe('what a re-key does not reach, asserted rather than promised', () => {
  let stolen: string;
  let oldKey: string;
  let freshHash: string;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'servanda-revoke-after-'));
    cpSync(template, dir, { recursive: true });
    const vault = open(dir, PHONE);
    vault.rekey({ passphrase: PASSPHRASE, deviceKeys: [PHONE] });
    vault.putCommitment(p0.personaId, commitment('written after the laptop was lost'));
    freshHash = vault
      .listCommitments(p0.personaId)
      .find((c) => c.commitment.intent === 'written after the laptop was lost')!.hash;

    // The thief has the whole directory as it stands now — working tree, `.git`, everything.
    stolen = mkdtempSync(join(tmpdir(), 'servanda-stolen-'));
    cpSync(dir, stolen, { recursive: true });
    oldKey = oldContentKeyFromHistory(stolen);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  afterAll(() => {
    rmSync(stolen, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('draws a forward boundary: what is written after it is out of the old key’s reach', () => {
    // Not through the laptop's wrap, which is no longer in the keyset …
    expect(() => open(stolen, LAPTOP)).toThrow();
    // … and not through the old content key recovered from history below, because the record was
    // never sealed under it. The record IS in the thief's copy; it is the key that is missing.
    const sealed = JSON.parse(
      readFileSync(join(stolen, 'personas', p0.personaId, 'commitments', `${freshHash}.json`), 'utf8'),
    ) as { ciphertext: string };
    expect(sealed.ciphertext).not.toBe('');
    expect(() => decryptWithOldKey(stolen, oldKey, freshHash)).toThrow();
  });

  it('does NOT close the past: this vault’s own git history hands the old key back', () => {
    // The working tree has been rewritten and the laptop's wrap is gone from `keyset.json`. It is
    // still in `.git`, together with every ciphertext it opened — so the old content key comes
    // straight back, and with it everything the vault held before the re-key.
    //
    // This is the sentence `Vault.rekey` makes in prose, made checkable. If a future change ever
    // purges history to close it, this test is the one that has to be argued with first: the
    // vault's recoverable history is a property §4.2's append-only chains rest on, and any clone
    // or backup keeps its own copy regardless.
    expect(oldKey).toHaveLength(64);
    const hash = historicCommitments(stolen)[0]!;
    expect(decryptWithOldKey(stolen, oldKey, hash)).toContain('send Maria the quote');
  });
});

/**
 * The vault as it stood one commit before the re-key — which is the state a revoked credential
 * can still reach, and the whole subject of the two tests above.
 */
function beforeRekey(dir: string): string {
  const rekeyed = git(dir, ['log', '--format=%H', '-1', '--grep', 'chore(vault): re-key']).trim();
  expect(rekeyed).not.toBe('');
  return git(dir, ['rev-parse', `${rekeyed}^`]).trim();
}

/**
 * Recover the pre-re-key content key the way somebody holding a revoked device key would: read
 * the previous `keyset.json` out of git history and open its device wrap.
 */
function oldContentKeyFromHistory(dir: string): string {
  const keyset = JSON.parse(git(dir, ['show', `${beforeRekey(dir)}:keyset.json`])) as ContentKeySet;
  return Buffer.from(unwrapWithDevice(keyset, LAPTOP.keyHex, LAPTOP.label)).toString('hex');
}

/** The commitment record hashes as of the commit before the re-key. */
function historicCommitments(dir: string): string[] {
  const listing = git(dir, [
    'ls-tree',
    '--name-only',
    `${beforeRekey(dir)}:personas/${p0.personaId}/commitments`,
  ]).trim();
  return listing.split('\n').map((name) => name.replace(/\.json$/, ''));
}

/** Open one commitment record from the thief's copy with the recovered old content key. */
function decryptWithOldKey(dir: string, oldKeyHex: string, hash: string): string {
  const rel = `personas/${p0.personaId}/commitments/${hash}.json`;
  // From history for a record that predates the re-key; from the working tree for one that does
  // not exist there at all, which is the case the forward-boundary test drives.
  let raw: string;
  try {
    raw = git(dir, ['show', `${beforeRekey(dir)}:${rel}`]);
  } catch {
    raw = readFileSync(join(dir, rel), 'utf8');
  }
  const record = JSON.parse(raw) as { nonce: string; ciphertext: string; kind: string };
  return new TextDecoder().decode(
    decryptContent(
      Uint8Array.from(Buffer.from(oldKeyHex, 'hex')),
      { nonce: record.nonce, ciphertext: record.ciphertext },
      recordBinding(dir, join(dir, rel), record.kind),
    ),
  );
}
