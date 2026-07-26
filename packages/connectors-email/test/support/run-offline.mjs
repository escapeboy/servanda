#!/usr/bin/env node
/**
 * The workload GK/4 runs INSIDE the network trap.
 *
 * Everything the package can do — fixture capture, sent-mail archaeology, the BCC/forward
 * gesture, and the whole hostile corpus — driven end to end. If any of it reaches a network
 * primitive, `deny-network.cjs` throws NETWORK_ACCESS_DENIED and this process dies non-zero.
 *
 * Prints a one-line JSON summary on success so the prover can check the work actually happened
 * rather than that a no-op exited cleanly.
 */
import { resolve } from 'node:path';
import { EmailConnector, FixtureImapClient, MemoryImapClient } from '../../dist/index.js';
import { Envelope } from '@servanda/types';
import { hostileMessages } from './hostile.mjs';

const FIXTURE = resolve(import.meta.dirname, '../../fixtures/mailbox');
const CTX = { receivedAt: '2026-09-01T00:00:00Z' };
const REF = { ...CTX, referenceTime: '2026-09-01T00:00:00Z' };

const connector = new EmailConnector({
  persona: 'a'.repeat(64),
  addresses: ['me@pricex.example', 'capture@pricex.example'],
  sentMailboxes: ['Sent'],
});

const fixtureClient = new FixtureImapClient(FIXTURE);
const capture = await connector.capture(fixtureClient, CTX);
const archaeology = await connector.sentArchaeology(fixtureClient, REF);

const gestures = [];
for (const mailbox of await fixtureClient.listMailboxes()) {
  for (const source of await fixtureClient.fetchAll(mailbox)) {
    gestures.push(...connector.fromDelivered(source, CTX));
  }
}

const cases = hostileMessages();
const hostileClient = new MemoryImapClient({
  INBOX: cases.map((c) => ({ ...c, mailbox: 'INBOX' })),
  Sent: cases.map((c) => ({ ...c, mailbox: 'Sent' })),
});
const hostile = [
  ...(await connector.capture(hostileClient, CTX)),
  ...(await connector.sentArchaeology(hostileClient, REF)),
];

for (const e of [...capture, ...archaeology, ...gestures, ...hostile]) Envelope.parse(e);

process.stdout.write(
  JSON.stringify({
    capture: capture.length,
    archaeology: archaeology.length,
    gestures: gestures.length,
    hostile: hostile.length,
    hostileCases: cases.length,
  }),
);
