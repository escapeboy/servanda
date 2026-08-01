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
  clip,
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
    // THIS is the line that replays the vector: `clip` is handed the source and has to land on
    // the octet the vector names. Every assertion below it is about the example itself, and an
    // earlier version of this test had only those — it passed unchanged with `clip` reduced to
    // `bytes.subarray(0, maxOctets)`, which produces the U+FFFD §2 forbids. A vector nobody feeds
    // to the implementation checks the vector.
    expect(clip(ex.source, MAX_PAYLOAD_TEXT)).toBe(ex.clipped);
    expect(octets(ex.clipped)).toBe(ex.clipped_to_octets);
    // The rule §2 states: no code point in the clipped value that is absent from the source. A
    // cut taken at exactly MAX_PAYLOAD_TEXT would slice this example's last scalar into pieces.
    expect(ex.source.startsWith(ex.clipped)).toBe(true);
    expect(octets(ex.clipped)).toBeLessThanOrEqual(MAX_PAYLOAD_TEXT);
    expect(ex.clipped).not.toContain('�');
  });

  it('measures each case the way the vector measured it', () => {
    // `within_bounds` alone is a one-bit answer, and the vector carries the measurement as well
    // so that an implementation which lands on the right verdict from the wrong number is caught.
    // Every case sits ON its bound or one unit past it, so the measure is checkable exactly.
    const measure: Record<string, (e: Record<string, never>) => number> = {
      refs_entries: (e) => (e['refs'] as unknown as unknown[]).length,
      ref_value_octets: (e) =>
        Math.max(...(e['refs'] as unknown as { value: string }[]).map((r) => octets(r.value))),
      actor_label_octets: (e) => octets((e['actor'] as unknown as { label: string }).label),
      payload_string_octets: (e) =>
        Math.max(
          ...Object.values(e['payload'] as unknown as Record<string, unknown>)
            .filter((x): x is string => typeof x === 'string')
            .map(octets),
        ),
      canonical_form_octets: (e) => canonicalBytes(e).length,
    };
    for (const c of v.cases as { name: string; bound: string; measured: number; envelope_sans_id: Record<string, never> }[]) {
      const m = measure[c.bound];
      if (m === undefined) continue; // depth is a count of levels, not of anything octets()able
      expect(m(c.envelope_sans_id), `${c.name} measures ${c.bound}`).toBe(c.measured);
    }
  });

  it('refuses a document nested past the canonicalizer limit instead of blowing the stack', () => {
    // Stated in the vector as a property of the canonicalizer rather than of the envelope, which
    // is why it has no case — but an envelope is the thing that gets canonicalized, so it is
    // reachable from here: a member the §2 payload-depth check does not walk (`actor` is not
    // `payload`) carries the nesting all the way to JCS. What the vector asks for is a REPORTED
    // refusal; a RangeError from the platform's own recursion limit would satisfy neither the
    // depth number nor the word "report".
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < v.canonicalizer_refusal.depth + 8; i++) deep = { d: deep };
    const base = v.cases.find((c: { name: string }) => c.name === 'refs-at-the-limit')!.envelope_sans_id;
    let thrown: unknown;
    try {
      boundsViolation({ ...base, actor: { label: 'x', nested: deep } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('JcsDepthExceeded');
    expect((thrown as Error).message).toContain(String(v.canonicalizer_refusal.depth));
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
