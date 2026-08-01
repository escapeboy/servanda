import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  canonicalizeText,
  canonicalBytes,
  JcsDepthExceeded,
  MAX_CANONICALIZATION_DEPTH,
} from '../src/jcs.js';
import { sha256Hex } from '../src/hash.js';
import { loadVectors, type CanonicalizationCase, type VectorFile } from './vectors.js';

/**
 * G0 — RFC 8785 JCS conformance.
 * Spec §00 Conventions: one canonical byte representation per object.
 */
const vectors = loadVectors<VectorFile<CanonicalizationCase>>('canonicalization/jcs.json');

describe('G0 canonicalization (RFC 8785)', () => {
  it('vector file matches the protocol version this implementation targets', () => {
    expect(vectors.protocol_version).toBe('servanda/0.2');
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

describe('canonicalization refuses hostile nesting rather than exhausting the stack', () => {
  const nest = (depth: number): unknown => {
    let node: unknown = { leaf: 1 };
    for (let i = 0; i < depth; i++) node = { nested: node };
    return node;
  };
  const nestArrays = (depth: number): unknown => {
    let node: unknown = [1];
    for (let i = 0; i < depth; i++) node = [node];
    return node;
  };

  it('canonicalizes any depth a real protocol object could reach', () => {
    // The deepest object the spec defines nests about five levels.
    expect(() => canonicalize(nest(32))).not.toThrow();
    expect(() => canonicalize(nest(MAX_CANONICALIZATION_DEPTH - 2))).not.toThrow();
  });

  it('throws a typed, catchable error past the bound — objects and arrays alike', () => {
    // Regression: this input raised a bare RangeError from stack exhaustion, which passed on
    // macOS and crashed on Linux. A hash function reachable from hostile input must fail the
    // same way everywhere, and must fail in a way a caller can catch and reject on.
    expect(() => canonicalize(nest(5000))).toThrow(JcsDepthExceeded);
    expect(() => canonicalize(nestArrays(5000))).toThrow(JcsDepthExceeded);
    expect(() => canonicalize(nest(5000))).toThrow(/refusing to canonicalize/);
  });

  it('the refusal propagates through hashing, so nothing unbounded is ever signed', () => {
    expect(() => sha256Hex(canonicalBytes(nest(5000)))).toThrow(JcsDepthExceeded);
  });
});
