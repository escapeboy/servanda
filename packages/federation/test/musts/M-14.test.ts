import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { effectiveState } from '@servanda/node';
import type { Assertion, Edge } from '@servanda/types';
import { signMessage } from '../../src/messages.js';
import { forgetEdge, makeSolo, persona, type Solo } from '../support/fixture.js';

/**
 * M-14 — "Assertions violating the transition table are invalid and MUST be discarded."
 *
 * L1 proves this for chains handed to the verifier directly. §6 is where it actually matters:
 * the wire is the one input a node does not control, and a federation layer that "helpfully"
 * stored what a peer sent would defeat the table without failing a single L1 test.
 *
 * The oracle is reused verbatim — the 21 negative vectors in
 * `vendor/vectors/transitions/invalid.json` are delivered AS WIRE MESSAGES, over both inbound
 * paths this layer offers (a §6.4 `recon_response` and a §6.2 `assert`), and the vectors'
 * expected rejection reasons and final states must come out unchanged.
 */

interface VectorCase {
  name: string;
  edge: Edge;
  assertions: Assertion[];
  expected_outcomes: { index: number; accepted: boolean; rejection_reason?: string }[];
  expected_final_state: string;
}

const VECTORS = `${process.env['SERVANDA_VECTORS'] ?? 'vendor/vectors'}/transitions/invalid.json`;
const cases: VectorCase[] = JSON.parse(readFileSync(VECTORS, 'utf8')).cases;

/** The vectors' `owner` / `owed_to` are personas 0 and 1 of the published test mnemonic. */
const OWNER = persona(0);
const COUNTERPARTY = persona(1);

beforeAll(() => {
  expect(cases).toHaveLength(21);
  for (const c of cases) {
    expect(c.edge.owner).toBe(OWNER.personaId);
    expect(c.edge.owed_to).toBe(COUNTERPARTY.personaId);
  }
  // All 21 cases reuse one edge_id: §4.1's preimage is
  // sha256(commitment_hash || owner || owed_to || proposed_at), so variants differing only in
  // `due` or `closure_policy` collide by design. Each case therefore has to start from an empty
  // chain (`forgetEdge`) — sharing one would let an earlier case decide a later case's outcome.
  expect(new Set(cases.map((c) => c.edge.edge_id)).size).toBe(1);
});

const expectedRejections = (c: VectorCase) =>
  c.expected_outcomes.filter((o) => !o.accepted).map((o) => ({ index: o.index, reason: o.rejection_reason }));

const stateOf = (solo: Solo, edge: Edge) =>
  effectiveState(edge, solo.vault.getAssertions(solo.personaId, edge.edge_id));

function perCase(fn: (solo: Solo, c: VectorCase) => void): void {
  const solo = makeSolo(0);
  try {
    for (const c of cases) {
      forgetEdge(solo, c.edge.edge_id);
      solo.vault.putEdge(solo.personaId, c.edge);
      fn(solo, c);
    }
  } finally {
    solo.cleanup();
  }
}

describe('M-14: invalid assertions arriving over the wire are discarded', () => {
  it('every negative vector delivered as a §6.4 recon_response is rejected identically', () => {
    perCase((solo, c) => {
      const message = signMessage(
        'recon_response',
        { edges: [{ edge_id: c.edge.edge_id, assertions: c.assertions }] },
        COUNTERPARTY.personaId,
        '2026-07-25T12:00:00Z',
        COUNTERPARTY.privateKey,
      );

      const result = solo.inbox.ingest([message]);

      expect(
        result.recon.discarded.map((d) => ({ index: d.index, reason: d.reason })),
        `${c.name}: rejection reasons`,
      ).toEqual(expectedRejections(c));
      expect(result.recon.accepted, `${c.name}: accepted count`).toHaveLength(
        c.expected_outcomes.filter((o) => o.accepted).length,
      );
      expect(stateOf(solo, c.edge), `${c.name}: final state`).toBe(c.expected_final_state);

      // The discarded assertions were never written: the chain holds exactly what the table
      // accepted, in order.
      const accepted = c.expected_outcomes.filter((o) => o.accepted).map((o) => c.assertions[o.index]!.sig);
      expect(
        solo.vault.getAssertions(solo.personaId, c.edge.edge_id).map((a) => a.sig),
        `${c.name}: stored chain`,
      ).toEqual(accepted);
    });
  });

  it('every negative vector delivered one §6.2 `assert` at a time reaches the same state', () => {
    perCase((solo, c) => {
      for (const assertion of c.assertions) {
        // Signed by a party, as a relayed assertion would be. The wrapper's signature says who
        // delivered it; the assertion's own `sig` and `by` are what the table judges.
        solo.inbox.ingest([
          signMessage(
            'assert',
            { assertion },
            COUNTERPARTY.personaId,
            '2026-07-25T12:00:00Z',
            COUNTERPARTY.privateKey,
          ),
        ]);
      }
      expect(stateOf(solo, c.edge), `${c.name}: final state via assert`).toBe(c.expected_final_state);
    });
  });

  it('a `propose` whose assertion violates the table creates no edge at all', () => {
    // The strongest form of "discarded": the vector rejected at index 0 is
    // `proposed-by-owed-to`, and after it arrives the receiving node holds nothing.
    const solo = makeSolo(1);
    try {
      const c = cases.find((x) => x.name === 'proposed-by-owed-to')!;
      const result = solo.inbox.ingest([
        signMessage(
          'propose',
          { edge: c.edge, assertion: c.assertions[0] },
          OWNER.personaId,
          '2026-07-25T12:00:00Z',
          OWNER.privateKey,
        ),
      ]);
      expect(result.discarded).toEqual([
        { type: 'propose', edge_id: c.edge.edge_id, reason: 'transition-table:wrong-signer-for-transition' },
      ]);
      expect(solo.vault.getEdge(solo.personaId, c.edge.edge_id)).toBeNull();
    } finally {
      solo.cleanup();
    }
  });

  it('a wire message whose own signature does not verify never reaches the table', () => {
    const c = cases[0]!;
    const solo = makeSolo(0);
    try {
      solo.vault.putEdge(solo.personaId, c.edge);
      const message = signMessage(
        'recon_response',
        { edges: [{ edge_id: c.edge.edge_id, assertions: c.assertions }] },
        COUNTERPARTY.personaId,
        '2026-07-25T12:00:00Z',
        COUNTERPARTY.privateKey,
      );
      const result = solo.inbox.ingest([{ ...message, sent_at: '2026-07-26T12:00:00Z' }]);
      expect(result.discarded).toEqual([
        { type: 'unknown', edge_id: null, reason: 'signature-does-not-verify' },
      ]);
      expect(solo.vault.getAssertions(solo.personaId, c.edge.edge_id)).toEqual([]);
    } finally {
      solo.cleanup();
    }
  });
});
