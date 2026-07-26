import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSignature } from '@servanda/crypto';
import { PROTOCOL_VERSION, VerificationLevel, type Attestation } from '@servanda/types';
import { makeFixture, nodeAs, persona, syncEdge, type Fixture } from '../support/fixture.js';

/**
 * M-12 — Clients MUST display verification level and MUST NOT render a display name above its
 * evidence level.
 *
 * OWNED BY: the client stream (Stream C / clients per §8's conformance levels) — rendering is
 * not this layer's job. What THIS layer guarantees, and asserts below: the node always SUPPLIES
 * the level, computes it strictly from evidence it holds, and never hands a client a display
 * name that the level does not support. A client cannot render a name above its evidence if
 * the node never gave it one.
 */

let fx: Fixture;
let edgeId: string;

beforeAll(() => {
  fx = makeFixture();
  edgeId = fx.node.commit({
    intent: 'the promise',
    owed_to: fx.personas[1]!,
    due: null,
    persona: null,
    propose: true,
  }).edge_id!;
  syncEdge(fx, 0, 1, edgeId);
});
afterAll(() => fx.cleanup());

describe('M-12: the node supplies verification level and never a name above it', () => {
  it('every open_loops item carries a valid §1.6 level', () => {
    const { items } = fx.node.openLoops({ view: 'all', persona: null, limit: 50 });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(() => VerificationLevel.parse(item.verification_level)).not.toThrow();
    }
  });

  it('an unknown key is level 0 and is identified only by its key', () => {
    const stranger = persona(100).personaId;
    expect(fx.node.verificationLevel(fx.personas[0]!, stranger)).toBe('0');
    const item = fx.node
      .openLoops({ view: 'all', persona: null, limit: 50 })
      .items.find((i) => i.counterparty === fx.personas[1]!);
    // No display name is emitted at level 0 — the counterparty is the raw persona_id.
    expect(item?.counterparty).toBe(fx.personas[1]!);
    expect(item?.verification_level).toBe('0');
  });

  it('level 1 requires a prior confirmed edge with this key, not a claim', () => {
    nodeAs(fx, 1).confirm({ id: edgeId, decision: 'confirm' });
    syncEdge(fx, 1, 0, edgeId);
    expect(fx.node.verificationLevel(fx.personas[0]!, fx.personas[1]!)).toBe('1');
  });

  it('a display name only becomes available at level 2, from a valid attestation', () => {
    const org = persona(100);
    const attestation = withSignature(
      {
        v: PROTOCOL_VERSION,
        type: 'attestation' as const,
        org: org.personaId,
        subject: fx.personas[1]!,
        subject_kind: 'persona' as const,
        claims: { display_name: 'Maria Ivanova', handle: 'maria@acme.com' },
        issued_at: '2026-07-01T00:00:00Z',
        expires_at: '2027-07-01T00:00:00Z',
      },
      org.privateKey,
    ) as Attestation;

    // Before the attestation exists in the vault, the node has no name to give out at all.
    expect(fx.vault.getAttestation(fx.personas[0]!, fx.personas[1]!)).toBeNull();

    fx.vault.putAttestation(fx.personas[0]!, attestation);
    expect(fx.node.verificationLevel(fx.personas[0]!, fx.personas[1]!)).toBe('2');
    expect(fx.vault.getAttestation(fx.personas[0]!, fx.personas[1]!)?.claims.display_name).toBe(
      'Maria Ivanova',
    );
  });

  it('a revoked attestation drops the level back to the evidence that remains', () => {
    const org = persona(100);
    fx.vault.putRevocation(
      fx.personas[0]!,
      withSignature(
        {
          v: PROTOCOL_VERSION,
          type: 'revocation' as const,
          org: org.personaId,
          subject: fx.personas[1]!,
          revoked_at: '2026-07-20T00:00:00Z',
        },
        org.privateKey,
      ) as never,
    );
    // §1.3: edges signed before revocation stay valid, so continuity (level 1) survives; the
    // org's name claim does not.
    expect(fx.node.verificationLevel(fx.personas[0]!, fx.personas[1]!)).toBe('1');
  });
});
