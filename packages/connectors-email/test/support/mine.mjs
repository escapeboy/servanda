#!/usr/bin/env node
/**
 * The deterministic runner GK/1 uses.
 *
 * Two separate processes run this against the same fixture mailbox; their stdout must be
 * byte-identical, ids and ordering included. Everything the connector could read a clock for
 * is passed in as a constant here, which is the point: if any of it leaked back into the
 * envelope path, the two runs would differ.
 *
 *   node packages/connectors-email/test/support/mine.mjs [fixtureDir]
 */
import { resolve } from 'node:path';
import { EmailConnector, FixtureImapClient } from '../../dist/index.js';

const HERE = resolve(import.meta.dirname);
const FIXTURE = process.argv[2] ?? resolve(HERE, '../../fixtures/mailbox');

const PERSONA = 'a'.repeat(64);
const RECEIVED_AT = '2026-09-01T00:00:00Z';
const REFERENCE_TIME = '2026-09-01T00:00:00Z';

const connector = new EmailConnector({
  persona: PERSONA,
  addresses: ['me@pricex.example', 'capture@pricex.example'],
  sentMailboxes: ['Sent'],
});
const client = new FixtureImapClient(FIXTURE);

const capture = await connector.capture(client, { receivedAt: RECEIVED_AT });
const archaeology = await connector.sentArchaeology(client, {
  receivedAt: RECEIVED_AT,
  referenceTime: REFERENCE_TIME,
});

// The gesture path, over the two messages the fixture delivers to the node's own address.
const gestures = [];
for (const mailbox of await client.listMailboxes()) {
  for (const source of await client.fetchAll(mailbox)) {
    gestures.push(...connector.fromDelivered(source, { receivedAt: RECEIVED_AT }));
  }
}

process.stdout.write(JSON.stringify({ capture, archaeology, gestures }));
