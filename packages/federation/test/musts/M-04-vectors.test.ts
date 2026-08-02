import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Attestation, Edge, Publish, Revocation } from '@servanda/types';
import { edgeId as edgeIdOf } from '@servanda/crypto';
import { mayServeEdge } from '../../src/serve.js';
import { makeSolo, type Solo } from '../support/fixture.js';

/**
 * §5.3 / M-4 against the conformance vectors.
 *
 * §8 named a "visibility matrix" as v0 suite scope for months while no such family existed —
 * which is how M-4 came to be presented as covered by a suite that had never tested it. The
 * family exists now, and this is the consumer that makes it bind: a vector nobody replays is a
 * document, not a requirement.
 *
 * Every case is run through the SAME `mayServeEdge` the recon and recovery responders call. A
 * test that re-implemented the decision would agree with itself and prove nothing about what a
 * peer actually receives.
 */

interface VisibilityCase {
  name: string;
  description: string;
  rule: string;
  input: {
    now: string;
    holder: string;
    requester: string;
    edge: Edge;
    publishes: Publish[];
    attestations: Attestation[];
    revocations: Revocation[];
  };
  expected:
    | { serve: false; reason: string }
    | { serve: true; via: 'party' }
    | { serve: true; via: 'scope'; scope: string };
}

const VECTORS = process.env['SERVANDA_VECTORS'] ?? join(process.cwd(), 'vendor/vectors');
const cases: VisibilityCase[] = JSON.parse(
  readFileSync(join(VECTORS, 'visibility', 'matrix.json'), 'utf8'),
).cases;

let solo: Solo;
beforeAll(() => {
  solo = makeSolo(0);
});
afterAll(() => solo.cleanup());

/**
 * Stand the case's documents up in a real vault and ask the real predicate.
 *
 * The holder in every vector is ALICE (persona 0), which is this fixture's persona — the decision
 * is about what THIS node will serve, so the holder has to be the node.
 */
type Decision = { kind: 'served'; grant: ReturnType<typeof mayServeEdge> } | { kind: 'not-storable'; why: string };

function decide(c: VisibilityCase): Decision {
  const vault = solo.vault;
  // The vault is reused across cases, so each case's documents must be the only ones present.
  // A leftover publish record from an earlier case would grant access the current case denies,
  // and the failure would land in whichever case happened to run second — which is exactly what
  // it did while this cleared a directory named `publishes` and the vault writes to `publish`.
  clearScopeRecords(vault.dir, solo.personaId);
  // §5.2 records are about edges, and the vault refuses a publish naming an edge it does not
  // hold — a guard worth keeping, so the case's edges go in first. `putEdge` is idempotent under
  // §4.1's binding rule, so re-storing across cases is a no-op rather than a conflict.
  vault.putEdge(solo.personaId, c.input.edge);
  try {
    for (const p of c.input.publishes) {
      if (p.edge_id !== c.input.edge.edge_id) vault.putEdge(solo.personaId, edgeFor(c, p.edge_id));
      vault.putPublish(solo.personaId, p);
    }
  } catch (err) {
    // Some cases describe a document THIS vault will not store at all — §5.2's non-party publish
    // is one. That is a stricter outcome than the vector requires, not a failure to meet it: the
    // vector says such a record grants nothing, and refusing to hold it grants nothing more
    // firmly. Reported rather than swallowed, so a case that stops being storable for some
    // unrelated reason cannot pass as if it had been decided.
    return { kind: 'not-storable', why: (err as Error).message };
  }
  for (const a of c.input.attestations) vault.putAttestation(solo.personaId, a);
  for (const r of c.input.revocations) vault.putRevocation(solo.personaId, r);
  return {
    kind: 'served',
    grant: mayServeEdge(vaultAt(vault, c.input.now), solo.personaId, c.input.requester, c.input.edge),
  };
}

/**
 * The `a-publish-for-a-different-edge` case names a second edge the holder genuinely has. Only its
 * id is in the publish record, so the body is reconstructed from the case's own edge — same
 * parties, same commitment, a different `proposed_at`, which is the one member of the §4.1
 * preimage that can move an id without changing who the edge is between.
 */
function edgeFor(c: VisibilityCase, edgeId: string): Edge {
  for (const at of ['2026-07-26T09:00:00Z']) {
    const candidate = { ...c.input.edge, proposed_at: at, edge_id: edgeId };
    if (edgeIdOf(candidate) === edgeId) return candidate;
  }
  throw new Error(`cannot reconstruct the edge body for ${edgeId}`);
}

/** The vector fixes `now`; the vault's clock is what `mayServeEdge` reads it from. */
function vaultAt(vault: Solo['vault'], now: string): Solo['vault'] {
  return new Proxy(vault, {
    get: (target, prop, receiver) =>
      prop === 'now' ? () => now : Reflect.get(target, prop, receiver),
  });
}

function clearScopeRecords(dir: string, persona: string): void {
  const { rmSync } = require('node:fs') as typeof import('node:fs');
  for (const sub of ['publish', 'attestations', 'revocations']) {
    rmSync(join(dir, 'personas', persona, sub), { recursive: true, force: true });
  }
}

describe('M-4: a node serves an edge only to a party or a member of a scope it is published in', () => {
  it('the suite carries the family §8 claimed for months that it had', () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
    const rules = new Set(cases.map((c) => c.rule));
    expect([...rules].sort()).toEqual(['M-4a', 'M-4b', 'M-4c', '§5.2']);
  });

  it('exercises both outcomes, so a refuse-everything implementation cannot pass', () => {
    expect(cases.filter((c) => c.expected.serve).length).toBeGreaterThan(0);
    expect(cases.filter((c) => !c.expected.serve).length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(`${c.rule}: ${c.name}`, () => {
      const decision = decide(c);
      if (decision.kind === 'not-storable') {
        // Only a REFUSAL may be satisfied this way. A case the vector says must be SERVED, and
        // which this vault cannot even set up, is a genuine disagreement.
        expect(c.expected.serve, `${c.name} expects a grant but its documents were refused`).toBe(false);
        expect(decision.why).toMatch(/§5.2|does not hold/);
        return;
      }
      expect(decision.grant).toEqual(c.expected);
    });
  }

  it('at most one case is satisfied by the vault refusing to hold its documents', () => {
    // A guard on the escape hatch above. If it ever covers most of the family, the family has
    // stopped testing the serving decision and started testing the vault's write path.
    const unstorable = cases.filter((c) => decide(c).kind === 'not-storable');
    expect(unstorable.map((c) => c.name)).toEqual(['a-publish-signed-by-a-non-party-is-not-a-grant']);
  });
});
