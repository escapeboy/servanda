import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyObject } from '@servanda/crypto';

/**
 * §6.6 recovery vectors, replayed.
 *
 * The family exists because of a hole rather than a feature: v0.1 accepted a bare `Rotation` as
 * the whole proof of a recovery request. Rotations are PUBLISHED, so the signature a responder
 * verified was genuine, by the old key, over a public artifact — and it attested to the wrong
 * proposition. Anyone who had watched a rotation go by could replay it and receive the edges and
 * assertion chains of both identities without holding either key.
 *
 * Read-only. A failure here is a defect in this package or a finding to file upstream; it is never
 * fixed by editing a file under vendor/.
 */

const VECTORS = 'vendor/vectors/recovery/proof-of-possession.json';

interface Case {
  name: string;
  description: string;
  request: {
    v: string;
    type: string;
    persona: string;
    proof: { challenge: string; sig?: string; rotation?: Record<string, unknown> };
  };
  expected: { accepted: boolean; reason?: string };
}

const suite = JSON.parse(readFileSync(VECTORS, 'utf8')) as {
  protocol_version: string;
  challenge_preimage: { type: string };
  cases: Case[];
};

describe('§6.6 recovery proof-of-possession vectors', () => {
  it('is the family this build implements', () => {
    expect(suite.protocol_version).toBe('servanda/0.2');
    expect(suite.challenge_preimage.type).toBe('recovery_challenge');
    expect(suite.cases.length).toBeGreaterThan(1);
  });

  it.each(suite.cases.map((c) => [c.name] as const))('judges %s the way the oracle does', (name) => {
    const c = suite.cases.find((x) => x.name === name)!;
    const { challenge, sig } = c.request.proof;

    // The predicate under test, stated where a reader can see it: a request is answerable only if
    // it carries a signature over its challenge that verifies under the persona it names.
    const holdsTheKey =
      sig !== undefined &&
      verifyObject(
        { v: suite.protocol_version, type: suite.challenge_preimage.type, challenge, sig },
        c.request.persona,
      );

    const rotationNamesThisPersona =
      c.request.proof.rotation === undefined ||
      c.request.proof.rotation['new'] === c.request.persona;

    expect(holdsTheKey && rotationNamesThisPersona).toBe(c.expected.accepted);
  });

  it('refuses a bare published rotation, and the case really is bare', () => {
    // Asserted structurally, so this cannot decay into a case that refuses for some other reason
    // and still looks green.
    const bare = suite.cases.find((c) => c.name === 'bare-rotation-is-not-a-proof')!;
    expect(bare.request.proof.rotation).toBeDefined();
    expect(bare.request.proof.sig).toBeUndefined();
    expect(bare.expected.accepted).toBe(false);
    expect(bare.expected.reason).toBe('no-proof-of-possession');
  });

  it('refuses a challenge signed by the predecessor', () => {
    // Succession is not possession of the successor. The rotation is genuine in this case.
    const borrowed = suite.cases.find((c) => c.name === 'challenge-signed-by-the-old-key')!;
    expect(borrowed.request.proof.sig).toBeDefined();
    expect(borrowed.expected.accepted).toBe(false);
  });
});
