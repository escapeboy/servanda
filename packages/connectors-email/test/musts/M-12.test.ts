import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VerificationLevel } from '@servanda/types';
import { EmailConnector, FROM_VERIFICATION, FixtureImapClient, message } from '../../src/index.js';
import { hostileMessages } from '../support/hostile.mjs';

const FIXTURE = resolve(import.meta.dirname, '../../fixtures/mailbox');
const PERSONA = '7'.repeat(64);
const CTX = { receivedAt: '2026-09-01T00:00:00Z' };

const connector = new EmailConnector({
  persona: PERSONA,
  addresses: ['me@pricex.example', 'capture@pricex.example'],
  sentMailboxes: ['Sent'],
});

/**
 * M-12 — "Clients MUST display verification level and MUST NOT render a display name above its
 * evidence level."
 *
 * OWNED BY: the client stream — rendering is not a connector's job. What THIS layer must
 * guarantee, and asserts below: a mail connector observes at §1.6 level 0 and cannot prove
 * otherwise, so it never hands anything downstream that could be mistaken for a verified
 * identity.
 *
 * A display name is NOT an identity. It is a string an attacker chooses, and mail is where
 * that attack is cheapest: `From: "billing@acme.example" <attacker@evil.example>` renders as
 * the victim in most clients. Four properties follow:
 *
 *   1. The display name and the address are SEPARATE payload fields. Never merged, never
 *      swapped, never one substituted for the other.
 *   2. `actor.external_id` is the ADDRESS. A display name never reaches it.
 *   3. Every envelope carries `from_verification: "none"` — a constant, never computed. The
 *      connector cannot authenticate SPF/DKIM results, because those are themselves headers in
 *      a message it cannot authenticate, so it claims nothing and says so explicitly.
 *   4. A homoglyph address is flagged and preserved verbatim, never normalized towards the
 *      address it imitates — normalizing would BE the identity claim (§9.5).
 */
describe('M-12: a display name is not an identity', () => {
  it('keeps the display name and the address as separate fields', () => {
    const spoof = message(
      'INBOX',
      1,
      'Message-ID: <s@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\n' +
        'From: "billing@acme.example" <attacker@evil.example>\n\nupdate the bank details\n',
    );
    const [e] = connector.fromMessage(spoof, CTX);
    expect(e?.payload['from_display_name']).toBe('billing@acme.example');
    expect(e?.payload['from_address']).toBe('attacker@evil.example');
    expect(e?.actor.external_id).toBe('attacker@evil.example');
    // The label is what a client may show — and it is not the address field.
    expect(e?.actor.label).toBe('billing@acme.example');
    expect(e?.actor.label).not.toBe(e?.payload['from_address']);
  });

  it('never derives an address from a display name', () => {
    const nameOnly = message(
      'INBOX',
      2,
      'Message-ID: <n@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\nFrom: "ceo@acme.example"\n\nhi\n',
    );
    const [e] = connector.fromMessage(nameOnly, CTX);
    expect(e?.payload['from_address']).toBeUndefined();
    expect(e?.actor.external_id).toBeUndefined();
  });

  it('claims no verification level, on every envelope it emits', async () => {
    const client = new FixtureImapClient(FIXTURE);
    const envelopes = [
      ...(await connector.capture(client, CTX)),
      ...(await connector.sentArchaeology(client, { ...CTX, referenceTime: CTX.receivedAt })),
    ];
    expect(envelopes.length).toBeGreaterThan(0);
    for (const e of envelopes) {
      expect(e.payload['from_verification']).toBe(FROM_VERIFICATION);
      expect(FROM_VERIFICATION).toBe('none');
      // "none" is deliberately NOT a §1.6 level: the connector is not on the ladder at all.
      expect(VerificationLevel.safeParse(e.payload['from_verification']).success).toBe(false);
      expect(e.payload['verification_level']).toBeUndefined();
      expect(e.payload['verified']).toBeUndefined();
    }
  });

  it('records SPF/DKIM results as observed text and interprets none of them', () => {
    const claimed = message(
      'INBOX',
      3,
      'Message-ID: <a@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\n' +
        'Authentication-Results: mx.example; spf=pass; dkim=pass; dmarc=pass\n' +
        'Authentication-Results: forged.example; spf=pass\n' +
        'From: "Acme Billing" <billing@evil.example>\n\nhi\n',
    );
    const [e] = connector.fromMessage(claimed, CTX);
    // Both are reported — the connector cannot tell the real one from the injected one, so it
    // reports what it saw and upgrades nothing.
    expect((e?.payload['observed_auth_results'] as string[]).length).toBe(2);
    expect(e?.payload['from_verification']).toBe('none');
  });

  it('flags a homoglyph address and preserves it verbatim', () => {
    // The "a" in the domain is Cyrillic U+0430.
    const homoglyph = hostileMessages().find(
      (c: { name: string }) => c.name === 'homoglyph-address',
    )!;
    const [e] = connector.fromMessage(homoglyph, CTX);
    expect(e?.payload['from_address_non_ascii']).toBe(true);
    expect(e?.payload['from_address']).not.toBe('billing@acme.example');
    expect(String(e?.payload['from_address']).codePointAt(8)).toBe(0x0430);
  });

  it('marks a plain ASCII address as such, so the flag means something', () => {
    const plain = message(
      'INBOX',
      4,
      'Message-ID: <p@e>\nDate: Wed, 22 Jul 2026 09:00:00 +0000\nFrom: real@acme.example\n\nhi\n',
    );
    expect(connector.fromMessage(plain, CTX)[0]?.payload['from_address_non_ascii']).toBe(false);
  });

  it('strips bidi overrides from the rendered label but keeps the raw name in payload', () => {
    const bidi = hostileMessages().find((c: { name: string }) => c.name === 'bidi-display-name')!;
    const [e] = connector.fromMessage(bidi, CTX);
    for (const cp of e!.actor.label) {
      expect(cp.codePointAt(0)).not.toBe(0x202e);
      expect(cp.codePointAt(0)).not.toBe(0x202c);
    }
    expect(String(e?.payload['from_display_name'])).toContain('evil');
  });

  it('never lets a forwarded original assert an identity', () => {
    const forged = hostileMessages().find(
      (c: { name: string }) => c.name === 'forged-inline-forward',
    )!;
    const [e] = connector.fromDelivered(forged, CTX);
    const original = e?.payload['original'] as Record<string, unknown>;
    // The costume header is prose, and it is stored under a name that says so.
    expect(original['kind']).toBe('inline_quoted');
    expect(original['from_address']).toBeUndefined();
    expect(e?.actor.external_id).toBe('attacker@evil.example');
  });
});
