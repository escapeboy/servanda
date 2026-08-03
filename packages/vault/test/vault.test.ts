import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARGON2ID_CONSTRAINED, derivePersona, edgeId, mnemonicToSeed, withSignature } from '@servanda/crypto';
import { PROTOCOL_VERSION, type Assertion, type Commitment, type Edge } from '@servanda/types';
import { GIT_CONFIG, logMessages, ScopeViolation, Vault, VaultGitError, type PersonaRecord } from '../src/index.js';

/**
 * @servanda/vault — the sovereign local store (L0).
 *
 * The three properties that make it a vault rather than a directory: encrypted at rest,
 * git-backed, persona-scoped. The MUSTs it carries (M-5, M-15, M-16) have their own named
 * tests in packages/node/test/musts; this file covers the store's own contract.
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

function newVault(): { dir: string; vault: Vault } {
  const dir = mkdtempSync(join(tmpdir(), 'servanda-vault-test-'));
  dirs.push(dir);
  const vault = Vault.create({ dir, passphrase: PASSPHRASE, kdf: ARGON2ID_CONSTRAINED });
  vault.putPersona(personaRecord(p0, 0, 'me'));
  vault.putPersona(personaRecord(p1, 1, 'them'));
  return { dir, vault };
}

function personaRecord(
  derived: ReturnType<typeof derivePersona>,
  index: number,
  label: string,
): PersonaRecord {
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

function commitment(intent: string): Commitment {
  return {
    v: PROTOCOL_VERSION,
    type: 'commitment',
    intent,
    owner: p0.personaId,
    owed_to: p1.personaId,
    due: null,
    conditions: [],
    evidence_refs: [],
    created_at: '2026-07-25T09:00:00Z',
    source: 'explicit',
    confidence: 1,
  };
}

/**
 * §4.1: an `edge_id` is the digest of its own body, and `putEdge` refuses one that is not — so
 * a literal stand-in id no longer names an edge any vault would store.
 */
function edge(): Edge {
  const body = {
    commitment_hash: 'a'.repeat(64),
    owner: p0.personaId,
    owed_to: p1.personaId,
    proposed_at: '2026-07-25T09:00:00Z',
  };
  return {
    v: PROTOCOL_VERSION,
    type: 'edge',
    edge_id: edgeId(body),
    ...body,
    due: null,
    closure_policy: 'on-acceptance',
    acceptance_window: 'P5D',
    blocked_by: [],
    supersedes: null,
  };
}

function assertion(edgeIdHex: string, state: 'proposed' | 'confirmed'): Assertion {
  const by = state === 'proposed' ? p0 : p1;
  return withSignature(
    {
      v: PROTOCOL_VERSION,
      type: 'assertion' as const,
      edge_id: edgeIdHex,
      state,
      asserted_at: '2026-07-25T09:00:00Z',
      by: by.personaId,
      evidence_hash: null,
    },
    by.privateKey,
  ) as Assertion;
}

describe('vault: encrypted at rest', () => {
  it('stores no record in the clear', () => {
    const { dir, vault } = newVault();
    vault.putCommitment(p0.personaId, commitment('a very distinctive secret'));

    const [{ hash }] = vault.listCommitments(p0.personaId);
    const raw = readFileSync(
      join(dir, 'personas', p0.personaId, 'commitments', `${hash}.json`),
      'utf8',
    );
    expect(raw).not.toContain('a very distinctive secret');
    expect(JSON.parse(raw)).toMatchObject({ type: 'vault_record', kind: 'commitment' });
  });

  it('round-trips through a re-open with the passphrase', () => {
    const { dir, vault } = newVault();
    vault.putCommitment(p0.personaId, commitment('round trip'));
    const reopened = Vault.open({ dir, passphrase: PASSPHRASE });
    expect(reopened.listCommitments(p0.personaId)[0]?.commitment.intent).toBe('round trip');
  });

  it('refuses to open with the wrong passphrase', () => {
    const { dir } = newVault();
    expect(() => Vault.open({ dir, passphrase: 'wrong' })).toThrow();
  });
});

describe('vault: git-backed', () => {
  it('commits every mutation to its own repository', () => {
    const { dir, vault } = newVault();
    vault.putCommitment(p0.personaId, commitment('tracked'));
    const messages = logMessages(dir);
    expect(messages.some((m) => m.startsWith('feat(commitment):'))).toBe(true);
    expect(messages.some((m) => m.startsWith('feat(persona):'))).toBe(true);
    expect(messages.at(-1)).toBe('chore(vault): initialise vault');
  });

  it('refuses to run git against a directory that is not its own repository root', () => {
    // The guard that keeps a vault nested inside another repo from committing to the parent.
    const outside = mkdtempSync(join(tmpdir(), 'not-a-vault-'));
    dirs.push(outside);
    expect(() => logMessages(outside)).toThrow(VaultGitError);
  });

  it('refuses to open a directory carrying no vault marker', () => {
    const outside = mkdtempSync(join(tmpdir(), 'not-a-vault-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'keyset.json'), '{}');
    expect(() => Vault.open({ dir: outside, passphrase: PASSPHRASE })).toThrow(VaultGitError);
  });
});

describe('vault: append-only assertion chains (§4.2)', () => {
  it('appends in order and never overwrites', () => {
    const { dir, vault } = newVault();
    const e = edge();
    const id = e.edge_id;
    vault.putEdge(p0.personaId, e);
    expect(vault.appendAssertion(p0.personaId, assertion(id, 'proposed'))).toBe(0);
    expect(vault.appendAssertion(p0.personaId, assertion(id, 'confirmed'))).toBe(1);
    expect(vault.getAssertions(p0.personaId, id).map((a) => a.state)).toEqual([
      'proposed',
      'confirmed',
    ]);
    expect(existsSync(join(dir, 'personas', p0.personaId, 'edges', id, 'assertions', '0000.json'))).toBe(
      true,
    );
  });

  it('offers no delete or update for an assertion', () => {
    const surface = Object.getOwnPropertyNames(Vault.prototype);
    expect(surface.filter((n) => /Assertion/.test(n)).sort()).toEqual([
      'appendAssertion',
      'getAssertions',
    ]);
  });
});

describe('vault: persona scoping', () => {
  it('rejects a read for a persona the vault does not hold', () => {
    const { vault } = newVault();
    expect(() => vault.listCommitments(derivePersona(seed, 100).personaId)).toThrow(ScopeViolation);
  });

  it('rejects a non-hex identifier outright', () => {
    const { vault } = newVault();
    expect(() => vault.getCommitment(p0.personaId, '../../etc/passwd')).toThrow(TypeError);
    expect(() => vault.listCommitments('../..')).toThrow(TypeError);
  });

  it('keeps two personas’ records in separate subtrees', () => {
    const { vault } = newVault();
    vault.putCommitment(p0.personaId, commitment('mine'));
    expect(vault.listCommitments(p0.personaId)).toHaveLength(1);
    expect(vault.listCommitments(p1.personaId)).toHaveLength(0);
  });

  it('refuses a label another persona already holds', () => {
    // §1.2 makes a label one of the two ways to name a persona, and `client-local` resolves
    // `SERVANDA_PERSONA` by `persona_id === wanted || label === wanted`, first match wins. A
    // duplicate label therefore does not fail — it silently opens the wrong register.
    //
    // `servanda-init` refuses this, but the guard belonged here: @servanda/vault is published,
    // and every fixture in this repository writes personas through the library, not the CLI.
    const { vault } = newVault();
    expect(() => vault.putPersona(personaRecord(derivePersona(seed, 2), 2, 'me'))).toThrow(
      ScopeViolation,
    );
    expect(vault.listPersonaIds()).toHaveLength(2);
  });

  it('but re-putting the same persona is an update, not a collision', () => {
    // Otherwise a record could never be amended — the persona would collide with itself.
    const { vault } = newVault();
    const amended = { ...personaRecord(p0, 0, 'me'), scope_kind: 'org' as const, org_root: p1.personaId };
    expect(() => vault.putPersona(amended)).not.toThrow();
    expect(vault.getPersona(p0.personaId).scope_kind).toBe('org');
  });
});

describe('vault: nothing keeps writing after a commit returns', () => {
  /**
   * A vault must not mutate itself while its owner believes it is idle, and the way that breaks
   * is invisible in an ordinary assertion: git forks a DETACHED maintenance process after a
   * commit, so every assertion passes and teardown then dies on `ENOTEMPTY .git/objects/pack`
   * — on CI, on some git versions, sometimes.
   *
   * This has been mis-fixed twice: first with `rmSync` retries (treating the symptom), then with
   * `gc.auto=0` (the wrong knob — it tells the gc TASK it has no work, while git still forks the
   * process that decides that). Both looked green locally. So this test observes the fork itself
   * through `GIT_TRACE` rather than waiting to be told about it by a flaky teardown.
   */
  it('forks no background maintenance process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'servanda-vault-trace-'));
    dirs.push(dir);
    const vault = Vault.create({ dir, passphrase: PASSPHRASE, kdf: ARGON2ID_CONSTRAINED });
    vault.putPersona(personaRecord(p0, 0, 'me'));

    // GIT_CONFIG is imported from the vault's own module rather than restated here. A test that
    // spelled the flags out would keep passing if someone changed the real ones, which is the
    // failure mode this whole file exists to stop.
    //
    // GIT_TRACE is pointed at a FILE, not at `1`. git writes the trace to stderr, and
    // `execFileSync` returns stdout only — asserting on its return value compares two empty
    // strings and passes whatever git does. Verified by reverting the fix and watching this go
    // red, which is the only thing that distinguishes a test from a decoration.
    writeFileSync(join(dir, 'trace-probe'), 'x');
    const traceFile = join(dir, 'git-trace.log');
    const run = (args: string[]): void => {
      execFileSync('git', [...GIT_CONFIG, ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, GIT_TRACE: traceFile },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    };
    run(['add', '-A']);
    run(['commit', '--quiet', '-m', 'probe']);
    const trace = readFileSync(traceFile, 'utf8');
    expect(trace).toMatch(/run_command|built-in/); // the trace really was captured
    expect(trace).not.toMatch(/run_command:.*maintenance/);
    expect(trace).not.toMatch(/run_command:.*gc /);
  });
});
