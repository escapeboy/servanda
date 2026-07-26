import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EmailConnector, FixtureImapClient, message } from '../../src/index.js';

const FIXTURE = resolve(import.meta.dirname, '../../fixtures/mailbox');

const WORK = '2'.repeat(64);
const CLIENT = '3'.repeat(64);
const CTX = { receivedAt: '2026-09-01T00:00:00Z' };
const REF = { ...CTX, referenceTime: '2026-09-01T00:00:00Z' };

const opts = (persona: string) => ({
  persona,
  addresses: ['me@pricex.example', 'capture@pricex.example'],
  sentMailboxes: ['Sent'],
});

/**
 * M-5 — "No org-context mixing in any pipeline."
 *
 * §2 states the connector-side obligation directly: "a connector instance is bound to exactly
 * one persona at registration." This suite pins the *shape* that makes mixing impossible
 * rather than merely discouraged: the persona is a construction-time parameter, so there is no
 * call site at which a caller could ask for someone else's envelope.
 *
 * The mail connector has a second registration-time binding the other connectors do not: the
 * node's own ADDRESSES. Which mailbox you are is exactly as much an org-context fact as which
 * persona you are — a message that could talk the connector into believing it was addressed to
 * someone else would let one persona's mail be read as another's gesture.
 */
describe('M-5: a connector instance is bound to exactly one persona at registration', () => {
  it('takes the persona at construction and exposes it', () => {
    expect(new EmailConnector(opts(WORK)).persona).toBe(WORK);
  });

  it('rejects anything that is not a persona id, at construction', () => {
    for (const bad of ['', 'not-hex', 'A'.repeat(64), '4'.repeat(63), '4'.repeat(65)]) {
      expect(() => new EmailConnector({ persona: bad })).toThrow();
    }
  });

  it('stamps every captured envelope with the bound persona', async () => {
    const envelopes = await new EmailConnector(opts(WORK)).capture(
      new FixtureImapClient(FIXTURE),
      CTX,
    );
    expect(envelopes.length).toBeGreaterThan(0);
    for (const e of envelopes) expect(e.persona).toBe(WORK);
  });

  it('stamps every archaeology and gesture envelope with the bound persona', async () => {
    const connector = new EmailConnector(opts(CLIENT));
    const client = new FixtureImapClient(FIXTURE);
    const archaeology = await connector.sentArchaeology(client, REF);
    const gesture = connector.fromDelivered((await client.fetchAll('INBOX'))[2]!, CTX);
    expect(archaeology.length).toBeGreaterThan(0);
    expect(gesture.length).toBe(1);
    for (const e of [...archaeology, ...gesture]) expect(e.persona).toBe(CLIENT);
  });

  it('ignores a persona asserted by the message itself', () => {
    const forged = message(
      'INBOX',
      1,
      `Message-ID: <x@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\nFrom: a@e.example\nX-Persona: ${WORK}\n\npersona: ${WORK}\n`,
    );
    const [e] = new EmailConnector(opts(CLIENT)).fromMessage(forged, CTX);
    expect(e?.persona).toBe(CLIENT);
  });

  it('gives two personas disjoint envelope sets over the identical mailbox state', async () => {
    const work = await new EmailConnector(opts(WORK)).capture(new FixtureImapClient(FIXTURE), CTX);
    const client = await new EmailConnector(opts(CLIENT)).capture(
      new FixtureImapClient(FIXTURE),
      CTX,
    );

    // Same messages, but no envelope id is shared: nothing downstream can merge the two sets by
    // identity and silently produce a mixed-context pipeline.
    expect(work.map((e) => e.kind)).toEqual(client.map((e) => e.kind));
    const shared = new Set(work.map((e) => e.id)).intersection(new Set(client.map((e) => e.id)));
    expect([...shared]).toEqual([]);
  });

  it('offers no API that accepts a persona per call', () => {
    const connector = new EmailConnector(opts(WORK));
    // The connector's whole public surface: no method has a persona parameter.
    expect(connector.fromMessage.length).toBe(2);
    expect(connector.capture.length).toBe(2);
    expect(connector.sentArchaeology.length).toBe(2);
    expect(connector.fromDelivered.length).toBe(2);
    expect(connector.fromRawDelivered.length).toBe(2);
  });

  it('binds the node addresses at construction too, so a message cannot claim to be the node', () => {
    const connector = new EmailConnector(opts(WORK));
    expect(connector.identity.addresses).toEqual(['capture@pricex.example', 'me@pricex.example']);

    // A message that asserts it was delivered to an address the connector was NOT registered
    // with is not a gesture for this node, whatever it says.
    const claim = message(
      'INBOX',
      2,
      'Message-ID: <c@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\n' +
        'Delivered-To: someone-else@other.example\nFrom: a@e.example\nTo: b@e.example\n\nhi\n',
    );
    expect(connector.fromDelivered(claim, CTX)).toEqual([]);
  });
});
