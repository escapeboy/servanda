import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Envelope } from '@servanda/types';
import { GithubConnector } from '../src/index.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const FIXTURE = resolve(ROOT, 'fixtures/archaeology-repo/repo');

/** Pinned in fixtures/archaeology-repo/EXPECTED.md. */
const FIXTURE_HEAD = '8779acbf1753fc5ddf67a3ae76434880d171a710';

const PERSONA = 'a'.repeat(64);
const OTHER_PERSONA = 'b'.repeat(64);
/** Fixed instant: an age that depends on the wall clock is not a testable finding. */
const REFERENCE = '2026-01-01T00:00:00Z';
const RECEIVED = '2026-01-01T00:00:00Z';

function mine(persona = PERSONA) {
  return new GithubConnector({ persona }).archaeology({
    repoPath: FIXTURE,
    receivedAt: RECEIVED,
    referenceTime: REFERENCE,
  });
}

beforeAll(() => {
  if (!existsSync(resolve(FIXTURE, '.git'))) {
    execFileSync('bash', [resolve(ROOT, 'fixtures/archaeology-repo/setup.sh')], { stdio: 'inherit' });
  }
});

describe('archaeology fixture is the pinned repository', () => {
  it('generates the documented HEAD, which is what proves the generator reproducible', () => {
    const head = execFileSync('git', ['-C', FIXTURE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(head).toBe(FIXTURE_HEAD);
  });
});

describe('archaeology finds exactly the planted findings', () => {
  it('emits one envelope per planted finding and nothing else', () => {
    const envelopes = mine();
    expect(envelopes.map((e) => `${e.kind} ${String(e.payload['file'] ?? e.payload['branch'])}`)).toEqual([
      'archaeology_todo src/auth.ts',
      'archaeology_todo src/notes.ts',
      'archaeology_todo src/payments.ts',
      'archaeology_stale_branch feature/abandoned-redesign',
      'archaeology_dead_flag src/flags.ts',
      'archaeology_unrun_migration migrations/0003_add_orders.sql',
    ]);
  });

  it('dates each finding from its own git history, not from the clock', () => {
    const byKind = new Map(mine().map((e) => [`${e.kind}:${String(e.payload['file'] ?? e.payload['flag'])}`, e]));
    expect(byKind.get('archaeology_todo:src/payments.ts')?.occurred_at).toBe('2022-06-15T11:30:00Z');
    expect(byKind.get('archaeology_todo:src/payments.ts')?.payload['age_days']).toBe(1295);
    expect(byKind.get('archaeology_todo:src/auth.ts')?.payload['marker']).toBe('FIXME');
  });

  it('reports the abandoned branch and not the fresh one', () => {
    const stale = mine().filter((e) => e.kind === 'archaeology_stale_branch');
    expect(stale.map((e) => e.payload['branch'])).toEqual(['feature/abandoned-redesign']);
  });

  it('reports the unreferenced flag and not the one checkout.ts reads', () => {
    const flags = mine().filter((e) => e.kind === 'archaeology_dead_flag');
    expect(flags.map((e) => e.payload['flag'])).toEqual(['FEATURE_LEGACY_IMPORT']);
  });

  it('reports the migration missing from applied.txt and not the applied ones', () => {
    const migrations = mine().filter((e) => e.kind === 'archaeology_unrun_migration');
    expect(migrations.map((e) => e.payload['migration_id'])).toEqual(['0003_add_orders']);
  });

  it('produces no finding for the control files', () => {
    const touched = new Set(mine().map((e) => String(e.payload['file'] ?? '')));
    for (const clean of ['README.md', 'src/clean.ts', 'src/checkout.ts', 'migrations/0001_init.sql', 'migrations/0002_add_users.sql', 'migrations/applied.txt']) {
      expect(touched.has(clean)).toBe(false);
    }
  });

  it('carries enough in payload/refs for §3.1 extraction: intent text, author, when, where', () => {
    const todo = mine().find((e) => e.payload['file'] === 'src/payments.ts');
    expect(todo?.payload['text']).toBe('handle partial refunds before the EU launch');
    expect(todo?.actor.label).toBe('Fixture Author');
    expect(todo?.refs).toEqual([
      { kind: 'file', value: 'src/payments.ts:3' },
      { kind: 'commit', value: expect.stringMatching(/^[0-9a-f]{40}$/u) },
    ]);
  });
});

describe('archaeology is deterministic', () => {
  it('two runs over the same fixture state are byte-identical, ids and order included', () => {
    const first = JSON.stringify(mine());
    const second = JSON.stringify(mine());
    expect(second).toBe(first);
  });

  it('every id is the sha256 of the domain tag and the canonical form sans id', async () => {
    const { envelopeId } = await import('@servanda/crypto');
    const { UnidentifiedEnvelope } = await import('@servanda/types');
    for (const envelope of mine()) {
      const { id, ...rest } = envelope;
      expect(id).toBe(envelopeId(UnidentifiedEnvelope.parse(rest)));
    }
  });

  it('a different persona changes every id: envelopes are persona-scoped by construction', () => {
    const mineIds = mine().map((e) => e.id);
    const theirIds = mine(OTHER_PERSONA).map((e) => e.id);
    expect(mineIds).not.toEqual(theirIds);
    expect(new Set([...mineIds, ...theirIds]).size).toBe(mineIds.length + theirIds.length);
  });

  it('emits only valid §2 envelopes', () => {
    for (const envelope of mine()) {
      expect(() => Envelope.parse(envelope)).not.toThrow();
    }
  });
});
