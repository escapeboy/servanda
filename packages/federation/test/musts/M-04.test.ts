import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSignature } from '@servanda/crypto';
import { PROTOCOL_VERSION, type Attestation, type Publish } from '@servanda/types';
import { signMessage } from '../../src/messages.js';
import { answerReconRequest, buildReconRequest, latestAssertionHash } from '../../src/recon.js';
import { RecoveryResponder, signChallenge } from '../../src/recovery.js';
import { mayServeEdge } from '../../src/serve.js';
import { makePair, makeSolo, persona, type Pair, type Solo } from '../support/fixture.js';

/**
 * M-4 — "Visibility follows participation (§5.3 a–c). Publishing is an explicit signed act by
 * a party."
 *
 * L1 owns the storage rule (a non-party cannot publish; a persona's records are unreadable
 * outside its subtree). THIS layer owns M-4a on the wire: "a node MUST NOT serve an edge to any
 * persona that is neither a party nor a member of a scope the edge is published in."
 *
 * Serving is where the rule actually bites, because a requester can name any edge_id it likes.
 * Every path that emits edge data — §6.4 recon responses and §6.6 recovery responses — goes
 * through the same `mayServeEdge` decision, and all three sub-rules are asserted:
 *   M-4a serve only to parties or scope members;
 *   M-4b membership alone grants nothing about unpublished edges;
 *   M-4c no inheritance between scopes.
 */

const SCOPE = persona(3); // a team key
const MEMBER = persona(2); // attested into SCOPE, but not a party to the edge
const STRANGER = persona(4); // no attestation, no participation
const OTHER_SCOPE = persona(5);

let pair: Pair;
let edgeId: string;

beforeAll(async () => {
  pair = makePair();
  edgeId = pair.a.node.commit({
    intent: 'run the migration',
    owed_to: pair.b.personaId,
    due: null,
    persona: null,
    propose: true,
  }).edge_id!;
  await pair.a.fed.push();
  await pair.b.fed.pull();
  pair.b.node.confirm({ id: edgeId, decision: 'confirm' });
  await pair.b.fed.push();
  await pair.a.fed.pull();
});
afterAll(() => pair.cleanup());

function attest(org: { personaId: string; privateKey: string }, subject: string): Attestation {
  return withSignature(
    {
      v: PROTOCOL_VERSION,
      type: 'attestation' as const,
      org: org.personaId,
      subject,
      subject_kind: 'persona' as const,
      claims: {},
      issued_at: '2026-07-01T00:00:00Z',
      expires_at: '2027-07-01T00:00:00Z',
    },
    org.privateKey,
  ) as Attestation;
}

function publish(by: { personaId: string; privateKey: string }, scope: string): Publish {
  return withSignature(
    {
      v: PROTOCOL_VERSION,
      type: 'publish' as const,
      edge_id: edgeId,
      scope,
      published_at: '2026-07-25T09:30:00Z',
      by: by.personaId,
    },
    by.privateKey,
  ) as Publish;
}

const edgeOf = (p: Pair['a']) => p.vault.getEdge(p.personaId, edgeId)!;

describe('M-4: a node MUST NOT serve an edge to a non-party, non-scope-member', () => {
  it('a party is served; a stranger is not, even naming the exact edge_id', () => {
    const vault = pair.a.vault;
    expect(mayServeEdge(vault, pair.a.personaId, pair.b.personaId, edgeOf(pair.a))).toEqual({
      serve: true,
      via: 'party',
    });
    expect(mayServeEdge(vault, pair.a.personaId, STRANGER.personaId, edgeOf(pair.a))).toEqual({
      serve: false,
      reason: 'not-a-party-and-not-published-to-a-scope-you-belong-to',
    });
  });

  it('M-4b: scope membership alone grants nothing while the edge is unpublished', () => {
    pair.a.vault.putAttestation(pair.a.personaId, attest(SCOPE, MEMBER.personaId));
    expect(mayServeEdge(pair.a.vault, pair.a.personaId, MEMBER.personaId, edgeOf(pair.a)).serve).toBe(false);
  });

  it('publishing — an explicit signed act by a party — is what opens the scope', () => {
    pair.a.vault.putPublish(pair.a.personaId, publish(persona(0), SCOPE.personaId));
    expect(mayServeEdge(pair.a.vault, pair.a.personaId, MEMBER.personaId, edgeOf(pair.a))).toEqual({
      serve: true,
      via: 'scope',
      scope: SCOPE.personaId,
    });
    // …and only for members of THAT scope.
    expect(mayServeEdge(pair.a.vault, pair.a.personaId, STRANGER.personaId, edgeOf(pair.a)).serve).toBe(false);
  });

  it('M-4c: no inheritance — an attestation from another scope does not open this one', () => {
    const outsider = persona(6);
    pair.a.vault.putAttestation(pair.a.personaId, attest(OTHER_SCOPE, outsider.personaId));
    expect(mayServeEdge(pair.a.vault, pair.a.personaId, outsider.personaId, edgeOf(pair.a)).serve).toBe(false);
  });

  it('§6.4: a recon request from a non-party is answered with nothing', () => {
    // The stranger knows the edge_id and asserts a divergent chain hash — the strongest form of
    // the request. Knowing an id is not being entitled to it.
    const response = answerReconRequest(pair.a.vault, pair.a.personaId, STRANGER.personaId, {
      edges: [{ edge_id: edgeId, latest_assertion_hash: '0'.repeat(64) }],
    });
    expect(response.edges).toEqual([]);
  });

  it('§6.4: the same request from the counterparty is answered', () => {
    const response = answerReconRequest(pair.a.vault, pair.a.personaId, pair.b.personaId, {
      edges: [{ edge_id: edgeId, latest_assertion_hash: '0'.repeat(64) }],
    });
    expect(response.edges.map((e) => e.edge_id)).toEqual([edgeId]);
    // Positive control on convergence: with a matching hash there is nothing to send.
    const converged = answerReconRequest(pair.a.vault, pair.a.personaId, pair.b.personaId, {
      edges: [
        {
          edge_id: edgeId,
          latest_assertion_hash: latestAssertionHash(pair.a.vault.getAssertions(pair.a.personaId, edgeId)),
        },
      ],
    });
    expect(converged.edges).toEqual([]);
  });

  it('§6.6: a verified stranger recovers nothing — recovery restores participation, not access', () => {
    const responder = new RecoveryResponder({ vault: pair.a.vault, persona: pair.a.personaId });
    const challenge = responder.issueChallenge();
    const { verdict, response } = responder.answer({
      persona: STRANGER.personaId,
      proof: signChallenge(challenge, STRANGER.privateKey),
    });
    expect(verdict.verified).toBe(true); // they really are who they say they are…
    expect(response.edges).toEqual([]); // …which entitles them to nothing here.
  });

  it('a propose addressed to someone else is not stored, whoever delivered it', () => {
    const solo: Solo = makeSolo(2);
    try {
      const edge = edgeOf(pair.a);
      const assertion = pair.a.vault.getAssertions(pair.a.personaId, edgeId)[0]!;
      const result = solo.inbox.ingest([
        signMessage(
          'propose',
          { edge, assertion },
          pair.a.personaId,
          '2026-07-25T12:00:00Z',
          pair.a.privateKey,
        ),
      ]);
      expect(result.discarded).toEqual([
        { type: 'propose', edge_id: edgeId, reason: 'not-addressed-to-this-persona' },
      ]);
      expect(solo.vault.getEdge(solo.personaId, edgeId)).toBeNull();
    } finally {
      solo.cleanup();
    }
  });

  it('buildReconRequest never names an edge the counterparty is not a party to', () => {
    // A stranger asked about produces an empty request: there is nothing shared to reconcile.
    expect(buildReconRequest(pair.a.vault, pair.a.personaId, STRANGER.personaId).edges).toEqual([]);
    expect(buildReconRequest(pair.a.vault, pair.a.personaId, pair.b.personaId).edges.map((e) => e.edge_id)).toEqual([
      edgeId,
    ]);
  });
});
