import { describe, expect, it } from 'vitest';
import { effectiveAutonomy, emptyTrustRecord, runExecutor } from '../../src/index.js';
import type { TrustRecord } from '../../src/index.js';
import { COMMITMENT, FIXTURE_REPO, PERSONA } from '../support/fixture.js';

/**
 * M-8: unverifiable edges MUST NOT auto-escalate.
 *
 * The executor layer is where that MUST becomes expensive to ignore, because this is the layer
 * that would do the escalating. An executor artifact is a *proposal*, never a verification — so
 * however much autonomy a class has earned, an artifact serving a commitment whose edge no
 * adapter can check stays at draft-for-review. Autonomy buys the right to skip review. It never
 * buys the right to skip evidence.
 */
describe('M-8: an unverifiable edge never auto-escalates, however much trust exists', () => {
  const veteran: TrustRecord = {
    ...emptyTrustRecord(PERSONA, 'tests', '2026-07-26T10:00:00Z'),
    streak: 99,
    approvals: 99,
  };

  it('holds a maximally trusted class at draft-for-review when there is no adapter', () => {
    const decision = effectiveAutonomy({
      record: veteran,
      ceiling: 'silent-with-receipt',
      edgeVerifiable: null,
    });
    expect(decision.earned).toBe('silent-with-receipt');
    expect(decision.level).toBe('draft-for-review');
    expect(decision.cappedBy).toBe('unverifiable-edge');
  });

  it('does the same when an adapter exists but has not verified', () => {
    const decision = effectiveAutonomy({
      record: veteran,
      ceiling: 'silent-with-receipt',
      edgeVerifiable: false,
    });
    expect(decision.level).toBe('draft-for-review');
    expect(decision.cappedBy).toBe('unverifiable-edge');
  });

  it('releases the earned level once the edge is actually verifiable', () => {
    const decision = effectiveAutonomy({
      record: veteran,
      ceiling: 'silent-with-receipt',
      edgeVerifiable: true,
    });
    expect(decision.level).toBe('silent-with-receipt');
    expect(decision.cappedBy).toBeNull();
  });

  it('applies the rule to a real run: no verification, no window, no clock', async () => {
    const unverified = await runExecutor({
      executorClass: 'dead-code',
      commitment: COMMITMENT,
      target: { kind: 'symbol', symbol: 'FEATURE_LEGACY_IMPORT', path: 'src/flags.ts' },
      persona: PERSONA,
      repo: { path: FIXTURE_REPO },
      trust: { ...veteran, work_class: 'dead-code' },
      // Deliberately omitted: the caller could not say the edge was verifiable.
      now: '2026-07-26T10:00:00Z',
    });
    expect(unverified.kind).toBe('artifact');
    if (unverified.kind !== 'artifact') throw new Error('unreachable');
    expect(unverified.artifact.autonomy.level).toBe('draft-for-review');
    expect(unverified.artifact.autonomy.earned).toBe('silent-with-receipt');
    expect(unverified.artifact.autonomy.capped_by).toBe('unverifiable-edge');
    // A draft has no clock. The window only exists at the level that has one.
    expect(unverified.artifact.autonomy.applies_at).toBeNull();

    const verified = await runExecutor({
      executorClass: 'dead-code',
      commitment: COMMITMENT,
      target: { kind: 'symbol', symbol: 'FEATURE_LEGACY_IMPORT', path: 'src/flags.ts' },
      persona: PERSONA,
      repo: { path: FIXTURE_REPO },
      trust: { ...veteran, work_class: 'dead-code' },
      edgeVerifiable: true,
      now: '2026-07-26T10:00:00Z',
    });
    if (verified.kind !== 'artifact') throw new Error('unreachable');
    expect(verified.artifact.autonomy.level).toBe('silent-with-receipt');
  });

  it('gives an auto-apply artifact a stated deadline, and only that level a deadline', async () => {
    const record: TrustRecord = {
      ...emptyTrustRecord(PERSONA, 'dep-bump', '2026-07-26T10:00:00Z'),
      streak: 3,
      approvals: 3,
    };
    const outcome = await runExecutor({
      executorClass: 'dead-code',
      commitment: COMMITMENT,
      target: { kind: 'symbol', symbol: 'FEATURE_LEGACY_IMPORT', path: 'src/flags.ts' },
      persona: PERSONA,
      repo: { path: FIXTURE_REPO },
      trust: { ...record, work_class: 'dead-code' },
      edgeVerifiable: true,
      now: '2026-07-26T10:00:00Z',
    });
    if (outcome.kind !== 'artifact') throw new Error('unreachable');
    expect(outcome.artifact.autonomy.level).toBe('auto-apply-with-window');
    expect(outcome.artifact.autonomy.applies_at).toBe('2026-07-27T10:00:00Z');
  });
});
