import { describe, expect, it } from 'vitest';
import { canonicalize, canonicalizeText, canonicalBytes } from '../src/jcs.js';
import { sha256Hex } from '../src/hash.js';
import { loadVectors, type CanonicalizationCase, type VectorFile } from './vectors.js';

/**
 * G0 — RFC 8785 JCS conformance.
 * Spec §00 Conventions: one canonical byte representation per object.
 */
const vectors = loadVectors<VectorFile<CanonicalizationCase>>('canonicalization/jcs.json');

describe('G0 canonicalization (RFC 8785)', () => {
  it('vector file matches the protocol version this implementation targets', () => {
    expect(vectors.protocol_version).toBe('servanda/0.1');
    expect(vectors.cases.length).toBe(16);
  });

  for (const c of vectors.cases) {
    describe(c.name, () => {
      it(`canonical form: ${c.description}`, () => {
        expect(canonicalizeText(c.input)).toBe(c.canonical);
      });

      it('sha256 over the UTF-8 bytes of the canonical form', () => {
        expect(sha256Hex(canonicalBytes(JSON.parse(c.input)))).toBe(c.sha256);
      });

      it('canonicalization is idempotent', () => {
        expect(canonicalizeText(c.canonical)).toBe(c.canonical);
      });
    });
  }

  it('rejects non-finite numbers rather than emitting invalid JSON', () => {
    expect(() => canonicalize({ x: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalize({ x: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it('orders integer-like keys by UTF-16 code unit, not numerically', () => {
    // The failure mode that rebuilding a sorted object and calling JSON.stringify would hide:
    // JS objects reorder integer-like keys ahead of everything else.
    expect(canonicalize({ '10': 1, '2': 2, a: 3 })).toBe('{"10":1,"2":2,"a":3}');
  });
});
