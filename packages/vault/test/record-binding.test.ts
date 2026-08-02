import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARGON2ID_CONSTRAINED, derivePersona, mnemonicToSeed } from '@servanda/crypto';
import { PROTOCOL_VERSION, type Commitment } from '@servanda/types';
import { Vault, type PersonaRecord } from '../src/index.js';

/**
 * §5.3 / M-5: "No org-context mixing in any pipeline."
 *
 * Every record in a vault is sealed under ONE content key, and until this was bound, that was all
 * a sealed record committed to. So a file lifted out of persona A's directory and dropped into
 * persona B's decrypted perfectly and was served as B's — a content transfer across the org
 * boundary performed by somebody who **cannot decrypt anything**, holds no key, and does not
 * touch a byte of ciphertext. Every guard the vault had ran against the path the attacker chose:
 * `assertHexId` saw a well-formed hex id, `requirePersona` saw a persona that exists, and the
 * AEAD saw a ciphertext that authenticates, because it did.
 *
 * The fix is that the AEAD now authenticates WHERE the record is, recomputed from the location
 * rather than read from the file. What that buys is stated narrowly below: it does not stop
 * anyone deleting a record, or copying one out of the vault, or reading a record they hold the
 * key for. It stops a record being read as belonging to somewhere it was not sealed for.
 */

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon art';
const PASSPHRASE = 'correct horse battery staple';
const seed = mnemonicToSeed(MNEMONIC);
const A = derivePersona(seed, 0);
const B = derivePersona(seed, 1);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function record(p: ReturnType<typeof derivePersona>, index: number, label: string): PersonaRecord {
  return {
    persona_id: p.personaId,
    persona_index: index,
    label,
    scope_kind: index === 0 ? 'personal' : 'org',
    org_root: null,
    private_key: p.privateKey,
    created_at: '2026-07-25T09:00:00Z',
  };
}

function commitment(intent: string): Commitment {
  return {
    v: PROTOCOL_VERSION,
    type: 'commitment',
    intent,
    owner: A.personaId,
    owed_to: B.personaId,
    due: null,
    conditions: [],
    evidence_refs: [],
    created_at: '2026-07-25T09:00:00Z',
    source: 'explicit',
    confidence: 1,
  };
}

const SECRET = 'the acquisition closes on the fourteenth';

function twoPersonaVault() {
  const dir = mkdtempSync(join(tmpdir(), 'servanda-binding-'));
  dirs.push(dir);
  const vault = Vault.create({ dir, passphrase: PASSPHRASE, kdf: ARGON2ID_CONSTRAINED });
  vault.putPersona(record(A, 0, 'personal'));
  vault.putPersona(record(B, 1, 'work'));
  vault.putCommitment(A.personaId, commitment(SECRET));
  const [{ hash }] = vault.listCommitments(A.personaId);
  return { dir, vault, hash: hash!, pathIn: (persona: string) =>
    join(dir, 'personas', persona, 'commitments', `${hash}.json`) };
}

describe('a sealed record is bound to where it is sealed', () => {
  it('a record relocated to another persona does not open there', () => {
    const { vault, pathIn } = twoPersonaVault();
    mkdirSync(join(pathIn(B.personaId), '..'), { recursive: true });
    copyFileSync(pathIn(A.personaId), pathIn(B.personaId));

    // The file is byte-identical and the content key is the same one. Only the location differs.
    expect(readFileSync(pathIn(B.personaId), 'utf8')).toBe(readFileSync(pathIn(A.personaId), 'utf8'));
    expect(() => vault.listCommitments(B.personaId)).toThrow();
  });

  it('and the original still opens where it belongs', () => {
    // The negative above would pass just as well if the binding had broken everything.
    const { vault, pathIn } = twoPersonaVault();
    mkdirSync(join(pathIn(B.personaId), '..'), { recursive: true });
    copyFileSync(pathIn(A.personaId), pathIn(B.personaId));
    expect(vault.listCommitments(A.personaId)[0]?.commitment.intent).toBe(SECRET);
  });

  it('a record refiled under a different id in its own persona does not open either', () => {
    // The id is part of the path, so this is the same attack at a smaller radius: presenting one
    // commitment as another within a single persona's own subtree.
    const { dir, vault, hash } = twoPersonaVault();
    const from = join(dir, 'personas', A.personaId, 'commitments', `${hash}.json`);
    const to = join(dir, 'personas', A.personaId, 'commitments', `${'b'.repeat(64)}.json`);
    copyFileSync(from, to);
    expect(() => vault.listCommitments(A.personaId)).toThrow();
  });

  it('a record re-labelled with another `kind` does not open', () => {
    // `kind` is the one claim the record makes about itself that its path does not repeat, so it
    // is bound too — otherwise an expectation could be presented as a commitment in place.
    const { vault, pathIn } = twoPersonaVault();
    const path = pathIn(A.personaId);
    const sealed = JSON.parse(readFileSync(path, 'utf8')) as { kind: string };
    writeFileSync(path, JSON.stringify({ ...sealed, kind: 'expectation' }));
    expect(() => vault.listCommitments(A.personaId)).toThrow();
  });

  it('a vault survives being moved as a whole', () => {
    // The binding is vault-RELATIVE, which is the difference between binding a record to its
    // place in a vault and binding a vault to a directory on one machine. A vault that could not
    // be moved or restored from a backup would be a worse failure than the one this fixes.
    const { dir, hash } = twoPersonaVault();
    const moved = mkdtempSync(join(tmpdir(), 'servanda-moved-'));
    dirs.push(moved);
    rmSync(moved, { recursive: true, force: true });
    cpSync(dir, moved, { recursive: true });

    const reopened = Vault.open({ dir: moved, passphrase: PASSPHRASE });
    expect(reopened.getCommitment(A.personaId, hash)?.intent).toBe(SECRET);
  });
});
