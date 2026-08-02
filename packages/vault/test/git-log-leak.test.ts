import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARGON2ID_CONSTRAINED, derivePersona, edgeId, mnemonicToSeed, withSignature } from '@servanda/crypto';
import { PROTOCOL_VERSION, type Assertion, type Edge } from '@servanda/types';
import { GIT_CONFIG, Vault, type PersonaRecord } from '../src/index.js';

/**
 * The vault seals every record it writes, and then described what it had written in a commit
 * message. `.git` is not encrypted; `git log` needs no key at all.
 *
 * Fifteen of the sixteen messages named a truncated hex identifier, which reveals only that a
 * record exists — and the directory layout reveals that anyway. Two did not. `feat(persona): add
 * <label>` carried a string the user typed, so "work — ACME Corp (CFO channel)" was readable in
 * the clear, and `feat(assertion): <state> on <id>` published the whole state machine of every
 * commitment, dated, to anyone who could read the directory.
 *
 * The rule these pin is one sentence: **a commit message names identifiers, never content.**
 * The second case below is what enforces it going forward, because the first can only catch the
 * canaries it was told about.
 */

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon art';
const PASSPHRASE = 'correct horse battery staple';
const seed = mnemonicToSeed(MNEMONIC);
const p0 = derivePersona(seed, 0);
const p1 = derivePersona(seed, 1);

/** The string a user typed. Distinctive enough that finding it anywhere is unambiguous. */
const CANARY = 'work — ACME Corp (CFO channel)';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const body = {
  commitment_hash: 'a'.repeat(64),
  owner: p0.personaId,
  owed_to: p1.personaId,
  proposed_at: '2026-07-25T09:00:00Z',
};

const EDGE: Edge = {
  v: PROTOCOL_VERSION,
  type: 'edge',
  edge_id: edgeId(body),
  ...body,
  due: null,
  closure_policy: 'on-evidence',
  acceptance_window: null,
  blocked_by: [],
  supersedes: null,
};

function proposed(): Assertion {
  return withSignature(
    {
      v: PROTOCOL_VERSION,
      type: 'assertion' as const,
      edge_id: EDGE.edge_id,
      state: 'proposed' as const,
      asserted_at: '2026-07-25T09:00:00Z',
      by: p0.personaId,
      evidence_hash: null,
    },
    p0.privateKey,
  ) as Assertion;
}

/** A vault exercised through as many of its mutating calls as one persona can reach. */
function busyVault(): string {
  const dir = mkdtempSync(join(tmpdir(), 'servanda-log-'));
  dirs.push(dir);
  const vault = Vault.create({ dir, passphrase: PASSPHRASE, kdf: ARGON2ID_CONSTRAINED });
  const record: PersonaRecord = {
    persona_id: p0.personaId,
    persona_index: 0,
    label: CANARY,
    scope_kind: 'personal',
    org_root: null,
    private_key: p0.privateKey,
    created_at: '2026-07-25T09:00:00Z',
  };
  vault.putPersona(record);
  vault.putEdge(p0.personaId, EDGE);
  vault.appendAssertion(p0.personaId, proposed());
  return dir;
}

/** The whole log — subjects AND bodies — as one blob, exactly as an unauthenticated read sees it. */
function rawLog(dir: string): string {
  return execFileSync('git', [...GIT_CONFIG, 'log', '--format=%B'], { cwd: dir, encoding: 'utf8' });
}

function subjects(dir: string): string[] {
  return execFileSync('git', [...GIT_CONFIG, 'log', '--format=%s'], { cwd: dir, encoding: 'utf8' })
    .trim()
    .split('\n');
}

describe('the vault commits identifiers, never content', () => {
  it('a persona label the user typed does not appear in the log', () => {
    const log = rawLog(busyVault());
    expect(log).not.toContain(CANARY);
    expect(log).not.toContain('ACME');
    // And the persona is still identified, so the message did not lose its purpose.
    expect(log).toContain(p0.personaId.slice(0, 12));
  });

  it('nor does the state of an assertion', () => {
    expect(rawLog(busyVault())).not.toContain('proposed');
  });

  /**
   * The exhaustive form. Every distinct subject the vault can produce, with hex identifiers and
   * day counts masked out, must be one of these — so a message that grows a new field fails here
   * rather than quietly shipping whatever that field holds. It is a frozen SET, not a prefix
   * check: `feat(persona): add …` passed a `startsWith` assertion for as long as the label was
   * in it.
   */
  it('every commit subject reduces to a known template', () => {
    const KNOWN = new Set([
      'chore(vault): initialise vault',
      'chore(retention): window <n>d',
      'chore(retention): delete plaintext <id>',
      'chore(edge): meta <id>',
      'chore(pending): dequeue <id>',
      'feat(persona): add <id>',
      'feat(commitment): record <id>',
      'feat(expectation): record <id>',
      'feat(edge): <id>',
      'feat(assertion): <id>',
      'feat(publish): <id> → <id>',
      'feat(attestation): <id>',
      'feat(revocation): <id>',
      'feat(anchor): <id>',
      'feat(pending): queue <id>',
      'feat(outbox): queue <id>',
    ]);
    const masked = subjects(busyVault()).map((s) =>
      s.replace(/[0-9a-f]{12}/g, '<id>').replace(/\b\d+d\b/, '<n>d'),
    );
    expect(masked.length).toBeGreaterThan(0);
    for (const m of masked) expect(KNOWN, m).toContain(m);
  });
});
