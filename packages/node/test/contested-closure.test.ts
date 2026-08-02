import { describe, expect, it } from 'vitest';
import { edgeId, withSignature } from '@servanda/crypto';
import type { Assertion, Edge, EffectiveState } from '@servanda/types';
import { PROTOCOL_VERSION } from '@servanda/types';
import { verifyAssertionChain } from '../src/transitions.js';
import { persona } from './support/fixture.js';

/**
 * §4.3 / §6.4 — `contested-closure`.
 *
 * `open` offers three exits to one party acting alone: `closed` by the owner with evidence,
 * `released` by `owed_to`, `expired` by either once `due` has passed. They are mutually exclusive
 * and **nothing stops two parties taking different ones at the same time.**
 *
 * Found by two HONEST nodes: partition them, let the owner close with evidence while the
 * counterparty releases, and each accepted its own act and refused the other's forever. §6.4's
 * whole guarantee — "both sides see the same chain" — assumes one valid chain exists, and here
 * both were valid. Reconciliation never terminated: each side kept offering a chain the other
 * kept discarding, every round.
 *
 * The property that matters most in this file is **order-independence**. If the two nodes computed
 * different states from the same two assertions, naming the state would have fixed nothing.
 */

const OWNER = persona(0);
const OWED_TO = persona(1);

const PROPOSED_AT = '2026-07-25T09:00:00Z';
const DUE = '2026-07-26T09:00:00Z';
const EVIDENCE = 'e'.repeat(64);

const body = {
  commitment_hash: 'a'.repeat(64),
  owner: OWNER.personaId,
  owed_to: OWED_TO.personaId,
  proposed_at: PROPOSED_AT,
};

function edgeWith(policy: 'on-evidence' | 'on-acceptance'): Edge {
  return {
    v: PROTOCOL_VERSION,
    type: 'edge',
    edge_id: edgeId(body),
    ...body,
    due: DUE,
    closure_policy: policy,
    acceptance_window: policy === 'on-acceptance' ? 'P5D' : null,
    blocked_by: [],
    supersedes: null,
  };
}

function assert(
  state: EffectiveState,
  by: { personaId: string; privateKey: string },
  asserted_at: string,
  evidence_hash: string | null = null,
): Assertion {
  return withSignature(
    {
      v: PROTOCOL_VERSION,
      type: 'assertion' as const,
      edge_id: edgeId(body),
      state,
      asserted_at,
      by: by.personaId,
      evidence_hash,
    },
    by.privateKey,
  ) as Assertion;
}

const proposed = assert('proposed', OWNER, PROPOSED_AT);
const confirmed = assert('confirmed', OWED_TO, '2026-07-25T09:00:01Z');
/** The two concurrent acts. Neither party had seen the other's when it signed. */
const ownerCloses = assert('closed', OWNER, '2026-07-27T09:00:00Z', EVIDENCE);
const creditorReleases = assert('released', OWED_TO, '2026-07-27T09:00:00Z');

const state = (edge: Edge, chain: Assertion[]) => verifyAssertionChain(edge, chain);

describe('§4.3 two legal unilateral exits, taken concurrently', () => {
  for (const policy of ['on-evidence', 'on-acceptance'] as const) {
    describe(`on an ${policy} edge`, () => {
      const edge = edgeWith(policy);
      const base = [proposed, confirmed];

      it('both nodes reach the same state, whichever assertion arrived first', () => {
        // THE property. Two honest nodes see the two assertions in whichever order their
        // transports delivered them; if that changed the answer, naming the state would fix
        // nothing and §6.4 would still never converge.
        const a = state(edge, [...base, ownerCloses, creditorReleases]);
        const b = state(edge, [...base, creditorReleases, ownerCloses]);

        expect(a.final_state).toBe('contested-closure');
        expect(b.final_state).toBe(a.final_state);
      });

      it('neither signed act is discarded', () => {
        // A tie-break would have thrown one away. Both parties acted legally and both acts stand.
        for (const chain of [
          [...base, ownerCloses, creditorReleases],
          [...base, creditorReleases, ownerCloses],
        ]) {
          const verified = state(edge, chain);
          expect(verified.outcomes.every((o) => o.accepted), JSON.stringify(chain.map((c) => c.state))).toBe(true);
        }
      });

      it('leaves the same way `disputed` does: both parties, or not at all', () => {
        const contested = [...base, ownerCloses, creditorReleases];
        const oneParty = state(edge, [...contested, assert('closed', OWNER, '2026-08-01T09:00:00Z', EVIDENCE)]);
        expect(oneParty.final_state).toBe('contested-closure');

        const bothParties = state(edge, [
          ...contested,
          assert('closed', OWNER, '2026-08-01T09:00:00Z', EVIDENCE),
          assert('closed', OWED_TO, '2026-08-01T10:00:00Z'),
        ]);
        expect(bothParties.final_state).toBe('closed');
      });

      it('or by mutual supersession', () => {
        const contested = [...base, ownerCloses, creditorReleases];
        const superseded = state(edge, [
          ...contested,
          assert('superseded', OWNER, '2026-08-01T09:00:00Z'),
          assert('superseded', OWED_TO, '2026-08-01T10:00:00Z'),
        ]);
        expect(superseded.final_state).toBe('superseded');
      });

      it('one party asserting twice is not two parties', () => {
        const contested = [...base, ownerCloses, creditorReleases];
        const twice = state(edge, [
          ...contested,
          assert('closed', OWNER, '2026-08-01T09:00:00Z', EVIDENCE),
          assert('closed', OWNER, '2026-08-01T10:00:00Z', EVIDENCE),
        ]);
        expect(twice.outcomes.at(-1)!.rejection_reason).toBe('duplicate-assertion-by-same-party');
        expect(twice.final_state).toBe('contested-closure');
      });
    });
  }

  it('has the third exit §4.4 gives `disputed`, and for the same reason', () => {
    // Both resolutions above need BOTH parties, so without this a contest is a unilateral act
    // that freezes an edge for ever — the trap §4.4 already names and already refused to build.
    // It was worse here: reaching a contest costs no `evidence_hash`, where `disputed` does.
    const edge = edgeWith('on-evidence');
    const contested = [...[proposed, confirmed], ownerCloses, creditorReleases];

    const tooSoon = state(edge, [...contested, assert('expired', OWNER, '2026-08-01T09:00:00Z')]);
    expect(tooSoon.outcomes.at(-1)!.rejection_reason).toBe('dispute-window-not-elapsed');
    expect(tooSoon.final_state).toBe('contested-closure');

    // P30D from the contest, by EITHER party, and it decides nothing about the merits.
    const freed = state(edge, [...contested, assert('expired', OWNER, '2026-08-27T09:00:00Z')]);
    expect(freed.final_state).toBe('expired');
    expect(state(edge, [...contested, assert('expired', OWED_TO, '2026-08-27T09:00:00Z')]).final_state).toBe(
      'expired',
    );
  });

  it('and both acts are still in the chain after it — expiry appends, it never erases', () => {
    const edge = edgeWith('on-evidence');
    const chain = [
      ...[proposed, confirmed],
      ownerCloses,
      creditorReleases,
      assert('expired', OWNER, '2026-08-27T09:00:00Z'),
    ];
    expect(state(edge, chain).outcomes.every((o) => o.accepted)).toBe(true);
  });

  it('an ILLEGAL second exit is refused for its own fault, not swallowed as a contest', () => {
    // The rule turns on the second act having been LEGAL when it was made. Here the creditor
    // asserts `expired` before `due` — different party, different destination, so it reaches the
    // contest guard — and it is refused for the reason it deserves. An illegal act is not half of
    // a disagreement, and reporting `contested-closure` here would launder one into a state that
    // needs both parties to leave.
    const edge = edgeWith('on-evidence');
    const verified = state(edge, [
      proposed,
      confirmed,
      ownerCloses,
      assert('expired', OWED_TO, '2026-07-25T12:00:00Z'),
    ]);
    expect(verified.outcomes.at(-1)!.accepted).toBe(false);
    expect(verified.outcomes.at(-1)!.rejection_reason).toBe('expiry-before-due');
    expect(verified.final_state).toBe('closed');
  });

  it('the same party asserting again after terminal is still `terminal-state-reached`', () => {
    // The contest rule must not have widened the terminal guard. One party cannot contest itself,
    // and §4.3's ordering — terminality checked before the table, so the reason names the real
    // problem — is deliberate and unchanged.
    const edge = edgeWith('on-evidence');
    const verified = state(edge, [
      proposed,
      confirmed,
      ownerCloses,
      assert('released', OWNER, '2026-07-28T09:00:00Z'),
    ]);
    expect(verified.outcomes.at(-1)!.rejection_reason).toBe('terminal-state-reached');
    expect(verified.final_state).toBe('closed');
  });

  it('the SAME exit asserted by the other party does not contest', () => {
    // `closed` by owed_to out of `pending-acceptance` is the explicit acceptance of §4.4, not a
    // disagreement. Different signer, same destination — the ordinary happy path.
    const edge = edgeWith('on-acceptance');
    const verified = state(edge, [
      proposed,
      confirmed,
      ownerCloses,
      assert('closed', OWED_TO, '2026-07-28T09:00:00Z'),
    ]);
    expect(verified.final_state).toBe('closed');
  });

  it('the owner re-closing after the window is tacit acceptance, not a contest', () => {
    const edge = edgeWith('on-acceptance');
    const verified = state(edge, [
      proposed,
      confirmed,
      ownerCloses,
      assert('closed', OWNER, '2026-08-05T09:00:00Z', EVIDENCE),
    ]);
    expect(verified.final_state).toBe('closed');
  });

  it('a dispute after the evidence assertion is still a dispute', () => {
    // `disputed` is not a unilateral EXIT — it is a §4.4 row `pending-acceptance` genuinely has,
    // and it must not be swallowed by the contest rule.
    const edge = edgeWith('on-acceptance');
    const verified = state(edge, [
      proposed,
      confirmed,
      ownerCloses,
      assert('disputed', OWED_TO, '2026-07-28T09:00:00Z', 'd'.repeat(64)),
    ]);
    expect(verified.final_state).toBe('disputed');
  });
});
