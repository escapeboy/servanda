import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/jcs.js';
import {
  COMMITMENT_HASHED_FIELDS,
  commitmentHash,
  commitmentHashPreimage,
} from '../src/identity-hash.js';
import { loadVectors, type HashingCase, type VectorFile } from './vectors.js';

/**
 * G0 — §3.2 commitment_hash over exactly five fields.
 * The `same_hash_as_base` cases are the invariance proof: no sixth field reaches the hash.
 */
const vectors = loadVectors<
  VectorFile<HashingCase> & { hashed_fields: string[]; base_commitment_hash: string }
>('hashing/commitment-hash.json');

describe('G0 commitment_hash (§3.2)', () => {
  it('hashes exactly the five fields the spec names', () => {
    expect(vectors.hashed_fields).toEqual([...COMMITMENT_HASHED_FIELDS]);
    expect(vectors.cases.length).toBe(14);
  });

  for (const c of vectors.cases) {
    describe(c.name, () => {
      it(`preimage is the five-field subset: ${c.description}`, () => {
        expect(commitmentHashPreimage(c.commitment)).toEqual(c.hash_preimage);
        expect(canonicalize(commitmentHashPreimage(c.commitment))).toBe(c.hash_preimage_canonical);
      });

      it('commitment_hash matches the vector', () => {
        expect(commitmentHash(c.commitment)).toBe(c.commitment_hash);
      });

      it(
        c.same_hash_as_base
          ? 'is invariant against the base hash (vault-local fields excluded)'
          : 'differs from the base hash (a hashed field changed)',
        () => {
          if (c.same_hash_as_base) {
            expect(commitmentHash(c.commitment)).toBe(vectors.base_commitment_hash);
          } else {
            expect(commitmentHash(c.commitment)).not.toBe(vectors.base_commitment_hash);
          }
        },
      );
    });
  }

  it('§3.2 invariance pair: identical promise, different evidence sets → identical hash', () => {
    const base = vectors.cases.find((c) => c.name === 'base');
    const other = vectors.cases.find((c) => c.name === 'differs-only-in-evidence-refs');
    expect(base).toBeDefined();
    expect(other).toBeDefined();
    expect(base!.commitment['evidence_refs']).not.toEqual(other!.commitment['evidence_refs']);
    expect(commitmentHash(base!.commitment)).toBe(commitmentHash(other!.commitment));
  });
});
