import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARGON2ID_CONSTRAINED, derivePersona, mnemonicToSeed } from '@servanda/crypto';
import { PROTOCOL_VERSION, type Commitment } from '@servanda/types';
import { GIT_CONFIG, Vault, type PersonaRecord } from '../src/index.js';

/**
 * §5.4 / M-15, and exactly how far deletion reaches.
 *
 * `retention.ts` used to say "what does not survive is what it said". It does survive: the vault
 * is a git repository, so deleting a record commits the removal and leaves the sealed blob at the
 * parent commit, under the same content key — there is only one. The passphrase that opened it
 * before still opens it.
 *
 * These cases pin BOTH halves, because a claim about deletion is only meaningful with its reach
 * attached. §5.4 now requires an implementation to document which of the two it delivers and
 * forbids presenting the weaker as the stronger; this file is that documentation in executable
 * form, so the day someone moves key material out of the repository, the second case fails and
 * says so rather than quietly becoming a stale comment.
 */

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon art';
const PASSPHRASE = 'correct horse battery staple';
const seed = mnemonicToSeed(MNEMONIC);
const A = derivePersona(seed, 0);
const B = derivePersona(seed, 1);
const SECRET = 'ship the migration before the audit';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function vaultWithDeletedPlaintext() {
  const dir = mkdtempSync(join(tmpdir(), 'servanda-retention-'));
  dirs.push(dir);
  const vault = Vault.create({ dir, passphrase: PASSPHRASE, kdf: ARGON2ID_CONSTRAINED });
  const record: PersonaRecord = {
    persona_id: A.personaId,
    persona_index: 0,
    label: 'me',
    scope_kind: 'personal',
    org_root: null,
    private_key: A.privateKey,
    created_at: '2026-07-25T09:00:00Z',
  };
  vault.putPersona(record);
  const commitment: Commitment = {
    v: PROTOCOL_VERSION,
    type: 'commitment',
    intent: SECRET,
    owner: A.personaId,
    owed_to: B.personaId,
    due: null,
    conditions: [],
    evidence_refs: [],
    created_at: '2026-07-25T09:00:00Z',
    source: 'explicit',
    confidence: 1,
  };
  vault.putCommitment(A.personaId, commitment);
  const [{ hash }] = vault.listCommitments(A.personaId);
  const path = `personas/${A.personaId}/commitments/${hash!}.json`;

  expect(vault.deleteCommitmentPlaintext(A.personaId, hash!)).toBe(true);
  return { dir, vault, hash: hash!, path };
}

const git = (dir: string, args: string[]) =>
  execFileSync('git', [...GIT_CONFIG, ...args], { cwd: dir, encoding: 'utf8' });

describe('§5.4 retention: what deletion reaches, and what it does not', () => {
  it('against a reader of the node, the plaintext is gone', () => {
    const { vault, hash } = vaultWithDeletedPlaintext();
    expect(vault.getCommitment(A.personaId, hash)).toBeNull();
    expect(vault.listCommitments(A.personaId)).toHaveLength(0);
  });

  it('and the proof it existed is kept — that is the half M-15 makes a MUST', () => {
    const { dir, path } = vaultWithDeletedPlaintext();
    // The deletion is a commit of its own, so the record's existence is still on the record.
    expect(git(dir, ['log', '--format=%s', '--', path]).trim().split('\n')).toContain(
      'feat(commitment): record ' + path.split('/').pop()!.slice(0, 12),
    );
  });

  it('against a reader of the REPOSITORY, the sealed blob is still reachable', () => {
    // Not a demonstration that the plaintext leaks — the blob is still sealed. It is a
    // demonstration that the ciphertext survives and that the key which opened it is unchanged,
    // which together are the whole of the gap. Recovering the string needs only the passphrase,
    // which is what a person deleting a record after a retention window believes they no longer
    // need to protect.
    const { dir, path } = vaultWithDeletedPlaintext();
    const blob = git(dir, ['show', `HEAD~1:${path}`]);
    expect(JSON.parse(blob)).toMatchObject({ type: 'vault_record', kind: 'commitment' });
  });

  it('and the content key that opens it is the same one the vault still uses', () => {
    // The load-bearing half. A ciphertext in history would be harmless if the key had moved on;
    // it has not, because rotating it would leave the OLD keyset in the same history.
    const { dir } = vaultWithDeletedPlaintext();
    const keysetNow = git(dir, ['show', 'HEAD:keyset.json']);
    const keysetThen = git(dir, ['show', 'HEAD~2:keyset.json']);
    expect(keysetNow).toBe(keysetThen);
  });
});
