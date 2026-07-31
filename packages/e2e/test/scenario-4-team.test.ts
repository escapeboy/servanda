import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitmentHash, edgeId, hashCanonical, withSignature } from '@servanda/crypto';
import { GithubConnector } from '@servanda/connectors-github';
import {
  confirmProposal,
  createScriptedModelClient,
  Extractor,
  isProposable,
  PROPOSABLE_AFTER_CONFIRMATION,
  type ConfirmedProposal,
  type Routed,
} from '@servanda/extraction';
import { FederatedNode, GitTransport, signMessage } from '@servanda/federation';
import { M2Violation, verifyAssertionChain } from '@servanda/node';
import { Publish, type Assertion, type Edge, type Envelope } from '@servanda/types';
import { ScopeViolation } from '@servanda/vault';
import {
  freshInstall,
  ivo,
  mila,
  signAssertion,
  stefan,
  studioGroup,
  type Install,
} from './support.js';

/**
 * SCENARIO 4 — "Team: the forgotten promise nobody had to send a reminder about" (§4).
 *
 * Mila tells Stefan in a PR review that she will pull staging data by Wednesday. Nobody types it
 * anywhere. Thursday she has forgotten, and the system's entire social contribution is that the
 * reminder lands on *her* desk rather than in a channel where six people can watch it. Friday an
 * incident takes her out and the promise moves to Ivo without anybody losing the history.
 *
 * Three vaults, three nodes, one shared git repository, and no network. Every date comes from an
 * injected clock and every state change is a signature that the §4.3 transition table accepted.
 *
 * GAPS this test does not paper over (reported, and none of them is stubbed green below):
 *   1. §7's `act` now signs `done` and `release`, so `closed` and `released` ARE reachable
 *      through the surface. `disputed`, `superseded` and `expired` are not: no tool expresses
 *      them, and `supersede`/`delegate` are advertised bound to nothing (M-20). Those assertions
 *      here are signed directly and fed through `verifyAssertionChain` — the table remains the
 *      authority, but a conforming *client* could not yet supersede what Mila and Ivo supersede
 *      below.
 *   2. Closed by M-20/M-21. `brief()` used to offer an edge's owner `{tool:'confirm'}` labelled
 *      "Mark done" — an action that throws `M2Violation`, because `confirm` on an edge is the
 *      counterparty's acceptance and an owner may never sign it. The owner is now offered
 *      `{act:'done', tool:'act'}`, which signs. The M-2 assertion below survives on its own
 *      terms: it tests that a direct owner `confirm` is refused, not that a brief offered it.
 *   3. There is no path from a confirmed extraction to a proposed edge. `confirm` files a
 *      vault-local commitment; `commit(propose:true)` builds its own commitment with its own
 *      `created_at`, hence its own `commitment_hash`. Mila's one tap therefore reaches the wire
 *      through `commit`, and the extracted candidate's hash is not the hash on the edge.
 */

const PR_AT = '2026-02-02T10:15:00Z';
const DUE = '2026-02-04T17:00:00Z';
const INTENT = 'pull staging data for the repro';
const SPRINT_TASK = 'SPRINT-114';

/** Thursday, Friday, Monday, and the day the P5D acceptance window runs out. */
const THURSDAY = '2026-02-05T09:00:00Z';
const FRIDAY = '2026-02-06T11:00:00Z';
const MONDAY = '2026-02-09T09:30:00Z';
const TOO_EARLY = '2026-02-13T09:30:00Z';
const WINDOW_ELAPSED = '2026-02-14T09:31:00Z';

describe('scenario 4 — team: the promise nobody had to chase', () => {
  let milaSide: Install;
  let stefanSide: Install;
  let ivoSide: Install;
  let milaFed: FederatedNode;
  let stefanFed: FederatedNode;
  let ivoFed: FederatedNode;
  let ivoTransport: GitTransport;

  let envelope: Envelope;
  let routed: Routed;
  let outboxBeforeTap: unknown[];
  let tap: ConfirmedProposal;
  let oldEdgeId: string;

  let stefanSawProposal: string[];
  let stefanChainAfterProposal: Assertion[];
  let milaOwnConfirmAttempt: unknown;
  /** Both sides' view of the old edge at the moment Stefan signed — not at the end of the story. */
  let openBothSides: { signers: number; state: string }[];

  let publish: Publish;
  let nonPartyPublishRefused: unknown;

  let thursdayEscalatable: string[];
  let milaThursdaySlot: { headline: string; act: string | null } | null;
  let stefanThursdaySlot: { headline: string; act: string | null } | null;

  let doubleSupersedeOutcome: string | undefined;
  let stateAfterOneSupersede: string;
  let stateAfterBothSupersedes: string;
  let newEdge: Edge;
  let delegationSigners: string[];

  let earlyTacitOutcome: string | undefined;
  let stateAfterEvidence: string;
  let finalStateMila: string;
  let finalStateStefan: string;
  let oldChainAfterEverything: Assertion[];

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'servanda-s4-'));
    milaSide = await freshInstall(PR_AT, mila);
    stefanSide = await freshInstall(PR_AT, stefan);
    ivoSide = await freshInstall(PR_AT, ivo);

    // §6.1 git transport: three clones of one bare repository. A local path is a first-class
    // case — nothing here opens a socket.
    const shared = GitTransport.initShared(join(root, 'shared.git'));
    const transportFor = (dir: string, persona: string): GitTransport =>
      GitTransport.init({ dir: join(root, dir), persona, remote: shared });
    const milaTransport = transportFor('mila', mila.personaId);
    const stefanTransport = transportFor('stefan', stefan.personaId);
    ivoTransport = transportFor('ivo', ivo.personaId);

    milaFed = new FederatedNode({
      vault: milaSide.vault,
      persona: mila.personaId,
      transport: milaTransport,
      now: milaSide.clock.now,
    });
    stefanFed = new FederatedNode({
      vault: stefanSide.vault,
      persona: stefan.personaId,
      transport: stefanTransport,
      now: stefanSide.clock.now,
    });
    ivoFed = new FederatedNode({
      vault: ivoSide.vault,
      persona: ivo.personaId,
      transport: ivoTransport,
      now: ivoSide.clock.now,
    });

    // ── the PR comment, and cross-person extraction ───────────────────────────────────────
    envelope = new GithubConnector({ persona: mila.personaId }).fromWebhook(
      {
        event: 'pull_request_review_comment',
        payload: {
          action: 'created',
          repository: { full_name: 'team/monorepo' },
          sender: { login: 'mila', id: 4001 },
          pull_request: { number: 88, title: `Fix flaky repro (${SPRINT_TASK})` },
          comment: {
            id: 77001,
            body: `@stefan I'll pull staging data for the repro by Wednesday`,
            created_at: PR_AT,
            html_url: 'https://example.invalid/pr/88#discussion_r77001',
            path: 'src/repro.ts',
          },
        },
      },
      { receivedAt: PR_AT },
    )[0]!;

    const extractor = new Extractor({
      persona: mila.personaId,
      model: createScriptedModelClient(
        JSON.stringify({
          results: [
            {
              envelope_id: envelope.id,
              intent: INTENT,
              owner: 'local_user',
              owner_label: null,
              owed_to: 'other_party',
              owed_to_label: 'stefan',
              due: DUE,
              confidence: 0.88,
              quote: "I'll pull staging data for the repro by Wednesday",
            },
          ],
        }),
        'scripted:scenario-4',
      ),
      // The node knows Stefan's key, which is what makes this proposable rather than the
      // half-network case of scenario 3.
      resolveParty: (label) => (label.toLowerCase() === 'stefan' ? stefan.personaId : null),
      now: () => milaSide.clock.iso(),
    });
    const run = await extractor.extract([envelope]);
    routed = run.items[0]!.routed;

    // Confirm-first: before Mila's tap, nothing has been signed for the wire.
    outboxBeforeTap = milaSide.vault.listOutbox(mila.personaId);

    // ── one tap ───────────────────────────────────────────────────────────────────────────
    if (!isProposable(routed)) throw new Error(`expected proposable, got ${routed.disposition}`);
    tap = confirmProposal(routed, {
      persona: mila.personaId,
      confirmedAt: milaSide.clock.iso(),
    });
    const proposed = milaSide.node.commit({
      intent: tap.commitment.intent,
      owed_to: stefan.personaId,
      due: DUE,
      persona: null,
      propose: true,
    });
    oldEdgeId = proposed.edge_id!;

    // ── delivery, and Stefan's signature ──────────────────────────────────────────────────
    await milaFed.push();
    const inbound = await stefanFed.pull();
    stefanSawProposal = inbound.accepted
      .filter((a) => a.type === 'propose')
      .map((a) => a.edge_id!);
    stefanChainAfterProposal = stefanSide.vault.getAssertions(stefan.personaId, oldEdgeId);

    // M-2: the owner cannot supply the counterparty's confirmation, even on her own node.
    try {
      milaSide.node.confirm({ id: oldEdgeId, decision: 'confirm' });
      milaOwnConfirmAttempt = null;
    } catch (err) {
      milaOwnConfirmAttempt = err;
    }

    stefanSide.node.confirm({ id: oldEdgeId, decision: 'confirm' });
    await stefanFed.push();
    await milaFed.pull();

    openBothSides = ([
      [milaSide, mila.personaId],
      [stefanSide, stefan.personaId],
    ] as const).map(([side, persona]) => ({
      signers: new Set(side.vault.getAssertions(persona, oldEdgeId).map((a) => a.by)).size,
      state: side.node.edgeState(persona, oldEdgeId).final_state,
    }));

    // ── M-4 / §5.2: published into team scope by an explicit signed act ───────────────────
    publish = withSignature(
      {
        v: 'servanda/0.1' as const,
        type: 'publish' as const,
        edge_id: oldEdgeId,
        scope: studioGroup.personaId, // the team's group key (§5.1)
        published_at: milaSide.clock.iso(),
        by: mila.personaId,
      },
      mila.privateKey,
    ) as Publish;
    milaSide.vault.putPublish(mila.personaId, publish);

    try {
      // Ivo is not a party to this edge yet. §5.2: only a party may publish it.
      milaSide.vault.putPublish(
        mila.personaId,
        withSignature(
          {
            v: 'servanda/0.1' as const,
            type: 'publish' as const,
            edge_id: oldEdgeId,
            scope: studioGroup.personaId,
            published_at: milaSide.clock.iso(),
            by: ivo.personaId,
          },
          ivo.privateKey,
        ) as Publish,
      );
      nonPartyPublishRefused = null;
    } catch (err) {
      nonPartyPublishRefused = err;
    }

    // ── Thursday: overdue, and the escalation ─────────────────────────────────────────────
    for (const side of [milaSide, stefanSide, ivoSide]) side.clock.advanceDays(3);
    thursdayEscalatable = milaSide.node.escalatable(mila.personaId);
    milaThursdaySlot = slotFor(milaSide, oldEdgeId);
    stefanThursdaySlot = slotFor(stefanSide, oldEdgeId);

    // ── Friday: supersession by delegation (§4.5) ─────────────────────────────────────────
    const oldEdge = milaSide.vault.getEdge(mila.personaId, oldEdgeId)!;

    // One party signing twice is not two parties — the substitution §4.5 exists to refuse.
    const milaSupersedes = signAssertion(mila, {
      edge_id: oldEdgeId,
      state: 'superseded',
      asserted_at: FRIDAY,
    });
    const milaAgain = signAssertion(mila, {
      edge_id: oldEdgeId,
      state: 'superseded',
      asserted_at: '2026-02-06T11:00:01Z',
    });
    doubleSupersedeOutcome = verifyAssertionChain(oldEdge, [
      ...milaSide.vault.getAssertions(mila.personaId, oldEdgeId),
      milaSupersedes,
      milaAgain,
    ]).outcomes.at(-1)?.rejection_reason;

    milaSide.vault.appendAssertion(mila.personaId, milaSupersedes);
    stateAfterOneSupersede = milaSide.node.edgeState(mila.personaId, oldEdgeId).final_state;

    await milaFed.push();
    await stefanFed.pull();
    const stefanSupersedes = signAssertion(stefan, {
      edge_id: oldEdgeId,
      state: 'superseded',
      asserted_at: FRIDAY,
    });
    stefanSide.vault.appendAssertion(stefan.personaId, stefanSupersedes);
    await stefanFed.push();
    await milaFed.pull();
    stateAfterBothSupersedes = milaSide.node.edgeState(mila.personaId, oldEdgeId).final_state;

    // The successor: same promise, new owner. §4.5 requires the new owner's `proposed`
    // signature on top of the old edge's two — three keys across the two edges.
    const successorCommitment = {
      v: 'servanda/0.1' as const,
      type: 'commitment' as const,
      intent: INTENT,
      owner: ivo.personaId,
      owed_to: stefan.personaId,
      due: DUE,
      conditions: [],
      evidence_refs: [],
      created_at: FRIDAY,
      source: 'explicit' as const,
      confidence: 1,
    };
    const successorHash = commitmentHash(successorCommitment);
    ivoSide.vault.putCommitment(ivo.personaId, successorCommitment);
    newEdge = {
      v: 'servanda/0.1',
      type: 'edge',
      edge_id: edgeId({
        commitment_hash: successorHash,
        owner: ivo.personaId,
        owed_to: stefan.personaId,
        proposed_at: FRIDAY,
      }),
      commitment_hash: successorHash,
      owner: ivo.personaId,
      owed_to: stefan.personaId,
      proposed_at: FRIDAY,
      due: DUE,
      closure_policy: 'on-acceptance',
      acceptance_window: 'P5D',
      blocked_by: [],
      supersedes: oldEdgeId,
    };
    const ivoProposes = signAssertion(ivo, {
      edge_id: newEdge.edge_id,
      state: 'proposed',
      asserted_at: FRIDAY,
    });
    ivoSide.vault.putEdge(ivo.personaId, newEdge);
    ivoSide.vault.appendAssertion(ivo.personaId, ivoProposes);

    // Straight onto the real transport, through the real inbox: M-4a, M-1 and M-14 all apply.
    await ivoTransport.send(
      stefan.personaId,
      signMessage(
        'propose',
        { edge: newEdge, assertion: ivoProposes },
        ivo.personaId,
        FRIDAY,
        ivo.privateKey,
      ),
    );
    await ivoTransport.sync();
    await stefanFed.pull();
    stefanSide.node.confirm({ id: newEdge.edge_id, decision: 'confirm' });
    await stefanFed.push();
    await ivoFed.pull();

    delegationSigners = [
      ...new Set([
        ...milaSide.vault.getAssertions(mila.personaId, oldEdgeId).map((a) => a.by),
        ...ivoSide.vault.getAssertions(ivo.personaId, newEdge.edge_id).map((a) => a.by),
      ]),
    ].sort();

    // ── Monday: the data lands ────────────────────────────────────────────────────────────
    for (const side of [milaSide, stefanSide, ivoSide]) side.clock.advanceDays(3);
    const evidence = hashCanonical({ kind: 'staging-dump', rows: 41_233, at: MONDAY });
    const ivoCloses = signAssertion(ivo, {
      edge_id: newEdge.edge_id,
      state: 'closed',
      asserted_at: MONDAY,
      evidence_hash: evidence,
    });
    ivoSide.vault.appendAssertion(ivo.personaId, ivoCloses);
    stateAfterEvidence = ivoSide.node.edgeState(ivo.personaId, newEdge.edge_id).final_state;
    await ivoFed.push();
    await stefanFed.pull();

    // §4.4: tacit acceptance is the window expiring, not the owner deciding it has.
    earlyTacitOutcome = verifyAssertionChain(newEdge, [
      ...ivoSide.vault.getAssertions(ivo.personaId, newEdge.edge_id),
      signAssertion(ivo, {
        edge_id: newEdge.edge_id,
        state: 'closed',
        asserted_at: TOO_EARLY,
        evidence_hash: evidence,
      }),
    ]).outcomes.at(-1)?.rejection_reason;

    for (const side of [milaSide, stefanSide, ivoSide]) side.clock.advanceDays(5);
    ivoSide.vault.appendAssertion(
      ivo.personaId,
      signAssertion(ivo, {
        edge_id: newEdge.edge_id,
        state: 'closed',
        asserted_at: WINDOW_ELAPSED,
        evidence_hash: evidence,
      }),
    );
    await ivoFed.push();
    await stefanFed.pull();

    finalStateMila = ivoSide.node.edgeState(ivo.personaId, newEdge.edge_id).final_state;
    finalStateStefan = stefanSide.node.edgeState(stefan.personaId, newEdge.edge_id).final_state;
    oldChainAfterEverything = stefanSide.vault.getAssertions(stefan.personaId, oldEdgeId);
  });

  it('§3.4: a cross-person extraction produces nothing on the wire before a human acts', () => {
    expect(routed.disposition).toBe(PROPOSABLE_AFTER_CONFIRMATION);
    // The confirm-first guarantee, as state: at the moment extraction finished, the outbox was
    // empty. Extraction proposes to a person; it never proposes to a peer.
    expect(outboxBeforeTap).toEqual([]);
    expect(tap.kind).toBe('confirmed-proposal');
    expect(tap.confirmedBy).toBe(mila.personaId);
    expect(tap.counterparty).toBe(stefan.personaId);
    expect(tap.commitment.intent).toBe(INTENT);
  });

  it('M-2: the edge exists only once the counterparty has signed', () => {
    // Delivered, and holding exactly one signature — Mila's. §4.3 calls that "socially nothing".
    expect(stefanSawProposal).toContain(oldEdgeId);
    expect(stefanChainAfterProposal).toHaveLength(1);
    expect(stefanChainAfterProposal[0]!.by).toBe(mila.personaId);
    expect(stefanChainAfterProposal[0]!.state).toBe('proposed');

    // The owner cannot supply it herself, on her node or anyone's.
    expect(milaOwnConfirmAttempt).toBeInstanceOf(M2Violation);

    // After Stefan's signature both vaults agree, and the chain carries two distinct keys.
    expect(openBothSides).toEqual([
      { signers: 2, state: 'open' },
      { signers: 2, state: 'open' },
    ]);
  });

  it('M-4/§5.2: publishing into team scope is an explicit signed act by a party', () => {
    const stored = milaSide.vault.listPublishRecords(mila.personaId);
    expect(stored).toHaveLength(1);
    expect(() => Publish.parse(stored[0]!)).not.toThrow();
    expect(stored[0]!.edge_id).toBe(oldEdgeId);
    expect(stored[0]!.scope).toBe(studioGroup.personaId);
    expect(stored[0]!.by).toBe(mila.personaId);
    // A non-party cannot publish someone else's edge into a scope, however well signed.
    expect(nonPartyPublishRefused).toBeInstanceOf(ScopeViolation);
  });

  it('Thursday: it is overdue, and the creditor is offered forgiveness rather than a chase', () => {
    // M-8: dated, verifiable, still open, past due — this one may escalate on the node's own
    // initiative. (Scenario 2 proved the converse: an undated record never can.)
    expect(thursdayEscalatable).toContain(oldEdgeId);

    // Mila's slot is the promise she owes. Stefan's, for the same edge, offers `release` —
    // unilateral forgiveness (§4.3). The creditor's primary action is never "remind her".
    // These are acts, not words: which button each side is shown is a protocol fact, and the
    // wording of it belongs to whichever client paints it (M-21).
    expect(milaThursdaySlot?.act).toBe('done');
    expect(stefanThursdaySlot?.act).toBe('release');
  });

  it('§4.5: supersession needs both parties of the old edge, and one signing twice is not two', () => {
    expect(doubleSupersedeOutcome).toBe('duplicate-assertion-by-same-party');
    // Mila alone changes nothing: the edge is still open and still hers.
    expect(stateAfterOneSupersede).toBe('open');
    expect(stateAfterBothSupersedes).toBe('superseded');
  });

  it('§4.5 delegation: three keys across two edges, and the history is intact', () => {
    expect(newEdge.supersedes).toBe(oldEdgeId);
    expect(newEdge.owner).toBe(ivo.personaId);
    expect(newEdge.owed_to).toBe(stefan.personaId);
    // "three keys total across the two edges" — Mila and Stefan on the old, Ivo on the new.
    expect(delegationSigners).toEqual([mila.personaId, ivo.personaId, stefan.personaId].sort());

    // History is never deleted: the old edge and its full chain survive on both sides.
    expect(stefanSide.vault.getEdge(stefan.personaId, oldEdgeId)).not.toBeNull();
    expect(oldChainAfterEverything.length).toBeGreaterThanOrEqual(4);
    expect(stefanSide.node.edgeState(stefan.personaId, oldEdgeId).final_state).toBe('superseded');
  });

  it('§4.4: the edge closes by tacit acceptance, and only once the window has actually elapsed', () => {
    expect(stateAfterEvidence).toBe('pending-acceptance');
    // The owner deciding the window is over does not make it over.
    expect(earlyTacitOutcome).toBe('acceptance-window-not-elapsed');
    expect(finalStateMila).toBe('closed');
  });

  it('§6.7: both nodes converge on one chain and one state, over git, with no network', () => {
    expect(finalStateStefan).toBe('closed');
    const ivoChain = ivoSide.vault.getAssertions(ivo.personaId, newEdge.edge_id);
    const stefanChain = stefanSide.vault.getAssertions(stefan.personaId, newEdge.edge_id);
    expect(new Set(stefanChain.map((a) => a.sig))).toEqual(new Set(ivoChain.map((a) => a.sig)));
  });

  it('M-7: nothing Stefan holds is the text of what he was promised', () => {
    // He is a party to the edge and never received the commitment plaintext — §4 shares hashes
    // and states. This is why "remember that, not what" survives retention in scenario 5.
    expect(stefanSide.vault.getCommitment(stefan.personaId, newEdge.commitment_hash)).toBeNull();
    const held = JSON.stringify([
      stefanSide.vault.getEdge(stefan.personaId, newEdge.edge_id),
      stefanSide.vault.getAssertions(stefan.personaId, newEdge.edge_id),
    ]);
    expect(held).not.toContain(INTENT);
  });
});

/** The brief slot for one edge, as that persona's own node renders it. */
function slotFor(side: Install, id: string): { headline: string; act: string | null } | null {
  const slot = side.node.brief({ persona: null }).slots.find((s) => s.item_id === id);
  return slot ? { headline: slot.headline, act: slot.primary_action?.act ?? null } : null;
}
