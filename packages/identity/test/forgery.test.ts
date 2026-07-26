import { describe, expect, it } from 'vitest';
import { withSignature } from '@servanda/crypto';
import { PROTOCOL_VERSION } from '@servanda/types';
import {
  DomainAnchorResolver,
  bindingLevel,
  signPersonaLink,
  signRotation,
  resolveSuccessor,
  USER_INITIATED,
  verifyAttestation,
  verifyPersonaLink,
  verifyRotation,
} from '../src/index.js';
import {
  ATTACKER,
  DANA,
  FRESH,
  MARIA,
  ORG,
  OTHER_ORG,
  T,
  anchorDocument,
  at,
  attestation,
  fixedClock,
  wellKnownTransport,
} from './support/fixture.js';

/**
 * GATE GG requirement 2, in one place: the four forgeries the gate names must each fail, and
 * must fail for the stated reason rather than by accident.
 */
describe('GG/2 forgeries', () => {
  it('an attestation signed by a non-org key is rejected', () => {
    const forged = attestation({ signWith: ATTACKER, display_name: 'Maria Ivanova' });
    const verdict = verifyAttestation(forged, { now: at(T.before), subject: MARIA.id });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('signature-invalid');
    // …and the ladder does not launder it into a name.
    const id = bindingLevel({ subject: MARIA.id, priorConfirmedEdges: 3, attestation: verdict });
    expect(id.level).toBe('1');
    expect(id.displayName).toBeNull();
  });

  it('a rotation with a missing `sig` is rejected', () => {
    const verdict = verifyRotation({
      v: PROTOCOL_VERSION,
      type: 'rotation',
      old: MARIA.id,
      new: ATTACKER.id,
      rotated_at: '2026-05-01T00:00:00Z',
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('malformed');
  });

  it('a rotation with a wrong `sig` is rejected and moves no open edge', () => {
    const forged = withSignature(
      {
        v: PROTOCOL_VERSION,
        type: 'rotation' as const,
        old: MARIA.id,
        new: ATTACKER.id,
        rotated_at: '2026-05-01T00:00:00Z',
      },
      ATTACKER.privateKey,
    );
    const verdict = verifyRotation(forged);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('not-signed-by-old-key');

    const genuine = signRotation({
      oldPrivateKey: MARIA.privateKey,
      newPublicKey: FRESH.id,
      rotatedAt: '2026-05-01T00:00:00Z',
    });
    // Mixing the forgery into a genuine history does not corrupt the outcome.
    expect(resolveSuccessor(MARIA.id, [forged, genuine]).current).toBe(FRESH.id);
    expect(resolveSuccessor(MARIA.id, [forged]).current).toBe(MARIA.id);
  });

  it('a link where only one persona signed is rejected', () => {
    const genuine = signPersonaLink({
      privateKeyA: MARIA.privateKey,
      privateKeyB: DANA.privateKey,
      intent: USER_INITIATED,
    });
    // A alone, copied into both slots.
    expect(verifyPersonaLink({ ...genuine, sig_B: genuine.sig_A }).ok).toBe(false);
    // A alone, with B's slot filled by a signature A produced over a different statement.
    const soloB = signPersonaLink({
      privateKeyA: MARIA.privateKey,
      privateKeyB: ATTACKER.privateKey,
      intent: USER_INITIATED,
    });
    const spliced = verifyPersonaLink({ ...genuine, sig_B: soloB.sig_B });
    expect(spliced.ok).toBe(false);
    if (!spliced.ok) expect(spliced.reason).toBe('sig-b-invalid');
  });

  it('an anchor whose org_root disagrees with the attestation never confers level 3', async () => {
    const anchor = await new DomainAnchorResolver({
      transport: wellKnownTransport(anchorDocument(OTHER_ORG.id)),
      clock: fixedClock(T.before),
    }).resolve('acme.com');
    const id = bindingLevel({
      subject: MARIA.id,
      attestation: verifyAttestation(attestation({ display_name: 'Maria Ivanova' }), {
        now: at(T.before),
        subject: MARIA.id,
      }),
      anchor,
    });
    expect(id.level).toBe('2');
    expect(id.anchoredDomain).toBeNull();
    expect(id.downgrades.map((d) => d.reason)).toContain('anchor:org-root-mismatch');
    expect(anchor.anchor?.org_root).toBe(OTHER_ORG.id);
    expect(anchor.anchor?.org_root).not.toBe(ORG.id);
  });
});
