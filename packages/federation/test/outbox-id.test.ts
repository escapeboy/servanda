import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@servanda/types';
import { makeSolo } from './support/fixture.js';

/**
 * §6.2's binding, enforced by the store rather than maintained by the one producer that happened
 * to maintain it.
 *
 * `queuePropose` sets `id = hashCanonical(message)`, so the property was true — and true only
 * because nothing else wrote here. Two records carrying the same message under different ids are
 * two entries in `listOutbox`, which `push` reads as two messages and hands to a courier twice.
 * `putEdge` has had this backstop since §4.1; the outbox did not, and its own test relied on the
 * gap to control filename order.
 */
describe('an outbox id must digest the message it carries', () => {
  it('refuses an id that binds nothing', () => {
    const solo = makeSolo(0);
    expect(() =>
      solo.vault.putOutbox({
        v: PROTOCOL_VERSION,
        type: 'outbox_item',
        id: 'd'.repeat(64),
        persona: solo.personaId,
        recipient: 'b'.repeat(64),
        message: { v: PROTOCOL_VERSION, type: 'propose' } as unknown as Record<string, unknown>,
        queued_at: new Date(0).toISOString(),
      }),
    ).toThrow(/not the digest/u);
    solo.cleanup();
  });
});
