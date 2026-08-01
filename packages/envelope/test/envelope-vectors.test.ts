import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalBytes, envelopeId } from '@servanda/crypto';
import {
  MAX_ENVELOPE_OCTETS,
  MAX_LABEL,
  MAX_PAYLOAD_DEPTH,
  MAX_PAYLOAD_TEXT,
  MAX_REF,
  MAX_REFS,
  boundsViolation,
  octets,
} from '../src/index.js';

/**
 * §2 envelope vectors, replayed against this implementation.
 *
 * Until these existed, M-19 and the §2 `id` preimage were enforced only by tests this project
 * wrote about its own code — which checks that the implementation agrees with itself. §8 said so
 * in as many words, and GOVERNANCE.md draws the consequence: a behaviour the suite does not cover
 * is not yet a conformance requirement.
 *
 * The vectors are read-only. A failure here is a defect in this package or a finding to file
 * upstream; it is never fixed by editing a file under vendor/.
 */

const ID_VECTORS = 'vendor/vectors/envelope/envelope-id.json';
const BOUNDS_VECTORS = 'vendor/vectors/envelope/bounds.json';

const readVectors = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

describe('§2 envelope id vectors', () => {
  const v = readVectors(ID_VECTORS);

  it('agrees with the vendored suite version', () => {
    expect(v.protocol_version).toBe('servanda/0.1');
    expect(v.domain_tag.tag).toBe('servanda/0.1:envelope_id');
    expect(v.cases.length).toBeGreaterThan(0);
  });

  it.each(v.cases.map((c: { name: string }) => [c.name] as const))(
    'computes the recorded id for %s',
    (name) => {
      const c = v.cases.find((x: { name: string }) => x.name === name)!;
      expect(envelopeId(c.envelope_sans_id)).toBe(c.id);
      // The canonical form is part of the vector, so a disagreement points at JCS rather than
      // at the digest — two different defects that would otherwise look identical.
      expect(new TextDecoder().decode(canonicalBytes(c.envelope_sans_id))).toBe(c.canonical);
      expect((c.id === v.base_id) === c.same_id_as_base).toBe(true);
    },
  );

  it('removes `id` from its own preimage', () => {
    // The one case that cannot be written as a patch: an envelope that already carries an `id`
    // hashes to the base id once it is taken out. A digest that fed on its own previous value
    // would be unrecomputable by anyone holding the stored envelope.
    const { id: _discarded, ...stripped } = v.id_removal.envelope_with_id;
    expect(envelopeId(stripped)).toBe(v.base_id);
    expect(v.id_removal.envelope_with_id.id).not.toBe(v.base_id);
  });

  it('lets `persona` and `received_at` reach the digest, as upstream #36 records', () => {
    // Not an endorsement of §2's determinism sentence — the vectors take no position and neither
    // does this test. It pins the behaviour so that a change to it is a deliberate act.
    for (const name of ['differs-in-persona', 'differs-in-received-at']) {
      const c = v.cases.find((x: { name: string }) => x.name === name)!;
      expect(envelopeId(c.envelope_sans_id)).not.toBe(v.base_id);
    }
  });
});

describe('§2 envelope bounds vectors (M-19)', () => {
  const v = readVectors(BOUNDS_VECTORS);

  it('carries the bounds this package implements', () => {
    // The vector states §2's numbers as data. If this package drifts from them, the mismatch is
    // reported here rather than as a puzzling per-case failure.
    expect(v.bounds).toMatchObject({
      canonical_form_octets: MAX_ENVELOPE_OCTETS,
      payload_depth_below_payload: MAX_PAYLOAD_DEPTH,
      refs_entries: MAX_REFS,
      ref_value_octets: MAX_REF,
      actor_label_octets: MAX_LABEL,
      payload_string_octets: MAX_PAYLOAD_TEXT,
    });
  });

  it.each(v.cases.map((c: { name: string }) => [c.name] as const))(
    'judges %s the way the vector does',
    (name) => {
      const c = v.cases.find((x: { name: string }) => x.name === name)!;
      const violation = boundsViolation(c.envelope_sans_id);
      expect(violation === null).toBe(c.within_bounds);
    },
  );

  it('clips to a scalar boundary rather than to the octet count', () => {
    const ex = v.clipping.scalar_boundary_example;
    expect(octets(ex.source)).toBe(ex.source_octets);
    // The rule §2 states: no code point in the clipped value that is absent from the source. A
    // cut taken at exactly MAX_PAYLOAD_TEXT would slice this example's last scalar into pieces.
    expect(ex.source.startsWith(ex.clipped)).toBe(true);
    expect(octets(ex.clipped)).toBeLessThanOrEqual(MAX_PAYLOAD_TEXT);
    expect(ex.clipped).not.toContain('�');
  });

  it('covers every bound on both sides', () => {
    // A family that only ever tested the accepting side would report coverage it does not have.
    const sides = new Map<string, Set<boolean>>();
    for (const c of v.cases as { bound: string; within_bounds: boolean }[]) {
      if (!sides.has(c.bound)) sides.set(c.bound, new Set());
      sides.get(c.bound)!.add(c.within_bounds);
    }
    for (const [bound, seen] of sides) {
      expect(seen, `${bound} needs a case on both sides`).toEqual(new Set([true, false]));
    }
  });
});
