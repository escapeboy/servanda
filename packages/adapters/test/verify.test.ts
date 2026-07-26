import { afterAll, describe, expect, it } from 'vitest';
import { verifyAssertionChain } from '@servanda/node';
import { verifyCommitment } from '../src/verify.js';
import {
  assertion,
  ciEnvelope,
  commitment,
  edge,
  NOW,
  OWED_TO,
  OWNER,
  REPO,
  REPO_HEAD,
  workspace,
} from './support/fixture.js';

const repoCtx = { now: NOW, repo: { path: REPO } };

describe('verifyCommitment composes the registry over evidence_refs', () => {
  const ws = workspace({ 'report.md': 'done\n' });
  afterAll(() => ws.cleanup());

  it('merges observations from several adapters into one bundle', () => {
    const outcome = verifyCommitment(
      commitment([
        { kind: 'commit', value: 'branch:main' },
        { kind: 'file', value: 'report.md' },
        { kind: 'envelope', value: 'c'.repeat(64) },
      ]),
      { ...repoCtx, workspace: { root: ws.root }, envelopes: [ciEnvelope()] },
    );
    expect(outcome.verifiable).toBe(true);
    if (!outcome.verifiable) throw new Error('unreachable');
    expect(outcome.bundle.adapters).toEqual(['ci', 'file', 'git']);
    expect(outcome.bundle.observations).toHaveLength(3);
    expect(outcome.bundle.satisfied).toBe(true);
  });

  it('skips a ref no adapter speaks to when something else was observed', () => {
    const outcome = verifyCommitment(
      commitment([
        { kind: 'url', value: 'https://forge.example/pr/1' },
        { kind: 'commit', value: 'branch:main' },
      ]),
      repoCtx,
    );
    expect(outcome.verifiable).toBe(true);
  });

  it('requires every observed ref to hold, not merely one', () => {
    const outcome = verifyCommitment(
      commitment([
        { kind: 'commit', value: 'branch:main' },
        { kind: 'file', value: 'never-written.md' },
      ]),
      { ...repoCtx, workspace: { root: ws.root } },
    );
    expect(outcome.verifiable).toBe(true);
    if (!outcome.verifiable) throw new Error('unreachable');
    expect(outcome.bundle.satisfied).toBe(false);
  });

  it('is not verifiable when the commitment names no evidence at all', () => {
    const outcome = verifyCommitment(commitment([]), repoCtx);
    expect(outcome.verifiable).toBe(false);
    if (outcome.verifiable) throw new Error('unreachable');
    expect(outcome.reason).toBe('no-evidence-refs');
  });

  it('is not verifiable when the only evidence is a url — that would need the network', () => {
    const outcome = verifyCommitment(
      commitment([{ kind: 'url', value: 'https://forge.example/pr/1' }]),
      repoCtx,
    );
    expect(outcome.verifiable).toBe(false);
    if (outcome.verifiable) throw new Error('unreachable');
    expect(outcome.reason).toBe('requires-network');
  });
});

describe('§4.4 on-evidence closure, end to end', () => {
  const onEvidence = edge({ closure_policy: 'on-evidence' });
  const chain = (evidence_hash: string | null) => [
    assertion({
      edge_id: onEvidence.edge_id,
      state: 'proposed',
      by: OWNER,
      asserted_at: '2026-07-01T09:00:00Z',
      evidence_hash: null,
    }),
    assertion({
      edge_id: onEvidence.edge_id,
      state: 'confirmed',
      by: OWED_TO,
      asserted_at: '2026-07-01T10:00:00Z',
      evidence_hash: null,
    }),
    assertion({
      edge_id: onEvidence.edge_id,
      state: 'closed',
      by: OWNER,
      asserted_at: NOW,
      evidence_hash,
    }),
  ];

  it('an adapter observes, the owner signs, and the chain closes', () => {
    const outcome = verifyCommitment(commitment([{ kind: 'commit', value: REPO_HEAD }]), repoCtx);
    expect(outcome.verifiable).toBe(true);
    if (!outcome.verifiable) throw new Error('unreachable');
    expect(outcome.bundle.satisfied).toBe(true);

    const verification = verifyAssertionChain(onEvidence, chain(outcome.evidence_hash));
    expect(verification.outcomes.every((o) => o.accepted)).toBe(true);
    expect(verification.final_state).toBe('closed');
  });

  it('the same closure with a null evidence_hash is discarded', () => {
    const verification = verifyAssertionChain(onEvidence, chain(null));
    expect(verification.final_state).toBe('open');
    expect(verification.outcomes[2]).toEqual({
      index: 2,
      accepted: false,
      rejection_reason: 'evidence-hash-required-for-owner-closure',
    });
  });

  it('a NotVerifiable outcome hands the careless caller exactly that null', () => {
    // No repo in the context, so nothing can be observed. A caller that ignores `verifiable`
    // and reaches for the hash gets null — and the transition table refuses the closure.
    const outcome = verifyCommitment(commitment([{ kind: 'commit', value: REPO_HEAD }]), {
      now: NOW,
    });
    expect(outcome.verifiable).toBe(false);
    expect(outcome.evidence_hash).toBeNull();

    const verification = verifyAssertionChain(onEvidence, chain(outcome.evidence_hash));
    expect(verification.final_state).toBe('open');
    expect(verification.outcomes[2]?.rejection_reason).toBe(
      'evidence-hash-required-for-owner-closure',
    );
  });
});
