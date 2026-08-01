import { describe, expect, it } from 'vitest';
import { withSignature } from '@servanda/crypto';
import { PROTOCOL_VERSION, type Assertion } from '@servanda/types';
import { makeFixture, nodeAs, persona, syncEdge, type Fixture } from './support/fixture.js';

const EVIDENCE = 'b0dcb57992ddbbca584d976045d87aa31716c293c482f9fe93621f8e2176d6d8';

/**
 * §7 `act` refuses; it does not throw.
 *
 * `act` defers state legality to the §4.3 table, and the table's rejection vocabulary is nearly
 * twice the size of the one `act` may report. Where the two did not line up the reason went
 * through a `.parse()` and came back out as a ZodError — a crash from a tool whose entire contract
 * is to answer `{accepted: false, rejection_reason}`. `node-surface/act-tool.json` covers two of
 * those; the one below no vector reaches, because it needs a `disputed` edge and no §7 tool can
 * put an edge into `disputed`.
 */
describe('act: every table rejection comes back as a refusal', () => {
  function disputedEdge(fx: Fixture): string {
    const edgeId = fx.node.commit({
      intent: 'something worth disagreeing about',
      owed_to: fx.personas[1]!,
      due: null,
      persona: null,
      propose: true,
    }).edge_id!;
    syncEdge(fx, 0, 1, edgeId);
    nodeAs(fx, 1).confirm({ id: edgeId, decision: 'confirm' });
    syncEdge(fx, 1, 0, edgeId);

    // The counterparty disputes. This arrives over the wire (§6.2 `assert`); no §7 tool signs it,
    // which is why the state below is unreachable from the tool surface alone.
    const dispute = withSignature(
      {
        v: PROTOCOL_VERSION,
        type: 'assertion' as const,
        edge_id: edgeId,
        state: 'disputed' as const,
        asserted_at: fx.now.toISOString(),
        by: fx.personas[1]!,
        evidence_hash: EVIDENCE,
      },
      persona(1).privateKey,
    ) as Assertion;
    fx.vault.appendAssertion(fx.personas[0]!, dispute);
    expect(fx.node.edgeState(fx.personas[0]!, edgeId).final_state).toBe('disputed');
    return edgeId;
  }

  it('refuses the owner’s second half of a dispute closure instead of throwing', () => {
    const fx = makeFixture();
    const edgeId = disputedEdge(fx);

    // §4.3 `disputed → closed` needs both parties, so the owner's first `done` is accepted and
    // changes nothing visible — the edge is still disputed, waiting on the counterparty.
    const first = fx.node.act({ id: edgeId, act: 'done', evidence_hash: EVIDENCE });
    expect(first.accepted).toBe(true);
    expect(fx.node.edgeState(fx.personas[0]!, edgeId).final_state).toBe('disputed');

    // The same party signing again is not the second party. `duplicate-assertion-by-same-party`
    // has no name in the `act` vocabulary, and used to leave through the exception path.
    const chainBefore = JSON.stringify(fx.vault.getAssertions(fx.personas[0]!, edgeId));
    const second = fx.node.act({ id: edgeId, act: 'done', evidence_hash: EVIDENCE });
    expect(second).toEqual({
      accepted: false,
      rejection_reason: 'illegal-source-state',
      asserts: null,
    });
    expect(JSON.stringify(fx.vault.getAssertions(fx.personas[0]!, edgeId))).toBe(chainBefore);

    fx.cleanup();
  });

  it('refuses `done` with no evidence — the schema’s own default for the field', () => {
    const fx = makeFixture();
    const edgeId = fx.node.commit({
      intent: 'a promise to close without proof',
      owed_to: fx.personas[1]!,
      due: null,
      persona: null,
      propose: true,
    }).edge_id!;
    syncEdge(fx, 0, 1, edgeId);
    nodeAs(fx, 1).confirm({ id: edgeId, decision: 'confirm' });
    syncEdge(fx, 1, 0, edgeId);

    expect(fx.node.act({ id: edgeId, act: 'done', evidence_hash: null })).toEqual({
      accepted: false,
      rejection_reason: 'evidence-hash-required',
      asserts: null,
    });

    fx.cleanup();
  });
});
