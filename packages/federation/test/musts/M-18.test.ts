import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { canonicalize } from '@servanda/crypto';
import type { WireMessage } from '@servanda/types';
import {
  bootstrapUrl,
  decodeBootstrap,
  encodeBootstrap,
  payloadFromUrl,
  renderBootstrap,
} from '../../src/index.js';

/**
 * M-18 — a courtesy renderer holds no keys. It verifies and presents; the human confirms from a
 * node that holds keys.
 *
 * The renderer is the one place in §6 where a party to neither side of a promise handles it, and
 * it exists precisely for people who have no node yet — the least defended participant in the
 * protocol meeting an unsolicited link. Everything M-18 forbids follows from that: it cannot
 * sign, it cannot keep what it read, and it cannot lend its own trustworthy-looking origin to a
 * payload it merely decoded.
 *
 * The two `oob-bootstrap.json` cases carry a `signature_verifies` flag, and the second one is the
 * whole rule: a payload that decodes cleanly and does NOT verify. Base64url and JSON say nothing
 * about authenticity.
 */
const VECTORS = 'vendor/vectors/addressing/oob-bootstrap.json';

interface Case {
  name: string;
  sender: { label: string; persona_id: string };
  message: Record<string, unknown>;
  canonical: string;
  payload_b64url: string;
  url: string;
  decoded_equals_original: boolean;
  edge_equals_original: boolean;
  signature_verifies: boolean;
}

let cases: Case[];

beforeAll(() => {
  cases = (JSON.parse(readFileSync(VECTORS, 'utf8')) as { cases: Case[] }).cases;
});

describe('M-18: the payload is self-contained, and the renderer only verifies it', () => {
  it('replays every case the oracle states', () => {
    expect(cases).toHaveLength(2);
  });

  it('encodes to the exact payload the oracle names', () => {
    // Not "some base64 that round-trips" — the same bytes, so a link made by one implementation
    // opens in another. That is the whole point of an out-of-band channel.
    for (const c of cases) {
      expect(canonicalize(c.message), c.name).toBe(c.canonical);
      expect(encodeBootstrap(c.message as unknown as WireMessage), c.name).toBe(c.payload_b64url);
      expect(bootstrapUrl(c.message as unknown as WireMessage, c.url.split('#')[0]!), c.name).toBe(c.url);
    }
  });

  it('round-trips: what comes out of the link is what went in', () => {
    for (const c of cases) {
      const payload = payloadFromUrl(c.url)!;
      expect(payload, c.name).toBe(c.payload_b64url);
      expect(decodeBootstrap(payload), c.name).toEqual(c.message);
    }
  });

  it('presents exactly the payloads that verify, and refuses the one that does not', () => {
    for (const c of cases) {
      const rendering = renderBootstrap(c.payload_b64url);
      expect(rendering.presentable, c.name).toBe(c.signature_verifies);
    }
  });

  it('a tampered payload decodes cleanly and is still refused', () => {
    // The distinction M-18 exists for. Decoding succeeding proves nothing; the oracle's second
    // case is a real proposal with `owed_to` swapped and the original signature kept.
    const tampered = cases.find((c) => !c.signature_verifies)!;
    expect(decodeBootstrap(tampered.payload_b64url)).not.toBeNull();

    const rendering = renderBootstrap(tampered.payload_b64url);
    expect(rendering.presentable).toBe(false);
    expect(rendering).toEqual({ presentable: false, refusal: 'signature-does-not-verify' });
  });

  it('refuses rather than presenting with a caveat — there is no third shape', () => {
    // §6.7: a renderer "MUST NOT present an unverified payload with a caveat instead of refusing".
    // Asserted structurally: a refusal carries no edge, no assertion, no sender. There is nothing
    // in it for a caller to paint next to a warning, even a careless one.
    const tampered = cases.find((c) => !c.signature_verifies)!;
    const rendering = renderBootstrap(tampered.payload_b64url) as Record<string, unknown>;
    for (const leak of ['edge', 'assertion', 'signed_by', 'payload', 'message']) {
      expect(rendering[leak], `a refusal must not carry ${leak}`).toBeUndefined();
    }
    expect(Object.keys(rendering).sort()).toEqual(['presentable', 'refusal']);
  });

  it('establishes who signed, and volunteers nothing beyond that', () => {
    // "Origin is not evidence." What the renderer learned is that a key signed these bytes. It
    // does not know who holds that key, whether they are who the recipient has in mind, or
    // whether its own operator vouches for any of it — so it says none of those things, and
    // carries no wording at all for a client to render (M-21).
    const good = cases.find((c) => c.signature_verifies)!;
    const rendering = renderBootstrap(good.payload_b64url);
    expect(rendering.presentable).toBe(true);
    if (!rendering.presentable) return;

    expect(rendering.signed_by).toBe(good.sender.persona_id);
    expect(Object.keys(rendering).sort()).toEqual(['assertion', 'edge', 'presentable', 'signed_by']);
    expect(JSON.stringify(rendering)).not.toMatch(/verified by|trusted|secure|official/iu);
  });

  it('keeps nothing between renders', () => {
    // "MUST NOT cache payload content, MUST NOT log payload content, MUST NOT persist a decoded
    // payload beyond the request." Satisfied by having nowhere to persist to: rendering the same
    // payload twice, with a refusal in between, gives byte-identical results and no accumulation.
    const good = cases.find((c) => c.signature_verifies)!;
    const bad = cases.find((c) => !c.signature_verifies)!;
    const first = renderBootstrap(good.payload_b64url);
    renderBootstrap(bad.payload_b64url);
    expect(renderBootstrap(good.payload_b64url)).toEqual(first);
  });

  it('names why it refused, so a broken link and an attack look different', () => {
    expect(renderBootstrap('not base64url!!').refusal).toBe('not-base64url-json');
    expect(renderBootstrap(encodeBootstrap({ hello: 'world' } as never)).refusal).toBe('not-a-signed-message');
  });
});

describe('M-18: the renderer cannot sign, structurally', () => {
  it('imports no signing primitive and touches no private key', () => {
    // The behavioural tests above show it does not sign. This shows it CANNOT: a renderer that
    // held a key would be a party able to manufacture confirmations for people who have no node
    // — the exact concentration §6.7 built the courtesy renderer to avoid. Gate GF scans the
    // shipped module for the same reason; this catches it before the gate does.
    const source = readFileSync('packages/federation/src/bootstrap.ts', 'utf8');
    for (const forbidden of [/\bsignObject\b/u, /\bwithSignature\b/u, /\bprivateKey\b/u, /\bsignMessage\b/u]) {
      expect(source, `bootstrap.ts must not reference ${forbidden}`).not.toMatch(forbidden);
    }
    // A scanner that cannot fire proves nothing.
    expect('const x = withSignature(o, k)').toMatch(/\bwithSignature\b/u);
  });
});
