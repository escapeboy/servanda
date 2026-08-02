import { describe, expect, it } from 'vitest';
import { edgeId, withSignature } from '@servanda/crypto';
import type { Assertion, Edge, EffectiveState } from '@servanda/types';
import { PROTOCOL_VERSION } from '@servanda/types';
import { EXPIRY_SKEW_MS, verifyAssertionChain } from '../src/transitions.js';
import { persona } from './support/fixture.js';

/**
 * §4.3: `open → expired`, either party after `due`.
 *
 * §4.3 held this transition up as the SOUND contrast to the self-asserted windows: *"`due` sits on
 * the edge object that both parties signed, cannot be moved unilaterally, and so the check on it
 * means something."* The check on `due` does mean something. **The claim about *now* did not.**
 *
 * Confirm an edge due in 2028; immediately sign `expired` dated 2028. The counterparty's node
 * records the edge as terminally expired two years early, and `expired` is terminal, so the owner
 * can never act on their own commitment again. One assertion is enough: the per-signer monotonic
 * rule has nothing earlier by that signer to compare against.
 *
 * The bound is on the receiving node's own clock, so no vector can carry it — §8's prose-obligation
 * category, entered knowingly. Reads stay clockless: what the clock decides is what a node will
 * STORE, and a stored chain must replay to the same state on every machine forever.
 */

const OWNER = persona(0);
const OWED_TO = persona(1);

const PROPOSED_AT = '2026-07-25T09:00:00Z';
const DUE = '2028-06-01T00:00:00Z';
const NOW = '2026-07-26T09:00:00Z';

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
  closure_policy: 'on-evidence',
  acceptance_window: null,
  blocked_by: [],
  supersedes: null,
};

function assert(
  state: EffectiveState,
  by: { personaId: string; privateKey: string },
  asserted_at: string,
): Assertion {
  return withSignature(
    {
      v: PROTOCOL_VERSION,
      type: 'assertion' as const,
      edge_id: EDGE.edge_id,
      state,
      asserted_at,
      by: by.personaId,
      evidence_hash: null,
    },
    by.privateKey,
  ) as Assertion;
}

const open = [assert('proposed', OWNER, PROPOSED_AT), assert('confirmed', OWED_TO, '2026-07-25T10:00:00Z')];
const at = (now: string, extra: Assertion) => verifyAssertionChain(EDGE, [...open, extra], now);

describe('§4.3 `expired` is bounded by the verifying node’s clock, not only by `due`', () => {
  it('the counterparty cannot expire a 2028 edge in 2026', () => {
    // The attack, entire. `asserted_at >= due` is satisfied — by a date two years away.
    const verified = at(NOW, assert('expired', OWED_TO, DUE));
    expect(verified.outcomes.at(-1)!.accepted).toBe(false);
    expect(verified.outcomes.at(-1)!.rejection_reason).toBe('expiry-dated-in-the-future');
    expect(verified.final_state).toBe('open');
  });

  it('nor can the owner', () => {
    const verified = at(NOW, assert('expired', OWNER, DUE));
    expect(verified.outcomes.at(-1)!.rejection_reason).toBe('expiry-dated-in-the-future');
  });

  it('but a genuine expiry after `due` is accepted', () => {
    // The control. A bound that refused honest expiries would be worse than the hole.
    const verified = at('2028-06-02T00:00:00Z', assert('expired', OWED_TO, '2028-06-01T12:00:00Z'));
    expect(verified.outcomes.at(-1)!.accepted).toBe(true);
    expect(verified.final_state).toBe('expired');
  });

  it('honest clock disagreement is tolerated, months are not', () => {
    // A node whose peer runs slightly ahead must not refuse it. The tolerance is a day, which no
    // pair of machines carrying UTC offsets disagrees by.
    const justInside = new Date(Date.parse(DUE) + EXPIRY_SKEW_MS - 60_000).toISOString();
    const justOutside = new Date(Date.parse(DUE) + EXPIRY_SKEW_MS + 60_000).toISOString();
    expect(at(DUE, assert('expired', OWED_TO, justInside)).outcomes.at(-1)!.accepted).toBe(true);
    expect(at(DUE, assert('expired', OWED_TO, justOutside)).outcomes.at(-1)!.accepted).toBe(false);
  });

  it('a clockless replay still accepts it — the vectors must not become machine-dependent', () => {
    // Generation and the conformance runner are clockless on purpose. A chain replayed against the
    // suite has to reach the same verdict on every machine forever, so the bound is applied by a
    // node that HAS a clock and by nothing else. This is the cost of the fix, stated rather than
    // discovered: the rule is a prose obligation no vector can carry.
    const clockless = verifyAssertionChain(EDGE, [...open, assert('expired', OWED_TO, DUE)]);
    expect(clockless.outcomes.at(-1)!.accepted).toBe(true);
    expect(clockless.final_state).toBe('expired');
  });

  it('and `expiry-before-due` still fires on its own side of the window', () => {
    const early = at('2026-07-26T09:00:00Z', assert('expired', OWED_TO, '2026-07-26T08:00:00Z'));
    expect(early.outcomes.at(-1)!.rejection_reason).toBe('expiry-before-due');
  });
});
