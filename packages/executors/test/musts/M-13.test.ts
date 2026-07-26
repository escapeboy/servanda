import { describe, expect, it } from 'vitest';
import { DraftPrArtifact, runExecutor, SandboxRequest } from '../../src/index.js';
import { COMMITMENT, FIXTURE_REPO, hashTree, PERSONA } from '../support/fixture.js';

/**
 * M-13: agents are never parties. Signing keys belong to personas and groups; automation acts
 * **under** a persona, never **as** one.
 *
 * In this layer that has a precise meaning: an executor run produces an unsigned draft. It is
 * attributed — you can see whose queue it belongs in — and it is not a promise, because nothing
 * signed it and nothing could have. The tests below hold both halves down: the artifact cannot
 * carry a signature, and no key can reach the process that produced it.
 */
describe('M-13: agents are never parties — automation acts under a persona, never as one', () => {
  it('produces an artifact attributed to the persona and signed by nobody', async () => {
    const outcome = await runExecutor({
      executorClass: 'dead-code',
      commitment: COMMITMENT,
      target: { kind: 'symbol', symbol: 'FEATURE_LEGACY_IMPORT', path: 'src/flags.ts' },
      persona: PERSONA,
      repo: { path: FIXTURE_REPO },
      now: '2026-07-26T10:00:00Z',
    });

    expect(outcome.kind).toBe('artifact');
    if (outcome.kind !== 'artifact') throw new Error('unreachable');
    expect(outcome.artifact.acting_under).toBe(PERSONA);
    expect(outcome.artifact.signed_by).toBeNull();
    expect(outcome.artifact.draft).toBe(true);
    expect(outcome.artifact.body).toContain('Automation is never a party');
  });

  it('cannot describe a signed artifact at all — the schema has no room for one', () => {
    const base = {
      v: 'servanda/0.1',
      type: 'draft_pr_artifact',
      executor_class: 'dead-code',
      risk_class: 'routine',
      commitment_hash: 'b'.repeat(64),
      acting_under: PERSONA,
      signed_by: null,
      draft: true,
      base: { repo_path: '/tmp/x', base_commit: 'abc', base_branch: 'main' },
      branch: 'servanda/dead-code/bbbbbbbbbbbb',
      title: 't',
      body: 'b',
      changes: [],
      diff: '',
      capabilities: { read: ['src/**'], write: ['src/**'], max_changed_lines: 1, max_changed_files: 1 },
      autonomy: {
        level: 'draft-for-review',
        earned: 'draft-for-review',
        ceiling: 'silent-with-receipt',
        capped_by: null,
        applies_at: null,
      },
      created_at: '2026-07-26T10:00:00Z',
    };
    expect(DraftPrArtifact.safeParse(base).success).toBe(true);

    // A signature is not "rejected by a check" — it is not expressible.
    expect(DraftPrArtifact.safeParse({ ...base, signed_by: 'f'.repeat(128) }).success).toBe(false);
    // Nor can automation demote the artifact out of draft.
    expect(DraftPrArtifact.safeParse({ ...base, draft: false }).success).toBe(false);
    // Nor can it smuggle a signature in beside the schema.
    expect(DraftPrArtifact.safeParse({ ...base, signature: 'f'.repeat(128) }).success).toBe(false);
  });

  it('hands the executor process no key material of any kind', () => {
    const request = {
      executor_class: 'dead-code',
      commitment: COMMITMENT,
      target: { kind: 'symbol', symbol: 'X', path: 'src/flags.ts' },
      persona: PERSONA,
      now: '2026-07-26T10:00:00Z',
      snapshot: {},
    };
    expect(SandboxRequest.safeParse(request).success).toBe(true);

    // The wire is strict, so a key cannot ride along beside the fields that belong there.
    for (const extra of [
      { private_key: 'f'.repeat(64) },
      { keyset: { wraps: [] } },
      { signing_key: 'f'.repeat(64) },
      { env: { GITHUB_TOKEN: 'ghp_x' } },
    ]) {
      expect(SandboxRequest.safeParse({ ...request, ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
  });

  it('leaves the repository untouched — an artifact is a proposal, not an act', async () => {
    const before = hashTree(FIXTURE_REPO);
    await runExecutor({
      executorClass: 'dead-code',
      commitment: COMMITMENT,
      target: { kind: 'symbol', symbol: 'FEATURE_LEGACY_IMPORT', path: 'src/flags.ts' },
      persona: PERSONA,
      repo: { path: FIXTURE_REPO },
      now: '2026-07-26T10:00:00Z',
    });
    expect(hashTree(FIXTURE_REPO)).toBe(before);
  });
});
