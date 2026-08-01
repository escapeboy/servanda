import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSignature } from '@servanda/crypto';
import { PROTOCOL_VERSION, type Attestation, type Publish } from '@servanda/types';
import { signMessage, verifyMessage } from '../../src/messages.js';
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
          pair.b.personaId,
          '2026-07-25T12:00:00Z',
          pair.a.privateKey,
        ),
      ]);
      expect(result.discarded).toEqual([
        // `addressed-to-another-persona`, not `not-addressed-to-this-persona`: §6.2's envelope
        // check now fires BEFORE the payload is examined, so a re-sealed message is refused
        // without the node ever reading whose edge it is about. M-4a's payload rule still
        // stands behind it for the case where recipient and `owed_to` disagree.
        { type: 'propose', edge_id: edgeId, reason: 'addressed-to-another-persona' },
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

/**
 * §6.2 — a signature binds who a message was FOR, not only who wrote it.
 *
 * Filed upstream as #31 and resolved there. Before it, the courier authenticated nobody (that is
 * §6.3 working as intended) and the signature named only its author, so any recipient could take
 * a validly-signed message and re-seal it to a third party, where it verified unchanged. What
 * stopped harm was a party check inside each message type — a rule every new type has to remember
 * to re-derive, and the two request types did not have one at all.
 */
describe('§6.2: a re-sealed message is refused, whatever its type', () => {
  it('a message signed for one persona is discarded by another', () => {
    const solo = makeSolo(2);
    const pair = makePair();
    const forThirdParty = signMessage(
      'recon_request',
      { edges: [] },
      pair.a.personaId,
      pair.b.personaId,
      '2026-07-25T12:00:00Z',
      pair.a.privateKey,
    );

    // The signature is perfectly good — this is not a forgery, it is a forward.
    expect(verifyMessage(forThirdParty)).not.toBeNull();

    const result = solo.inbox.ingest([forThirdParty]);
    expect(result.discarded).toEqual([
      { type: 'recon_request', edge_id: null, reason: 'addressed-to-another-persona' },
    ]);
    // And the payload never reached the handler: no request was surfaced to answer.
    expect(result.reconRequests).toEqual([]);

    solo.cleanup();
    pair.cleanup();
  });

  it('`recon_request` had no party check of its own — which is the point', () => {
    // The type that made this worth fixing at the envelope. `propose` is bound by `edge.owed_to`
    // and `assert` by party membership; a request carries neither, so before §6.2 gained
    // `recipient` its only protection was the responder filtering what it answered with.
    const solo = makeSolo(2);
    const pair = makePair();
    const addressed = signMessage(
      'recon_request',
      { edges: [] },
      pair.a.personaId,
      solo.personaId,
      '2026-07-25T12:00:00Z',
      pair.a.privateKey,
    );
    const result = solo.inbox.ingest([addressed]);
    expect(result.discarded).toEqual([]);
    expect(result.reconRequests).toEqual([{ from: pair.a.personaId, request: { edges: [] } }]);

    solo.cleanup();
    pair.cleanup();
  });
});
