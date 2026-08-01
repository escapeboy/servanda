import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Assertion, Edge } from '@servanda/types';
import { verifyAssertionChain } from '../src/transitions.js';

/**
 * The conformance oracle. §4.3: "Any assertion violating this table is invalid and MUST be
 * discarded by conforming nodes." M-14 restates it, and vendor/vectors/README.md explains why
 * the 21 NEGATIVE cases are the ones that matter: a verifier that accepts an owner's
 * self-confirmation still passes every positive test.
 *
 * Reason strings are asserted exactly. They are part of the contract with the suite, not
 * diagnostics we are free to reword.
 */

const VECTORS = process.env['SERVANDA_VECTORS'] ?? join(process.cwd(), 'vendor/vectors');

interface VectorCase {
  name: string;
  description: string;
  edge: unknown;
  assertions: unknown[];
  expected_outcomes: { index: number; accepted: boolean; rejection_reason: string | null }[];
  expected_final_state: string;
}

function load(file: string): VectorCase[] {
  const doc = JSON.parse(readFileSync(join(VECTORS, 'transitions', file), 'utf8')) as {
    cases: VectorCase[];
  };
  return doc.cases;
}

const validCases = load('valid.json');
const invalidCases = load('invalid.json');

function run(c: VectorCase) {
  const edge = Edge.parse(c.edge);
  // Assertions are parsed with the WIRE schema, which admits `open`. Syntax is the parser's
  // job; assertability is the transition table's — that layering is what lets the node report
  // `implicit-transition-not-assertable` instead of a schema error.
  const assertions = c.assertions.map((a) => Assertion.parse(a));
  return verifyAssertionChain(edge, assertions);
}

describe('§4.3 transition table — valid chains (8 vectors)', () => {
  it('has the expected number of cases', () => {
    expect(validCases).toHaveLength(8);
  });

  for (const c of validCases) {
    it(`accepts ${c.name}`, () => {
      const result = run(c);
      expect(result.outcomes.map((o) => o.accepted)).toEqual(
        c.expected_outcomes.map((o) => o.accepted),
      );
      for (const o of result.outcomes) expect(o.rejection_reason).toBeUndefined();
      expect(result.final_state).toBe(c.expected_final_state);
    });
  }
});

describe('M-14: assertions violating the transition table are discarded (23 vectors)', () => {
  it('has the expected number of cases', () => {
    expect(invalidCases).toHaveLength(23);
  });

  for (const c of invalidCases) {
    it(`rejects ${c.name}`, () => {
      const result = run(c);
      const actual = result.outcomes.map((o) => ({
        index: o.index,
        accepted: o.accepted,
        rejection_reason: o.rejection_reason ?? null,
      }));
      expect(actual).toEqual(c.expected_outcomes);
      expect(result.final_state).toBe(c.expected_final_state);
    });
  }

  it('every negative case actually rejects at least one assertion', () => {
    for (const c of invalidCases) {
      expect(run(c).outcomes.some((o) => !o.accepted)).toBe(true);
    }
  });

  it('covers every rejection reason the vectors exercise', () => {
    const reasons = new Set(
      invalidCases.flatMap((c) =>
        c.expected_outcomes.map((o) => o.rejection_reason).filter((r): r is string => r !== null),
      ),
    );
    // If a vector ever stops exercising a reason, this makes the coverage loss visible.
    expect([...reasons].sort()).toEqual([
      'acceptance-window-not-elapsed',
      'dispute-window-not-elapsed',
      'due-is-null',
      'duplicate-assertion-by-same-party',
      'edge-id-mismatch',
      'evidence-hash-required',
      'evidence-hash-required-for-owner-closure',
      'expiry-before-due',
      'illegal-source-state',
      'implicit-transition-not-assertable',
      'invalid-signature',
      'malformed-edge-acceptance-window',
      'signer-not-a-party',
      'terminal-state-reached',
      'wrong-signer-for-transition',
    ]);
  });
});
