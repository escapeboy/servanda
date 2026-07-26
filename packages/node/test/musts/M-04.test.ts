import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSignature } from '@servanda/crypto';
import { PROTOCOL_VERSION, type Publish } from '@servanda/types';
import { ScopeViolation } from '@servanda/vault';
import { makeFixture, persona, syncEdge, type Fixture } from '../support/fixture.js';

/**
 * M-4 — Visibility follows participation (§5.3 a–c). Publishing is an explicit signed act by
 * a party.
 *
 * Owned jointly: the vault owns the storage rule (only a party may publish; nothing is
 * readable outside its persona subtree), Stream B's transports own serving edges to peers
 * (M-4a on the wire). Asserted here: what THIS layer guarantees.
 */

let fx: Fixture;
let edgeId: string;

beforeAll(() => {
  fx = makeFixture();
  edgeId = fx.node.commit({
    intent: 'publish the retrospective',
    owed_to: fx.personas[1]!,
    due: null,
    persona: null,
    propose: true,
  }).edge_id!;
  syncEdge(fx, 0, 1, edgeId);
});
afterAll(() => fx.cleanup());

function signedPublish(byIndexKey: { personaId: string; privateKey: string }, scope: string): Publish {
  return withSignature(
    {
      v: PROTOCOL_VERSION,
      type: 'publish' as const,
      edge_id: edgeId,
      scope,
      published_at: '2026-07-25T12:00:00Z',
      by: byIndexKey.personaId,
    },
    byIndexKey.privateKey,
  ) as Publish;
}

describe('M-4: visibility follows participation; publishing is an explicit signed act', () => {
  it('accepts a publish signed by a party to the edge', () => {
    const scope = persona(100).personaId;
    fx.vault.putPublish(fx.personas[0]!, signedPublish(persona(0), scope));
    const records = fx.vault.listPublishRecords(fx.personas[0]!);
    expect(records.map((r) => r.edge_id)).toContain(edgeId);
    // §5.2: publishing is a signed act, not a flag.
    expect(records[0]?.sig).toMatch(/^[0-9a-f]{128}$/);
  });

  it('refuses a publish signed by a non-party (§5.2)', () => {
    const outsider = persona(2);
    expect(() =>
      fx.vault.putPublish(fx.personas[0]!, signedPublish(outsider, persona(100).personaId)),
    ).toThrow(ScopeViolation);
  });

  it('publishing shares the edge and its chain, never the commitment plaintext', () => {
    // §5.2: "Publishing shares the edge object + assertion chain (hashes and states) — never
    // commitment plaintext." The publish record itself carries only an edge_id and a scope.
    const record = fx.vault.listPublishRecords(fx.personas[0]!)[0]!;
    const commitment = fx.vault.getCommitment(fx.personas[0]!, fx.vault.getEdge(fx.personas[0]!, edgeId)!.commitment_hash)!;
    expect(JSON.stringify(record)).not.toContain(commitment.intent);
  });

  it('M-4b: holding a persona handle grants nothing about another persona’s records', () => {
    // Membership (here: being in the same vault) grants no visibility into unpublished
    // records of another persona. The read is scoped, not filtered.
    const [{ hash }] = fx.vault.listCommitments(fx.personas[0]!);
    expect(fx.vault.getCommitment(fx.personas[1]!, hash!)).toBeNull();
  });

  it('M-4c: a persona this vault does not hold cannot be read at all', () => {
    expect(() => fx.vault.listCommitments(persona(7).personaId)).toThrow(ScopeViolation);
  });
});
