import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyObject } from '@servanda/crypto';
import { PersonaRecord } from '@servanda/vault';
import { makeFixture, type Fixture } from '../support/fixture.js';

/**
 * M-13 — Agents are never parties: signing keys belong to personas/groups; automation acts
 * under, never as.
 *
 * Owned by this layer (the node is the only thing that signs) together with the executor
 * stream, which owns the capability side of the same rule.
 */

let fx: Fixture;
let edgeId: string;

beforeAll(() => {
  fx = makeFixture();
  edgeId = fx.node.commit({
    intent: 'automation-assisted promise',
    owed_to: fx.personas[1]!,
    due: null,
    persona: null,
    propose: true,
  }).edge_id!;
});
afterAll(() => fx.cleanup());

describe('M-13: agents are never parties', () => {
  it('the only key-bearing record type in the vault is a persona', () => {
    // There is no agent record, no bot identity, no service key. A PersonaRecord is the only
    // shape that holds a private key, and it is indexed by persona_id.
    const record = fx.vault.getPersona(fx.personas[0]!);
    expect(() => PersonaRecord.parse(record)).not.toThrow();
    expect(record.persona_id).toBe(fx.personas[0]);
    expect(record.persona_index).toBe(0);
  });

  it('every assertion is attributed to, and verifies against, a persona key', () => {
    for (const a of fx.vault.getAssertions(fx.personas[0]!, edgeId)) {
      expect(fx.vault.listPersonaIds()).toContain(a.by);
      expect(verifyObject(a as unknown as Record<string, unknown>, a.by)).toBe(true);
    }
  });

  it('the wire message is signed by the persona, not by whatever invoked the tool', () => {
    const item = fx.vault.listOutbox(fx.personas[0]!)[0]!;
    expect(item.message['sender']).toBe(fx.personas[0]);
    expect(
      verifyObject(item.message as Record<string, unknown>, fx.personas[0]!),
    ).toBe(true);
  });

  it('a caller cannot act as a persona this vault does not hold a key for', () => {
    // Automation acts UNDER a persona: it must name one whose key the human's vault holds.
    expect(() =>
      fx.node.commit({
        intent: 'signed by nobody',
        owed_to: null,
        due: null,
        persona: 'a'.repeat(64),
        propose: false,
      }),
    ).toThrow();
  });
});
