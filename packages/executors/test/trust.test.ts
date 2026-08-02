import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readHead } from '../src/sandbox/run.js';
import { ARGON2ID_CONSTRAINED, derivePersona, mnemonicToSeed } from '@servanda/crypto';
import { Vault } from '@servanda/vault';
import {
  applyOutcome,
  ceilingFor,
  collapseCost,
  effectiveAutonomy,
  emptyTrustRecord,
  getExecutorClass,
  isSensitivePath,
  levelFromHistory,
  PROMOTION_THRESHOLDS,
  RISK_CEILING,
  TrustStore,
} from '../src/index.js';
import type { ReviewOutcome, TrustRecord } from '../src/index.js';
import { PERSONA } from './support/fixture.js';

const NOW = '2026-07-26T10:00:00Z';
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon art';
const PASSPHRASE = 'correct horse battery staple';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function run(record: TrustRecord, outcomes: ReviewOutcome['kind'][]): TrustRecord {
  return outcomes.reduce((acc, kind) => applyOutcome(acc, { kind } as ReviewOutcome, NOW), record);
}

describe('trust gradient — autonomy is a measured quantity, not a permission', () => {
  const fresh = (): TrustRecord => emptyTrustRecord(PERSONA, 'tests', NOW);

  it('starts every (human, class) at the floor', () => {
    expect(levelFromHistory(fresh())).toBe('draft-for-review');
  });

  it('rises on unedited approvals, at the documented thresholds', () => {
    expect(levelFromHistory(run(fresh(), ['approved', 'approved']))).toBe('draft-for-review');
    expect(levelFromHistory(run(fresh(), Array<'approved'>(3).fill('approved')))).toBe(
      'auto-apply-with-window',
    );
    expect(levelFromHistory(run(fresh(), Array<'approved'>(6).fill('approved')))).toBe(
      'silent-with-receipt',
    );
  });

  it('does not rise on an approval that carried edits', () => {
    const record = run(fresh(), ['approved', 'approved', 'approved-with-edits', 'approved']);
    expect(record.streak).toBe(3);
    expect(record.edited_approvals).toBe(1);
    // Three unedited approvals, so it advances — the edited one neither helped nor hurt.
    expect(levelFromHistory(record)).toBe('auto-apply-with-window');
  });

  it('collapses to the floor on one correction — asymmetrically', () => {
    const earned = run(fresh(), Array<'approved'>(6).fill('approved'));
    expect(levelFromHistory(earned)).toBe('silent-with-receipt');

    const corrected = run(earned, ['corrected']);
    expect(levelFromHistory(corrected)).toBe('draft-for-review');
    expect(corrected.corrections).toBe(1);
    // The asymmetry, stated as a number: one correction costs six approvals of progress.
    expect(collapseCost('silent-with-receipt')).toBe(6);
    expect(collapseCost('silent-with-receipt')).toBeGreaterThan(1);

    // And recovery really does cost that much.
    expect(levelFromHistory(run(corrected, Array<'approved'>(5).fill('approved')))).toBe(
      'auto-apply-with-window',
    );
    expect(levelFromHistory(run(corrected, Array<'approved'>(6).fill('approved')))).toBe(
      'silent-with-receipt',
    );
  });

  it('keeps the level derivable from history alone — there is no level to tamper with', () => {
    const record = run(fresh(), ['approved', 'approved', 'approved']);
    expect(Object.keys(record).sort()).toEqual([
      'approvals',
      'corrections',
      'edited_approvals',
      'persona',
      'streak',
      'type',
      'updated_at',
      'v',
      'work_class',
    ]);
    expect(levelFromHistory(record)).toBe(levelFromHistory({ ...record }));
  });
});

describe('ceilings — a property of the class, not of accumulated trust', () => {
  it('caps a supply-chain class below silent regardless of history (scenario 6)', () => {
    // The patient attacker: fifty flawless artifacts, no corrections, perfect record.
    const flawless = run(
      emptyTrustRecord(PERSONA, 'dep-bump', NOW),
      Array<'approved'>(50).fill('approved'),
    );
    expect(flawless.streak).toBe(50);
    expect(levelFromHistory(flawless)).toBe('silent-with-receipt');

    const decision = effectiveAutonomy({
      record: flawless,
      ceiling: ceilingFor(getExecutorClass('dep-bump').riskClass),
      edgeVerifiable: true,
    });
    expect(decision.earned).toBe('silent-with-receipt');
    expect(decision.level).toBe('auto-apply-with-window');
    expect(decision.level).not.toBe('silent-with-receipt');
    expect(decision.cappedBy).toBe('ceiling');
  });

  it('caps anything touching CI config at draft-for-review, whatever produced it', () => {
    const flawless = run(emptyTrustRecord(PERSONA, 'tests', NOW), Array<'approved'>(50).fill('approved'));
    expect(ceilingFor('routine', ['.github/workflows/ci.yml'])).toBe('draft-for-review');
    const decision = effectiveAutonomy({
      record: flawless,
      ceiling: ceilingFor('routine', ['.github/workflows/ci.yml']),
      edgeVerifiable: true,
    });
    expect(decision.level).toBe('draft-for-review');
    expect(decision.cappedBy).toBe('ceiling');
  });

  it('recognises the sensitive blast radius by path', () => {
    for (const path of [
      '.github/workflows/release.yml',
      '.gitlab-ci.yml',
      'Jenkinsfile',
      'src/auth/session.ts',
      'deploy/secrets/prod.json',
      'keys/server.pem',
      '.env.production',
    ]) {
      expect(isSensitivePath(path), path).toBe(true);
    }
    for (const path of ['src/flags.ts', 'test/clean.test.ts', 'package.json', 'README.md']) {
      expect(isSensitivePath(path), path).toBe(false);
    }
  });

  it('recognises it anywhere in the tree, not only at the repo root', () => {
    // The cap is on the blast radius, so where in the tree the CI config lives cannot decide
    // whether it is sensitive. Every glob above was anchored at the root, which in a workspace —
    // this repo is one — misses the ordinary place these files live: a package's own `.github/`
    // and the per-app `.env`. `packages/api/.github/workflows/ci.yml` ran CI exactly as the root
    // one does and scored `routine`.
    for (const path of [
      'packages/api/.github/workflows/ci.yml',
      'apps/web/.env.production',
      'config/.env',
      'sub/Jenkinsfile',
      'sub/.gitlab-ci.yml',
      'tools/.circleci/config.yml',
    ]) {
      expect(isSensitivePath(path), path).toBe(true);
    }
  });

  it('caps an artifact that touches a nested CI config, however good the history', () => {
    const flawless = run(emptyTrustRecord(PERSONA, 'tests', NOW), Array<'approved'>(6).fill('approved'));
    const decision = effectiveAutonomy({
      record: flawless,
      ceiling: ceilingFor('routine', ['packages/api/.github/workflows/ci.yml']),
      edgeVerifiable: true,
    });
    expect(decision.level).toBe('draft-for-review');
    expect(decision.cappedBy).toBe('ceiling');
  });

  it('lets a routine class reach silent — the ceiling is not a blanket refusal', () => {
    const flawless = run(emptyTrustRecord(PERSONA, 'tests', NOW), Array<'approved'>(6).fill('approved'));
    const decision = effectiveAutonomy({
      record: flawless,
      ceiling: ceilingFor('routine', ['test/clean.test.ts']),
      edgeVerifiable: true,
    });
    expect(decision.level).toBe('silent-with-receipt');
  });

  it('pins the ceiling of every registered class', () => {
    expect(RISK_CEILING.routine).toBe('silent-with-receipt');
    expect(RISK_CEILING['supply-chain']).toBe('auto-apply-with-window');
    expect(RISK_CEILING.sensitive).toBe('draft-for-review');
    expect(getExecutorClass('tests').riskClass).toBe('routine');
    expect(getExecutorClass('dead-code').riskClass).toBe('routine');
    expect(getExecutorClass('dep-bump').riskClass).toBe('supply-chain');
    expect(PROMOTION_THRESHOLDS['silent-with-receipt']).toBe(6);
  });
});

describe('trust store — history persisted in the vault, per persona', () => {
  function vaultWithPersona(): { vault: Vault; persona: string } {
    const dir = mkdtempSync(join(tmpdir(), 'servanda-trust-'));
    dirs.push(dir);
    const seed = mnemonicToSeed(MNEMONIC);
    const me = derivePersona(seed, 0);
    const vault = Vault.create({ dir, passphrase: PASSPHRASE, kdf: ARGON2ID_CONSTRAINED });
    vault.putPersona({
      persona_id: me.personaId,
      persona_index: 0,
      label: 'me',
      scope_kind: 'personal',
      org_root: null,
      private_key: me.privateKey,
      created_at: NOW,
    });
    return { vault, persona: me.personaId };
  }

  it('round-trips history through the vault, sealed', () => {
    const { vault, persona } = vaultWithPersona();
    const store = TrustStore.open(vault, PASSPHRASE, () => NOW);

    expect(store.get(persona, 'tests').streak).toBe(0);
    store.record(persona, 'tests', { kind: 'approved' });
    store.record(persona, 'tests', { kind: 'approved' });
    const third = store.record(persona, 'tests', { kind: 'approved' });

    expect(third.streak).toBe(3);
    expect(levelFromHistory(third)).toBe('auto-apply-with-window');

    // A second handle sees the same history: it is in the vault, not in memory.
    const reopened = TrustStore.open(vault, PASSPHRASE, () => NOW);
    expect(reopened.get(persona, 'tests').streak).toBe(3);
    expect(reopened.list(persona).map((r) => r.work_class)).toEqual(['tests']);
  });

  it('keeps classes independent — trust is per (human, work class)', () => {
    const { vault, persona } = vaultWithPersona();
    const store = TrustStore.open(vault, PASSPHRASE, () => NOW);
    for (let i = 0; i < 6; i++) store.record(persona, 'tests', { kind: 'approved' });
    store.record(persona, 'dead-code', { kind: 'approved' });

    expect(levelFromHistory(store.get(persona, 'tests'))).toBe('silent-with-receipt');
    expect(levelFromHistory(store.get(persona, 'dead-code'))).toBe('draft-for-review');
  });

  it('collapses one class without touching another', () => {
    const { vault, persona } = vaultWithPersona();
    const store = TrustStore.open(vault, PASSPHRASE, () => NOW);
    for (let i = 0; i < 6; i++) {
      store.record(persona, 'tests', { kind: 'approved' });
      store.record(persona, 'dead-code', { kind: 'approved' });
    }
    store.record(persona, 'tests', { kind: 'corrected' });

    expect(levelFromHistory(store.get(persona, 'tests'))).toBe('draft-for-review');
    expect(levelFromHistory(store.get(persona, 'dead-code'))).toBe('silent-with-receipt');
  });

  it('refuses a persona the vault does not hold, and an unsafe class name', () => {
    const { vault, persona } = vaultWithPersona();
    const store = TrustStore.open(vault, PASSPHRASE, () => NOW);
    expect(() => store.get('f'.repeat(64), 'tests')).toThrow(/no such persona/);
    expect(() => store.get(persona, '../../escape')).toThrow(/work class/);
    expect(() => store.get('not-hex', 'tests')).toThrow(/64 lowercase hex/);
  });

  it('stores the record sealed, not as readable JSON', () => {
    const { vault, persona } = vaultWithPersona();
    const store = TrustStore.open(vault, PASSPHRASE, () => NOW);
    store.record(persona, 'tests', { kind: 'approved' });
    const raw = readFileSync(join(vault.dir, 'personas', persona, 'trust', 'tests.json'), 'utf8');
    expect(raw).toContain('"ciphertext"');
    expect(raw).not.toContain('"streak"');
  });
});

describe('the sensitive-path list is a denylist, so it must not fail open', () => {
  it('catches a sensitive path whatever its case', () => {
    // On a case-insensitive filesystem `.ENV` and `.env` are the same file. An exact-case check
    // scores the artifact `routine` and hands back a ceiling it never applied.
    for (const p of ['.ENV', 'src/AUTH/token.ts', 'Secrets/prod.yaml', 'deploy/PRIVATE.PEM', 'a/.GitHub/ci.yml']) {
      expect(isSensitivePath(p), p).toBe(true);
    }
  });

  it('still leaves an ordinary path alone', () => {
    for (const p of ['src/index.ts', 'README.md', 'packages/api/handler.ts']) {
      expect(isSensitivePath(p), p).toBe(false);
    }
  });

  it('lowers the ceiling for an upper-cased sensitive path', () => {
    expect(ceilingFor('routine', ['src/AUTH/token.ts'])).toBe(ceilingFor('routine', ['src/auth/token.ts']));
  });
});

describe('readHead works where this repo tells its own agents to work', () => {
  it('follows a `.git` FILE to the real gitdir', () => {
    // A worktree and a submodule both put a `gitdir:` pointer file where a directory is expected.
    // Before this, `readHead` handed the platform's raw ENOTDIR to the caller — an error naming no
    // repository, from the one package that deliberately never runs git.
    const dir = mkdtempSync(join(tmpdir(), 'servanda-worktree-'));
    const real = join(dir, 'real.git');
    mkdirSync(join(real, 'refs', 'heads'), { recursive: true });
    writeFileSync(join(real, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(real, 'refs', 'heads', 'main'), `${'a'.repeat(40)}\n`);
    const work = join(dir, 'work');
    mkdirSync(work);
    writeFileSync(join(work, '.git'), `gitdir: ${real}\n`);

    expect(readHead(work)).toEqual({ commit: 'a'.repeat(40), branch: 'main' });
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
});
