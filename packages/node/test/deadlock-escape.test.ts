import { afterAll, describe, expect, it } from 'vitest';
import { edgeId, withSignature } from '@servanda/crypto';
import { PROTOCOL_VERSION, type Assertion, type Edge } from '@servanda/types';
import { verifyAssertionChain } from '../src/transitions.js';
import { makeFixture, nodeAs, persona, type Fixture } from './support/fixture.js';

/**
 * §4.4's third exit, from the seat of somebody stuck in it.
 *
 * §4.4 argues that this exit is **not optional**, at length and in its own words: *"a state two
 * people can enter by accident and cannot leave alone is a worse trap than the divergence it
 * replaces"*, and an implementation that gives `disputed` the escape and withholds it from
 * `contested-closure` *"has built the stronger weapon and handed it out for free"*.
 *
 * The transition table had it. **Nothing a person could press did.** `act`'s input was
 * `done|release`, `expired` had no member in §7's act vocabulary, and §7 described the absence as
 * a fact about the world — "which is time and not an act". It is not time: it is a
 * single-signature assertion by a named party, gated on a window, the same shape as `release`,
 * which §7 has always bound to a tool.
 *
 * So the escape existed everywhere except where a person stands. That is the same defect §1.7
 * rotation had — correct in the table, unreachable on the wire — and it was found the same way,
 * by an independent implementer asking what a trapped party is supposed to press.
 */

const ME = persona(0);
const THEM = persona(1);
const EVIDENCE = 'e'.repeat(64);

const fx: Fixture = makeFixture({ now: new Date('2026-08-03T09:00:00.000Z') });
afterAll(() => fx.cleanup());

/**
 * ONE vault, several edges — not a vault per case.
 *
 * The first version stood up four fixtures, each an Argon2id derivation plus a git repository,
 * and the node suite began exiting non-zero on the vitest worker RPC while every test passed.
 * `vitest.config.ts` documents that failure at length and names it the worst kind: "a suite that
 * invents a red result is worse than a slow one, because the only defence against it is to stop
 * believing red."
 *
 * Nothing here needed a second vault. Each case needs a chain it can END, which is an edge, and
 * an edge is a hash of its own body — so a distinct `commitment_hash` is a distinct edge in the
 * same vault, at no cost at all.
 */
const edgeWith = (commitment: string): Edge => {
  const body = {
    commitment_hash: commitment,
    owner: ME.personaId,
    owed_to: THEM.personaId,
    proposed_at: '2026-06-01T09:00:00Z',
  };
  return {
    v: PROTOCOL_VERSION,
    type: 'edge',
    edge_id: edgeId(body),
    ...body,
    due: null,
    closure_policy: 'on-evidence',
    acceptance_window: null,
    blocked_by: [],
    supersedes: null,
  };
};

const EDGE = edgeWith('a'.repeat(64));

const assertionOn = (
  edge: Edge,
  state: 'proposed' | 'confirmed' | 'closed' | 'released',
  by: typeof ME,
  at: string,
  evidence: string | null = null,
): Assertion =>
  withSignature(
    {
      v: PROTOCOL_VERSION,
      type: 'assertion' as const,
      edge_id: edge.edge_id,
      state,
      asserted_at: at,
      by: by.personaId,
      evidence_hash: evidence,
    },
    by.privateKey,
  ) as Assertion;

const assertion = (
  state: 'proposed' | 'confirmed' | 'closed' | 'released',
  by: typeof ME,
  at: string,
  evidence: string | null = null,
): Assertion => assertionOn(EDGE, state, by, at, evidence);

/** A fresh contested edge in the SAME vault, ready to be ended. */
const contestedEdge = (commitment: string): Edge => {
  const edge = edgeWith(commitment);
  fx.vault.putEdge(ME.personaId, edge);
  fx.vault.appendAssertion(ME.personaId, assertionOn(edge, 'proposed', ME, '2026-06-01T09:00:00Z'));
  fx.vault.appendAssertion(ME.personaId, assertionOn(edge, 'confirmed', THEM, '2026-06-02T09:00:00Z'));
  fx.vault.appendAssertion(ME.personaId, assertionOn(edge, 'closed', ME, CONTEST_AT, EVIDENCE));
  fx.vault.appendAssertion(ME.personaId, assertionOn(edge, 'released', THEM, CONTEST_AT));
  return edge;
};

// The §6.4 contest: both parties exit `open` alone at the same instant, neither having seen the
// other. Both acts are legal and both stand.
const CONTEST_AT = '2026-06-15T09:00:00Z';
fx.vault.putEdge(ME.personaId, EDGE);
fx.vault.appendAssertion(ME.personaId, assertion('proposed', ME, '2026-06-01T09:00:00Z'));
fx.vault.appendAssertion(ME.personaId, assertion('confirmed', THEM, '2026-06-02T09:00:00Z'));
fx.vault.appendAssertion(ME.personaId, assertion('closed', ME, CONTEST_AT, EVIDENCE));
fx.vault.appendAssertion(ME.personaId, assertion('released', THEM, CONTEST_AT));

const item = () =>
  fx.node.openLoops({ persona: null, view: 'all', limit: 50 }).items.find((i) => i.id === EDGE.edge_id);

describe('a deadlock two people entered by accident can be left by either of them', () => {
  it('starts contested, and offers no escape while the window is running', () => {
    // Two weeks in, on a thirty-day window. Offering `expire` here would advertise an act the
    // table refuses — the failure M-20 exists to prevent, arrived at by being too generous.
    fx.setNow(new Date('2026-06-29T09:00:00Z'));
    expect(fx.node.edgeState(ME.personaId, EDGE.edge_id).final_state).toBe('contested-closure');
    expect(item()!.actions.map((a) => a.act)).toEqual(['supersede']);
    // `dispute-window-not-elapsed`, and NOT `illegal-source-state`. This is the one state from
    // which `expire` is legal; the only thing wrong is the clock, and "you may never do this" is
    // a different answer from "not yet". §7 gave the acceptance window its own reason on exactly
    // this argument and gave this one nothing for a revision.
    expect(fx.node.act({ id: EDGE.edge_id, act: 'expire', evidence_hash: null })).toMatchObject({
      accepted: false,
      rejection_reason: 'dispute-window-not-elapsed',
    });
  });

  it('offers it once the window has run, to the party who is looking', () => {
    fx.setNow(new Date('2026-07-20T09:00:00Z'));
    const actions = item()!.actions;
    // §7's normative order is most-consequential-first, and `expire` wins both of its clauses:
    // it ENDS the promise and it SIGNS, where `supersede` does neither. Emitted the other way
    // round when it was added — a new act appended rather than placed by the rule, which is the
    // failure that paragraph exists to prevent.
    expect(actions.map((a) => a.act)).toEqual(['expire', 'supersede']);
    // Bound to a tool that signs, with the arguments already determined. An advertised act whose
    // tool is null would be the same trap wearing a button.
    expect(actions.find((a) => a.act === 'expire')).toEqual({
      act: 'expire',
      tool: 'act',
      args: { id: EDGE.edge_id, act: 'expire' },
    });
  });

  it('and pressing it ends the edge', () => {
    fx.setNow(new Date('2026-07-20T09:00:00Z'));
    expect(fx.node.act({ id: EDGE.edge_id, act: 'expire', evidence_hash: null })).toEqual({
      accepted: true,
      rejection_reason: null,
      asserts: 'expired',
    });
    expect(fx.node.edgeState(ME.personaId, EDGE.edge_id).final_state).toBe('expired');
    // Terminal now, so nothing is advertised — and the item has left the live views.
    expect(item()!.actions).toEqual([]);
    expect(
      fx.node.openLoops({ persona: null, view: 'owe', limit: 50 }).items.map((i) => i.id),
    ).not.toContain(EDGE.edge_id);
  });

  it('and EITHER party may do it — that is the whole of §4.4’s argument', () => {
    // The half that makes the rule mean anything. `done` is the owner's and `release` is the
    // party-owed's, so a role-gated `expire` would have left one of the two people still
    // trapped — and which one depends on who happened to contest first, which is exactly the
    // "stronger weapon handed out for free" §4.4 warns about.
    fx.setNow(new Date('2026-07-20T09:00:00Z'));
    const edge = contestedEdge('b'.repeat(64));
    // Signed by the party who is OWED, not by the owner.
    expect(nodeAs(fx, 1).act({ id: edge.edge_id, act: 'expire', evidence_hash: null })).toMatchObject({
      accepted: true,
      asserts: 'expired',
    });
  });

  it('and standing is the chain’s to judge, not this test’s', () => {
    // Written first as "a third persona is refused `not-a-party`", and it was the TEST that was
    // wrong. `act` resolves the persona from where the record lives, not from who is calling,
    // and every persona in one vault is one human's contexts (§1.2) — so a "stranger persona"
    // inside my own vault is not a stranger, and there is no non-party to be in this seat.
    //
    // M-3's guarantee against a key that is genuinely not a party lives in the chain, where
    // `signer-not-a-party` is decided, and is tested there. Recording the correction rather than
    // forcing an assertion about a model this code does not have.
    fx.setNow(new Date('2026-07-20T09:00:00Z'));
    const edge = contestedEdge('c'.repeat(64));

    // A key that is party to nothing here cannot expire this edge, whatever it signs.
    const outsider = persona(9);
    const forged = withSignature(
      {
        v: PROTOCOL_VERSION,
        type: 'assertion' as const,
        edge_id: edge.edge_id,
        state: 'expired' as const,
        asserted_at: '2026-07-20T09:00:00Z',
        by: outsider.personaId,
        evidence_hash: null,
      },
      outsider.privateKey,
    ) as Assertion;
    const chain = [...fx.vault.getAssertions(ME.personaId, edge.edge_id), forged];
    const verified = verifyAssertionChain(edge, chain, '2026-07-20T09:00:00Z');
    expect(verified.outcomes.at(-1)!.rejection_reason).toBe('signer-not-a-party');
    expect(verified.final_state).toBe('contested-closure');
  });

  it('refuses evidence, because expiry decides nothing about the merits', () => {
    // §4.4 is explicit that both acts stay in the chain and the outcome names a window, never a
    // verdict. An `evidence_hash` here would record a judgement the protocol refuses to make.
    fx.setNow(new Date('2026-07-20T09:00:00Z'));
    const edge = contestedEdge('d'.repeat(64));
    expect(fx.node.act({ id: edge.edge_id, act: 'expire', evidence_hash: EVIDENCE })).toMatchObject({
      accepted: false,
      rejection_reason: 'evidence-hash-must-be-null',
    });
  });
});
