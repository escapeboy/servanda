import { describe, expect, it } from 'vitest';
import { withSignature } from '@servanda/crypto';
import { Attestation, PROTOCOL_VERSION } from '@servanda/types';
import * as identity from '../../src/index.js';
import {
  bindingLevel,
  signPersonaLink,
  USER_INITIATED,
  verifyAttestation,
  verifyPersonaLink,
} from '../../src/index.js';
import { DANA, GROUP, MARIA, ORG, T, at, attestation } from '../support/fixture.js';

/**
 * M-13 — "Agents are never parties: signing keys belong to personas/groups; automation acts
 * under, never as."
 *
 * The identity layer owns the *definitional* half of this rule: it decides what a key can be
 * said to be. §1.3 admits exactly two kinds of subject, `persona` and `group`. There is no
 * third kind for an agent, a bot, a service or a connector — and because §1.3's `subject_kind`
 * is a closed enum, an org that wants to attest one has nothing to put in the field.
 *
 * The other halves live with the node (§4.2 signing) and the executors (capability scope).
 */

describe('M-13: agents are never parties', () => {
  it('§1.3 admits exactly two subject kinds, neither of them automation', () => {
    const shape = Attestation.shape.subject_kind;
    expect([...shape.options].sort()).toEqual(['group', 'persona']);
  });

  it('an attestation naming an agent-shaped subject kind is refused as malformed', () => {
    for (const kind of ['agent', 'bot', 'service', 'automation', 'connector', 'executor']) {
      const forged = withSignature(
        {
          v: PROTOCOL_VERSION,
          type: 'attestation' as const,
          org: ORG.id,
          subject: MARIA.id,
          subject_kind: kind,
          claims: { display_name: 'Nightly Sync Bot' },
          issued_at: T.issued,
          expires_at: T.expires,
        },
        ORG.privateKey,
      );
      // Correctly signed by the org — and still refused, because the *shape* has no room for it.
      const verdict = verifyAttestation(forged, { now: at(T.before) });
      expect(verdict.ok, kind).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('malformed');
    }
  });

  it('a graded identity is only ever a persona or a group', () => {
    const persona = bindingLevel({
      subject: MARIA.id,
      attestation: verifyAttestation(attestation({ display_name: 'Maria Ivanova' }), {
        now: at(T.before),
        subject: MARIA.id,
      }),
    });
    const group = bindingLevel({
      subject: GROUP.id,
      attestation: verifyAttestation(
        attestation({ subject: GROUP.id, subject_kind: 'group', display_name: 'Ops', members: [MARIA.id, DANA.id] }),
        { now: at(T.before), subject: GROUP.id },
      ),
    });
    expect(persona.level).toBe('2');
    expect(group.level).toBe('2');
    // Neither result carries anything that could name automation as the party.
    for (const id of [persona, group]) {
      expect(Object.keys(id)).not.toContain('agent');
      expect(JSON.stringify(id)).not.toMatch(/agent|bot|automation/i);
    }
  });

  it('this package never holds or mints a key — automation cannot become a subject here', () => {
    // The only functions that touch a private key take one the caller already holds, and each
    // produces a statement *by* a persona. There is no generator, no keystore, no registry.
    const minters = Object.keys(identity).filter((name) =>
      /^(generate|create|mint|register)/i.test(name),
    );
    expect(minters).toEqual([]);
  });

  it('a persona link is signed by two persona keys and requires a person to ask for it', () => {
    const link = signPersonaLink({
      privateKeyA: MARIA.privateKey,
      privateKeyB: DANA.privateKey,
      intent: USER_INITIATED,
    });
    const verdict = verifyPersonaLink(link);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.personas).toEqual([MARIA.id, DANA.id]);
    // §1.6/§1.1: no automatic path. Automation running this code without the token gets an
    // exception, not a link.
    expect(() =>
      signPersonaLink({
        privateKeyA: MARIA.privateKey,
        privateKeyB: DANA.privateKey,
        intent: 'scheduled' as never,
      }),
    ).toThrow();
  });
});
