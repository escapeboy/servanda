import { describe, expect, it } from 'vitest';
import {
  confirmProposal,
  createScriptedModelClient,
  EXPECTATION_ONLY,
  Extractor,
  NotProposableError,
  PendingConfirmationQueue,
  PROPOSABLE_AFTER_CONFIRMATION,
  REFLEXIVE,
  route,
  VAULT_LOCAL_COUNTERPARTY_UNRESOLVED,
  isProposable,
} from '../../src/index.js';
import type { ProposableResult, RawExtraction, Routed, RoutingContext } from '../../src/index.js';
import { envelope, PERSONA_A, PERSONA_B } from '../fixtures.js';

/**
 * M-1: a promise is owned by its giver. "They said they would" is an expectation, never a
 * proposal on their behalf (§3.3, §3.4, ADR-0013).
 *
 * The routing function is the enforcement point, so it is what these tests hold down.
 */
describe('M-1: a promise is owned by its giver — you cannot propose someone else’s promise', () => {
  const ctx: RoutingContext = { persona: PERSONA_A, createdAt: '2026-07-25T12:00:00Z' };

  function raw(overrides: Partial<RawExtraction> = {}): RawExtraction {
    return {
      envelope_id: 'e'.repeat(64),
      intent: 'send the signed contract',
      owner: 'local_user',
      owner_label: null,
      owed_to: 'none',
      owed_to_label: null,
      due: null,
      confidence: 0.8,
      quote: 'I will send the signed contract',
      ...overrides,
    } as RawExtraction;
  }

  function routed(overrides: Partial<RawExtraction> = {}, c: RoutingContext = ctx): Routed {
    const outcome = route(raw(overrides), c);
    if (!outcome.ok) throw new Error(`routing failed: ${outcome.failure.detail}`);
    return outcome.routed;
  }

  it('routes a promise made by someone else to an expectation, and builds no commitment', () => {
    const result = routed({ owner: 'other_party', owner_label: 'Ivan', owed_to: 'local_user' });
    expect(result.disposition).toBe(EXPECTATION_ONLY);
    expect(result).not.toHaveProperty('commitment');
    if (result.disposition !== EXPECTATION_ONLY) throw new Error('unreachable');
    expect(result.expectation.type).toBe('expectation');
    expect(result.expectation.from).toBe('Ivan');
    expect(isProposable(result)).toBe(false);
  });

  it('keeps the expectation off the wire even when the other party has a known persona', () => {
    const result = routed(
      { owner: 'other_party', owner_label: 'Ivan', owed_to: 'local_user' },
      { ...ctx, resolveParty: (label) => (label === 'Ivan' ? PERSONA_B : null) },
    );
    expect(result.disposition).toBe(EXPECTATION_ONLY);
    expect(result).not.toHaveProperty('commitment');
    if (result.disposition !== EXPECTATION_ONLY) throw new Error('unreachable');
    // Resolvable identity changes who we are waiting on, not whether we may speak for them.
    expect(result.expectation.from).toBe(PERSONA_B);
  });

  it('never writes an owner other than the node’s own persona', () => {
    for (const owned of ['none', 'local_user', 'other_party'] as const) {
      const result = routed({
        owner: 'other_party',
        owner_label: 'Ivan',
        owed_to: owned,
        owed_to_label: owned === 'other_party' ? 'Maria' : null,
      });
      expect(result.disposition).toBe(EXPECTATION_ONLY);
    }
    const mine = routed();
    if (mine.disposition === EXPECTATION_ONLY) throw new Error('unreachable');
    expect(mine.commitment.owner).toBe(PERSONA_A);
  });

  it('refuses to confirm an expectation as a proposal', () => {
    const result = routed({ owner: 'other_party', owner_label: 'Ivan', owed_to: 'local_user' });
    // The type system already rejects this call; the cast is the mistake a future caller could
    // make, and the runtime must still refuse it.
    expect(() =>
      confirmProposal(result as unknown as ProposableResult, {
        persona: PERSONA_A,
        confirmedAt: '2026-07-25T12:00:00Z',
      }),
    ).toThrow(NotProposableError);
  });

  it('refuses to confirm an expectation queued for review', () => {
    const queue = new PendingConfirmationQueue();
    const item = queue.enqueue({
      routed: routed({ owner: 'other_party', owner_label: 'Ivan', owed_to: 'local_user' }),
      envelopeId: 'e'.repeat(64),
      quote: 'Ivan said he would send it',
      confidence: 0.6,
      queuedAt: '2026-07-25T12:00:00Z',
    });
    expect(() =>
      queue.confirm(item.id, { persona: PERSONA_A, confirmedAt: '2026-07-25T12:00:00Z' }),
    ).toThrow(NotProposableError);
    expect(queue.stateOf(item.id)).toBe('pending');
  });

  it('routes the local user’s own promise as proposable only after confirmation, and only to a reachable persona', () => {
    const unresolved = routed({ owed_to: 'other_party', owed_to_label: 'Maria' });
    expect(unresolved.disposition).toBe(VAULT_LOCAL_COUNTERPARTY_UNRESOLVED);
    expect(isProposable(unresolved)).toBe(false);

    const resolved = routed(
      { owed_to: 'other_party', owed_to_label: 'Maria' },
      { ...ctx, resolveParty: (label) => (label === 'Maria' ? PERSONA_B : null) },
    );
    expect(resolved.disposition).toBe(PROPOSABLE_AFTER_CONFIRMATION);
    if (!isProposable(resolved)) throw new Error('unreachable');

    const proposal = confirmProposal(resolved, {
      persona: PERSONA_A,
      confirmedAt: '2026-07-25T12:00:00Z',
    });
    expect(proposal.kind).toBe('confirmed-proposal');
    expect(proposal.commitment.owner).toBe(PERSONA_A);
    expect(proposal.counterparty).toBe(PERSONA_B);
    expect(proposal.commitmentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('routes an undertaking to nobody in particular as reflexive', () => {
    expect(routed().disposition).toBe(REFLEXIVE);
    expect(routed({ owed_to: 'local_user' }).disposition).toBe(REFLEXIVE);
  });

  it('cannot be talked into a proposal by a model that attributes a promise to a third party', async () => {
    const env = envelope('Ivan said he would wire the payment today.', PERSONA_A);
    const model = createScriptedModelClient(
      JSON.stringify({
        results: [
          {
            envelope_id: env.id,
            intent: 'Ivan will wire the payment today',
            owner: 'other_party',
            owner_label: 'Ivan',
            owed_to: 'local_user',
            owed_to_label: null,
            due: null,
            confidence: 0.99,
            quote: 'Ivan said he would wire the payment today',
          },
        ],
      }),
    );

    const run = await new Extractor({ persona: PERSONA_A, model }).extract([env]);
    expect(run.items).toHaveLength(1);
    const only = run.items[0];
    if (only === undefined) throw new Error('unreachable');
    expect(only.routed.disposition).toBe(EXPECTATION_ONLY);
    expect(only.routed).not.toHaveProperty('commitment');
  });
});
