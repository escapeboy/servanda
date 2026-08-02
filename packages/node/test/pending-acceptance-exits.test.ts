import { describe, expect, it } from 'vitest';
import { edgeId, withSignature } from '@servanda/crypto';
import type { Assertion, Edge, EffectiveState } from '@servanda/types';
import { PROTOCOL_VERSION } from '@servanda/types';
import { verifyAssertionChain } from '../src/transitions.js';
import { persona } from './support/fixture.js';

/**
 * §4.3 gives `pending-acceptance` exactly three rows: `closed` by owed_to alone, `closed` by the
 * owner once the window has elapsed, and `disputed` by either party. It gives it no others.
 *
 * The implementation folded `pending-acceptance` into a constant it shared with `open` and then
 * used that constant as the source-state guard for `released`, `expired` AND `superseded`, so
 * three rows appeared that the table does not have. §4.3's "wherever `open` appears as a source
 * state, an edge whose latest valid assertion is `confirmed` satisfies it" licenses one
 * equivalence — `confirmed` ≡ `open` — and it is not this one.
 *
 * The damaging row is `expired`. It is terminal, either party may sign it once `due` has passed,
 * and it does not need the counterparty. So on any edge with a `due` in the past, the creditor
 * could answer the debtor's evidence assertion by ending the edge outright — permanently, with
 * no closure recorded — which inverts §4.4: the acceptance window exists so that the creditor's
 * SILENCE becomes consent, and this made the creditor's veto cheaper than a dispute. A dispute
 * at least carries an `evidence_hash` and leaves both resolutions open.
 */

const OWNER = persona(0);
const OWED_TO = persona(1);

const PROPOSED_AT = '2026-07-25T09:00:00Z';
const DUE = '2026-07-26T09:00:00Z';

const body = {
  commitment_hash: 'a'.repeat(64),
  owner: OWNER.personaId,
  owed_to: OWED_TO.personaId,
  proposed_at: PROPOSED_AT,
};

const EDGE: Edge = {
  v: PROTOCOL_VERSION,
  type: 'edge',
  edge_id: edgeId(body),
  ...body,
  due: DUE,
  closure_policy: 'on-acceptance',
  acceptance_window: 'P5D',
  blocked_by: [],
  supersedes: null,
};

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
      edge_id: EDGE.edge_id,
      state,
      asserted_at,
      by: by.personaId,
      evidence_hash,
    },
    by.privateKey,
  ) as Assertion;
}

/** proposed → confirmed → owner files evidence, which opens the §4.4 acceptance window. */
const INTO_PENDING = [
  assert('proposed', OWNER, PROPOSED_AT),
  assert('confirmed', OWED_TO, '2026-07-25T09:00:01Z'),
  assert('closed', OWNER, '2026-07-27T09:00:00Z', 'e'.repeat(64)),
];

function outcomeOf(extra: Assertion) {
  const chain = [...INTO_PENDING, extra];
  const verified = verifyAssertionChain(EDGE, chain);
  return { last: verified.outcomes[chain.length - 1]!, final: verified.final_state };
}

describe('§4.3: pending-acceptance has three exits and no others', () => {
  it('the window is genuinely open before any of this', () => {
    const verified = verifyAssertionChain(EDGE, INTO_PENDING);
    expect(verified.outcomes.every((o) => o.accepted)).toBe(true);
    expect(verified.final_state).toBe('pending-acceptance');
  });

  it('the creditor cannot expire the edge out from under the evidence assertion', () => {
    // `due` elapsed two days before the owner filed. Under the `open` row this is a legal
    // unilateral act by either party; from `pending-acceptance` §4.3 offers no such row.
    const { last, final } = outcomeOf(assert('expired', OWED_TO, '2026-07-28T09:00:00Z'));
    expect(last.accepted).toBe(false);
    expect(last.rejection_reason).toBe('illegal-source-state');
    expect(final).toBe('pending-acceptance');
  });

  it('nor can the owner', () => {
    const { last } = outcomeOf(assert('expired', OWNER, '2026-07-28T09:00:00Z'));
    expect(last.accepted).toBe(false);
    expect(last.rejection_reason).toBe('illegal-source-state');
  });

  it('release is an `open` row: forgiveness after evidence is not a transition the table has', () => {
    const { last } = outcomeOf(assert('released', OWED_TO, '2026-07-28T09:00:00Z'));
    expect(last.accepted).toBe(false);
    expect(last.rejection_reason).toBe('illegal-source-state');
  });

  it('so is supersession', () => {
    const { last } = outcomeOf(assert('superseded', OWNER, '2026-07-28T09:00:00Z'));
    expect(last.accepted).toBe(false);
    expect(last.rejection_reason).toBe('illegal-source-state');
  });

  it('dispute is a `pending-acceptance` row and still works', () => {
    const { last, final } = outcomeOf(
      assert('disputed', OWED_TO, '2026-07-28T09:00:00Z', 'd'.repeat(64)),
    );
    expect(last.accepted).toBe(true);
    expect(final).toBe('disputed');
  });

  it('explicit acceptance still works', () => {
    const { last, final } = outcomeOf(assert('closed', OWED_TO, '2026-07-28T09:00:00Z'));
    expect(last.accepted).toBe(true);
    expect(final).toBe('closed');
  });

  it('and tacit acceptance survives — the window still ends in a close, not a stalemate', () => {
    const { last, final } = outcomeOf(
      assert('closed', OWNER, '2026-08-05T09:00:00Z', 'e'.repeat(64)),
    );
    expect(last.accepted).toBe(true);
    expect(final).toBe('closed');
  });

  it('every one of the three still exits from `open` itself', () => {
    const open = [INTO_PENDING[0]!, INTO_PENDING[1]!];
    for (const [state, by, evidence] of [
      ['expired', OWED_TO, null],
      ['released', OWED_TO, null],
      ['superseded', OWNER, null],
    ] as const) {
      const chain = [...open, assert(state, by, '2026-07-28T09:00:00Z', evidence)];
      const verified = verifyAssertionChain(EDGE, chain);
      expect(verified.outcomes[2]!.accepted, `${state} from open`).toBe(true);
    }
  });
});
