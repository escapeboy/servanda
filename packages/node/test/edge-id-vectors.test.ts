import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { edgeId } from '@servanda/crypto';
import { Edge } from '@servanda/types';

/**
 * §4.1: "`vectors/transitions/valid.json` is normative for the exact bytes: any implementation
 * that reproduces its `edge_id` values has the encoding right."
 *
 * Nothing did. The suite consumed those files for their assertion chains and never recomputed a
 * single identifier, so the only pin on the §4.1 preimage was the generator's own arithmetic
 * agreeing with itself — the vectors nominated a normative role and no consumer took it up.
 *
 * That is why the body-binding break survived a whole conformance suite. An `edge_id` nobody
 * recomputes is a name, and a name attaches to whatever its sender says it does.
 *
 * The §4.1 worked example is included as a literal because a case computed from the same
 * function it checks would agree with any encoding, including a wrong one.
 */

const VECTORS = process.env['SERVANDA_VECTORS'] ?? join(process.cwd(), 'vendor/vectors');

function edgesIn(family: string, file: string): { name: string; edge: Edge }[] {
  const doc = JSON.parse(readFileSync(join(VECTORS, family, file), 'utf8')) as {
    cases: { name: string; edge?: unknown }[];
  };
  return doc.cases
    .filter((c) => c.edge !== undefined)
    .map((c) => ({ name: c.name, edge: Edge.parse(c.edge) }));
}

/**
 * One negative vector is exempt, and it is exempt because it IS this rule:
 * `edge-id-does-not-bind-its-body` carries an unbound identifier so that the suite says out loud
 * what a node does with one. Named rather than detected by a predicate — a predicate would
 * quietly excuse the next unbound edge, which is the failure this file exists to catch.
 */
const DELIBERATELY_UNBOUND = 'edge-id-does-not-bind-its-body';
const ALL = [...edgesIn('transitions', 'valid.json'), ...edgesIn('transitions', 'invalid.json')];
const EDGES = ALL.filter((e) => e.name !== DELIBERATELY_UNBOUND);

describe('§4.1 edge_id preimage, recomputed from the vectors that define it', () => {
  it('the suite carries edges to check', () => {
    expect(EDGES.length).toBeGreaterThan(20);
  });

  it('and carries the one case that is deliberately unbound', () => {
    const declared = ALL.filter((e) => e.name === DELIBERATELY_UNBOUND);
    expect(declared).toHaveLength(1);
    expect(edgeId(declared[0]!.edge)).not.toBe(declared[0]!.edge.edge_id);
  });

  it('every vector edge_id is the digest of its own body', () => {
    const wrong = EDGES.filter(({ edge }) => edgeId(edge) !== edge.edge_id).map((e) => e.name);
    expect(wrong).toEqual([]);
  });

  it('reproduces the §4.1 worked example byte for byte', () => {
    // spec/04-edge.md §4.1, case `on-acceptance-explicit-accept`. Typed out rather than read
    // from the file: this is the one assertion in the suite that does not derive its expectation
    // from the thing it is testing.
    expect(
      edgeId({
        commitment_hash: '9b1ac57fc1d466240ff28c10f70b74d5a9bf8344325b3130504955e7cd53cec5',
        owner: 'a8a49af4e897c55abaab67d4933c14395d7a5d2ede1b4421981970468864351a',
        owed_to: '72d2b4360c12a3be02c3dd4092410c18c18870985891e7a099d94a93e3b38c0f',
        proposed_at: '2026-07-25T09:00:00Z',
      }),
    ).toBe('141ffc0642fe610224ede93212bc2526d577a2d8ec2a29024afadba0ca5ffe0a');
  });

  it('the digest moves when any bound member does', () => {
    // Guards the check above against a `edgeId` that ignored its input: four members are in the
    // preimage and each must change it. The unbound members are §4.1's own point — they are why
    // first-sight body binding is a MUST rather than something the identifier could carry.
    const base = {
      commitment_hash: '9b1ac57fc1d466240ff28c10f70b74d5a9bf8344325b3130504955e7cd53cec5',
      owner: 'a8a49af4e897c55abaab67d4933c14395d7a5d2ede1b4421981970468864351a',
      owed_to: '72d2b4360c12a3be02c3dd4092410c18c18870985891e7a099d94a93e3b38c0f',
      proposed_at: '2026-07-25T09:00:00Z',
    };
    const digests = new Set([
      edgeId(base),
      edgeId({ ...base, commitment_hash: 'f'.repeat(64) }),
      edgeId({ ...base, owner: base.owed_to, owed_to: base.owner }),
      edgeId({ ...base, proposed_at: '2026-07-25T09:00:01Z' }),
    ]);
    expect(digests.size).toBe(4);
  });
});
