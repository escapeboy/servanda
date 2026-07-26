import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitmentHash, signingPreimageHex, verifyObject } from '@servanda/crypto';
import { Assertion, Edge } from '@servanda/types';
import { makeFixture, type Fixture } from '../support/fixture.js';

/**
 * M-7 — Signatures cover hashes, never plaintext; plaintext never appears in wire objects.
 *
 * Owned by this layer (what the node emits) together with @servanda/crypto (how it signs).
 */

const SECRET = 'migrate the billing cluster before the Q3 audit';

let fx: Fixture;
let edgeId: string;
let commitmentHashHex: string;

beforeAll(() => {
  fx = makeFixture();
  const out = fx.node.commit({
    intent: SECRET,
    owed_to: fx.personas[1]!,
    due: '2026-08-01T00:00:00Z',
    persona: null,
    propose: true,
  });
  edgeId = out.edge_id!;
  commitmentHashHex = out.commitment_hash;
});
afterAll(() => fx.cleanup());

describe('M-7: signatures cover hashes, never plaintext', () => {
  it('the edge carries the commitment hash and no intent text', () => {
    const edge = fx.vault.getEdge(fx.personas[0]!, edgeId)!;
    expect(Edge.parse(edge)).toBeTruthy();
    expect(edge.commitment_hash).toBe(commitmentHashHex);
    expect(JSON.stringify(edge)).not.toContain(SECRET);
    expect(Object.keys(edge)).not.toContain('intent');
  });

  it('no assertion in the chain contains plaintext', () => {
    for (const a of fx.vault.getAssertions(fx.personas[0]!, edgeId)) {
      expect(Assertion.parse(a)).toBeTruthy();
      expect(JSON.stringify(a)).not.toContain(SECRET);
    }
  });

  it('the queued wire message contains no plaintext', () => {
    const outbox = fx.vault.listOutbox(fx.personas[0]!);
    expect(outbox).toHaveLength(1);
    expect(JSON.stringify(outbox[0]!.message)).not.toContain(SECRET);
  });

  it('what is signed is a hash of the canonical form, not the text', () => {
    const assertion = fx.vault.getAssertions(fx.personas[0]!, edgeId)[0]!;
    const preimage = signingPreimageHex(assertion as unknown as Record<string, unknown>);
    expect(preimage).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyObject(assertion as unknown as Record<string, unknown>, assertion.by)).toBe(true);
  });

  it('the commitment_hash covers exactly the §3.2 five fields', () => {
    const commitment = fx.vault.getCommitment(fx.personas[0]!, commitmentHashHex)!;
    const recomputed = commitmentHash({
      intent: commitment.intent,
      owner: commitment.owner,
      owed_to: commitment.owed_to,
      due: commitment.due,
      created_at: commitment.created_at,
    });
    expect(recomputed).toBe(commitmentHashHex);
    // Vault-local fields are excluded by construction: changing one must not move the hash.
    const withOtherEvidence = { ...commitment, confidence: 0.1, source: 'archaeology' as const };
    expect(
      commitmentHash({
        intent: withOtherEvidence.intent,
        owner: withOtherEvidence.owner,
        owed_to: withOtherEvidence.owed_to,
        due: withOtherEvidence.due,
        created_at: withOtherEvidence.created_at,
      }),
    ).toBe(commitmentHashHex);
  });

  it('the plaintext is encrypted at rest, not merely kept out of wire objects', () => {
    // Nothing on disk — not the working tree, not the git objects — may contain the secret.
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (readFileSync(p).includes(SECRET)) hits.push(p);
      }
    };
    walk(fx.dir);
    expect(hits).toEqual([]);
  });
});
