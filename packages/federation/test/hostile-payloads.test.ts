import { afterAll, describe, expect, it } from 'vitest';
import type { WireMessageType } from '@servanda/types';
import { signMessage } from '../src/messages.js';
import { makeSolo, persona } from './support/fixture.js';

/**
 * §6.2 gives `payload` no shape (`z.unknown()`), so every payload arriving over a transport is
 * attacker-chosen bytes. `propose` and `assert` parsed theirs; the four §6.4/§6.6 types cast
 * theirs and read fields off the result.
 *
 * A cast is not a check. The cheapest hostile message in the protocol — a correctly signed
 * `recon_response` with an empty object for a payload — threw out of `Inbox.ingest`, so it did
 * not merely fail: it took every message behind it in the same delivery with it. A signed
 * one-liner that discards a peer's whole inbox batch is a denial of service any persona that
 * can reach you can send, and §6.7 leans on delivery working ("delivery is optimization") in a
 * way that a caller catching an exception around ingestion would not restore.
 *
 * The rule these pin: a message this layer cannot parse is DISCARDED, individually, with the
 * `malformed-payload` reason that already existed for `propose` and `assert` — never thrown on,
 * and never counted as accepted.
 */

const ME = persona(0);
const THEM = persona(1);

const solo = makeSolo(0);
afterAll(() => solo.cleanup());

function from(type: WireMessageType, payload: unknown) {
  return signMessage(type, payload, THEM.personaId, ME.personaId, '2026-07-25T09:00:00.000Z', THEM.privateKey);
}

const malformed = (type: WireMessageType) => ({ type, edge_id: null, reason: 'malformed-payload' });

describe('a signed message with a shapeless payload is discarded, not thrown on', () => {
  it('recon_response with no `edges`', () => {
    const result = solo.inbox.ingest([from('recon_response', {})]);
    expect(result.recon.accepted).toHaveLength(0);
    expect(result.discarded).toContainEqual(malformed('recon_response'));
  });

  it('recon_request whose `edges` is not a list never reaches the responder', () => {
    const result = solo.inbox.ingest([from('recon_request', { edges: 'all of them' })]);
    expect(result.reconRequests).toHaveLength(0);
    expect(result.discarded).toContainEqual(malformed('recon_request'));
  });

  it('recover_request with no `proof` never reaches the responder', () => {
    const result = solo.inbox.ingest([from('recover_request', { persona: THEM.personaId })]);
    expect(result.recoverRequests).toHaveLength(0);
    expect(result.discarded).toContainEqual(malformed('recover_request'));
  });

  it('recover_response with no `edges` is discarded rather than reported accepted', () => {
    const result = solo.inbox.ingest([from('recover_response', { edges: null })]);
    expect(result.accepted).toHaveLength(0);
    expect(result.discarded).toContainEqual(malformed('recover_response'));
  });

  it('an edge ref that is not an edge id is refused (a payload is not a path)', () => {
    const result = solo.inbox.ingest([
      from('recon_request', { edges: [{ edge_id: '../../etc', latest_assertion_hash: '0'.repeat(64) }] }),
    ]);
    expect(result.reconRequests).toHaveLength(0);
    expect(result.discarded).toContainEqual(malformed('recon_request'));
  });

  it('one malformed message does not swallow the rest of the delivery', () => {
    const result = solo.inbox.ingest([
      from('recon_response', {}),
      from('recover_request', {}),
      from('publish', { edge_id: 'a'.repeat(64) }),
    ]);
    expect(result.accepted.map((a) => a.type)).toEqual(['publish']);
    expect(result.discarded).toHaveLength(2);
  });
});
