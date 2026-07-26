import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSignature } from '@servanda/crypto';
import { PROTOCOL_VERSION, ScopeDescriptor, type Assertion } from '@servanda/types';
import { runRetention, Vault } from '@servanda/vault';
import { NO_LOCAL_PLAINTEXT } from '../../src/node.js';
import { makeFixture, nodeAs, persona, syncEdge, type Fixture } from '../support/fixture.js';

/**
 * M-15 — Retention decay: after retention, plaintext SHOULD be deleted, edge+assertion chains
 * MUST be preserved. Personal-scope escrow MUST NOT exist; team-scope escrow MUST be
 * protocol-visible.
 *
 * Owned by this layer (vault retention pass + node state resolution).
 */

const SECRET = 'migrate the billing cluster before the Q3 audit';

let fx: Fixture;
let edgeId: string;
let commitmentHashHex: string;

beforeAll(() => {
  fx = makeFixture({ retentionDays: 30 });
  const out = fx.node.commit({
    intent: SECRET,
    owed_to: fx.personas[1]!,
    due: '2026-08-01T00:00:00Z',
    persona: null,
    propose: true,
  });
  edgeId = out.edge_id!;
  commitmentHashHex = out.commitment_hash;

  syncEdge(fx, 0, 1, edgeId);
  nodeAs(fx, 1).confirm({ id: edgeId, decision: 'confirm' });
  syncEdge(fx, 1, 0, edgeId);

  // owed_to releases the edge — a terminal state, so retention becomes applicable.
  const released = withSignature(
    {
      v: PROTOCOL_VERSION,
      type: 'assertion' as const,
      edge_id: edgeId,
      state: 'released' as const,
      asserted_at: '2026-07-26T00:00:00Z',
      by: fx.personas[1]!,
      evidence_hash: null,
    },
    persona(1).privateKey,
  ) as Assertion;
  fx.vault.appendAssertion(fx.personas[0]!, released);
});
afterAll(() => fx.cleanup());

const resolver = (p: string, id: string) => {
  const v = fx.node.edgeState(p, id);
  return { state: v.final_state, resolved_at: v.resolved_at };
};

describe('M-15: retention deletes the plaintext and preserves the proof', () => {
  it('does nothing while the item is inside the retention window', () => {
    const result = runRetention(fx.vault, fx.personas[0]!, resolver, {
      now: new Date('2026-08-01T00:00:00Z'), // 6 days after release, window is 30d
    });
    expect(result.deleted_plaintext).toEqual([]);
    expect(result.skipped_within_window).toContain(edgeId);
    expect(fx.vault.getCommitment(fx.personas[0]!, commitmentHashHex)?.intent).toBe(SECRET);
  });

  it('after the window, the plaintext is gone and the edge + chain remain', () => {
    const chainBefore = fx.vault.getAssertions(fx.personas[0]!, edgeId);
    const result = runRetention(fx.vault, fx.personas[0]!, resolver, {
      now: new Date('2026-10-01T00:00:00Z'), // well past 30 days
    });

    expect(result.deleted_plaintext).toContain(commitmentHashHex);
    expect(result.preserved_edges).toContain(edgeId);

    // "Remember that, not what."
    expect(fx.vault.getCommitment(fx.personas[0]!, commitmentHashHex)).toBeNull();
    expect(fx.vault.getEdge(fx.personas[0]!, edgeId)?.commitment_hash).toBe(commitmentHashHex);
    expect(fx.vault.getAssertions(fx.personas[0]!, edgeId)).toEqual(chainBefore);
    expect(fx.vault.getEdgeMeta(fx.personas[0]!, edgeId).plaintext_deleted_at).not.toBeNull();
  });

  it('the record still proves the promise existed and how it ended', () => {
    const verification = fx.node.edgeState(fx.personas[0]!, edgeId);
    expect(verification.final_state).toBe('released');
    expect(verification.outcomes.every((o) => o.accepted)).toBe(true);

    const item = fx.node
      .openLoops({ view: 'closed', persona: null, limit: 50 })
      .items.find((i) => i.id === edgeId);
    expect(item?.state).toBe('released');
    expect(item?.intent_or_expect).toBe(NO_LOCAL_PLAINTEXT);
  });

  it('an open edge’s plaintext is never a retention candidate, however old', () => {
    const openEdge = fx.node.commit({
      intent: 'still open',
      owed_to: fx.personas[1]!,
      due: null,
      persona: null,
      propose: true,
    }).edge_id!;
    syncEdge(fx, 0, 1, openEdge);
    nodeAs(fx, 1).confirm({ id: openEdge, decision: 'confirm' });
    syncEdge(fx, 1, 0, openEdge);

    const hash = fx.vault.getEdge(fx.personas[0]!, openEdge)!.commitment_hash;
    const result = runRetention(fx.vault, fx.personas[0]!, resolver, {
      now: new Date('2126-10-01T00:00:00Z'), // a century on
    });
    expect(result.deleted_plaintext).not.toContain(hash);
    expect(fx.vault.getCommitment(fx.personas[0]!, hash)).not.toBeNull();
  });

  it('personal-scope escrow does not exist — there is no option to enable', () => {
    // §5.4: "Personal scopes MUST NOT support escrow." The vault has no escrow field, no
    // escrow API and no way to name an escrow holder for a personal scope.
    const surface = Object.getOwnPropertyNames(Vault.prototype).concat(
      Object.keys(fx.vault.retentionPolicy()),
    );
    expect(surface.filter((n) => /escrow/i.test(n))).toEqual([]);
    expect(JSON.stringify(fx.vault.retentionPolicy())).not.toMatch(/escrow/i);
  });

  it('team-scope escrow, where it exists at all, is protocol-visible', () => {
    // §5.4: escrow for a team scope MUST be announced in the scope descriptor — a signed,
    // member-visible object, not a silent capability. The type makes it unstateable otherwise.
    const descriptor = ScopeDescriptor.parse({
      v: PROTOCOL_VERSION,
      type: 'scope_descriptor',
      scope: { kind: 'team', key: persona(100).personaId },
      retention_days: 90,
      escrow: { enabled: true, holder: persona(2).personaId },
    });
    expect(descriptor.escrow.enabled).toBe(true);
    expect(descriptor.escrow.holder).toBeDefined();
    expect(descriptor.retention_days).toBe(90);
  });
});
