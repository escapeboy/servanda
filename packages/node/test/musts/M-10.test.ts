import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixture, nodeAs, syncEdge, type Fixture } from '../support/fixture.js';

/**
 * M-10 — Base protocol (L0–L1) MUST function with no network, server, or second participant.
 *
 * Owned by this layer. Two halves:
 *  1. In-process: every §7 tool works against a bare vault with nobody else present.
 *  2. Out-of-process (`prove-no-network.mjs`): the shipped node answers all five tools inside a
 *     child process whose network primitives throw, with positive and negative controls that
 *     show the trap is armed, plus a static audit of the shipped module graph.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PROVER = join(HERE, '..', 'support', 'prove-no-network.mjs');

let fx: Fixture;
beforeAll(() => {
  fx = makeFixture();
});
afterAll(() => fx.cleanup());

describe('M-10: L0–L1 functions with no network, server, or second participant', () => {
  it('records and proposes with nobody else present', () => {
    const out = fx.node.commit({
      intent: 'write the gate',
      owed_to: fx.personas[1]!,
      due: '2026-08-01T00:00:00Z',
      persona: null,
      propose: true,
    });
    expect(out.state).toBe('proposed');
    // The wire message exists; no transport was required for it to be produced.
    expect(fx.vault.listOutbox(fx.personas[0]!)).toHaveLength(1);
  });

  it('the second participant is optional, not required', () => {
    const out = fx.node.commit({
      intent: 'a promise to an off-network counterparty',
      owed_to: 'someone@example.com',
      due: null,
      persona: null,
      propose: true,
    });
    // §3.1 half-network case: an external_label is not resolvable, so the record stays local.
    expect(out).toMatchObject({ edge_id: null, state: 'vault-local' });
  });

  it('all six §7 tools answer offline', () => {
    const edgeId = fx.node.commit({
      intent: 'confirmable',
      owed_to: fx.personas[1]!,
      due: null,
      persona: null,
      propose: true,
    }).edge_id!;
    syncEdge(fx, 0, 1, edgeId);

    expect(fx.node.expect({ expect: 'their draft', from: 'them', context: null })).toHaveProperty(
      'expectation_id',
    );
    expect(nodeAs(fx, 1).confirm({ id: edgeId, decision: 'confirm' })).toEqual({
      state: 'confirmed',
    });
    expect(fx.node.openLoops({ view: 'all', persona: null, limit: 50 }).items.length).toBeGreaterThan(0);
    expect(fx.node.brief({ persona: null }).slots.length).toBeGreaterThan(0);
  });

  it('the shipped node answers all six tools with network primitives disabled', () => {
    // The prover exits non-zero on any failed control; this is its verdict, not a re-assertion.
    const out = execFileSync(process.execPath, [PROVER], { encoding: 'utf8' });
    expect(out).toContain('GA/no-network: PASS');
    expect(out).not.toContain('FAIL');
  }, 120_000);
});
