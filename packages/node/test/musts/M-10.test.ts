import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixture, nodeAs, syncEdge, type Fixture } from '../support/fixture.js';

/**
 * M-10 — Base protocol (L0–L1) MUST function with no network, server, or second participant.
 *
 * Owned by this layer. Two halves:
 *  1. In-process: every §7 tool works against a bare vault with nobody else present.
 *  2. Out-of-process (`prove-no-network.mjs`): the shipped node answers all six tools inside a
 *     child process whose network primitives throw, with positive and negative controls that
 *     show the trap is armed, plus a static audit of the shipped module graph. That half runs in
 *     gate GA rather than here — see the last test for why, and for what keeps it running.
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

  /**
   * The no-network proof runs in gate GA, not here — and this test is what keeps that true.
   *
   * It used to `execFileSync` the prover from inside a vitest worker: ~30 s of synchronous
   * blocking, 80 s under contention. That matters because vitest's `onTaskUpdate` timeout is
   * enforced by a timer INSIDE the worker and accumulates over the FILE, so one test blocking
   * past 60 s makes a run exit non-zero with every assertion green. `vitest.setup.ts` yields
   * after each test and cures the cumulative case; it cannot cure a single test that blocks past
   * the limit, because by then the timer has already fired. This was the last one in the tree.
   *
   * Deleting it outright would have been the wrong fix, so this replaces it: the prover is
   * enforced by `gates/ga-node.sh` step GA/2, which runs it in a plain node process under
   * `set -euo pipefail` — a 30 s call there blocks nobody. What could silently rot is the
   * DELEGATION: someone removes the prover, or drops the line from the gate, and the property
   * stops being checked anywhere while this file still carries M-10's name.
   *
   * So the assertion is on the wiring, and it costs milliseconds.
   */
  it('delegates the no-network proof to gate GA, and the gate still runs it', () => {
    expect(existsSync(PROVER)).toBe(true);
    const gate = readFileSync(join(HERE, '..', '..', '..', '..', 'gates', 'ga-node.sh'), 'utf8');
    // The path as the gate spells it, relative to the repository root.
    expect(gate).toContain('node packages/node/test/support/prove-no-network.mjs');
    // `set -e`, or a failing prover would print and the gate would carry on to PASS.
    expect(gate).toMatch(/^set -euo pipefail$/mu);
  });
});
