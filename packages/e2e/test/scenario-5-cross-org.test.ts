import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitmentHash, edgeId, hashCanonical, withSignature } from '@servanda/crypto';
import { FederatedNode, GitTransport, signMessage } from '@servanda/federation';
import {
  bindingLevel,
  DomainAnchorResolver,
  verifyAttestation,
  type AnchorResolution,
  type AttestationVerdict,
  type VerifiedIdentity,
} from '@servanda/identity';
import { isCollectiveEdgeVerifiable, mayAutoEscalate, verifyAssertionChain } from '@servanda/node';
import type { Assertion, Attestation, Commitment, Edge } from '@servanda/types';
import { runRetention, type RetentionResult } from '@servanda/vault';
import {
  acme,
  freshInstall,
  signAssertion,
  studioCode,
  studioCutover,
  studioData,
  studioGroup,
  studioOrgRoot,
  type Install,
} from './support.js';

/**
 * SCENARIO 5 — "Cross-org: the collective, the domain anchor, and why the client believes" (§5).
 *
 * A three-person studio owes Acme a billing-provider migration by Sept 30. Outward it is one
 * edge owned by the studio's group key, attested by an org root anchored at studio.bg — so
 * Acme's client says *domain-verified* without Acme's CTO ever learning what an attestation
 * chain is. Inward it decomposes into three sub-edges the client never sees.
 *
 * The cutover ships, the acceptance window opens, Acme disputes with evidence, the studio fixes
 * and supersedes, and the edge closes with both signatures. Then the retention window passes and
 * the payoff lands: the plaintext is gone, the signed chain remains. The studio can prove
 * forever that this promise was made and kept, with these dates — and nobody, the studio
 * included, can reconstruct what it said.
 *
 * No network. The §1.5 anchor resolver is injected (`@servanda/identity` opens no socket), and
 * the two nodes exchange over a local bare git repository.
 *
 * GAPS (reported, not stubbed):
 *   - As in scenario 4, §7 cannot express `closed`, `disputed` or `superseded`; those assertions
 *     are signed here and judged by `verifyAssertionChain`, which remains the only authority.
 *   - §4.7 says parent state "derives from children per `policy`". Nothing computes that
 *     derivation: `isCollectiveEdgeVerifiable` decides only whether the parent is verifiable at
 *     all. The parent's state below is driven by its own assertions, and the `all` policy is
 *     asserted as structure rather than as a derived state.
 */

const DOMAIN = 'studio.bg';
const PROPOSED_AT = '2026-06-01T09:00:00Z';
const DUE = '2026-09-30T17:00:00Z';
const CUTOVER = '2026-09-28T20:00:00Z';
const DISPUTED_AT = '2026-10-01T08:00:00Z';
const FIXED_AT = '2026-10-03T14:00:00Z';
const CLOSED_AT = '2026-10-06T10:00:00Z';
/** Well past the retention window, so the §5.4 pass has something to do. */
const LONG_AFTER = '2028-01-10T00:00:00Z';
const RETENTION_DAYS = 365;

const INTENT = 'migrate Acme to the new billing provider, cutover included';
const SUB_INTENTS = ['migrate the billing data', 'port the integration code', 'run the cutover'];

describe('scenario 5 — cross-org: one edge outward, three inward, a hash that outlives both', () => {
  let studioSide: Install;
  let acmeSide: Install;
  let studioFed: FederatedNode;
  let acmeFed: FederatedNode;
  let studioTransport: GitTransport;

  let attestation: Attestation;
  let verdict: AttestationVerdict;
  let anchor: AnchorResolution;
  let identity: VerifiedIdentity;
  let mismatchedIdentity: VerifiedIdentity;
  let anchorWithoutTransport: AnchorResolution;

  let commitment: Commitment;
  let parent: Edge;
  let children: Edge[];
  let unverifiableCollective: Edge;

  let acmeEdgeIdsAfterSync: string[];
  let stateAfterCutover: string;
  let disputeWithoutEvidence: string | undefined;
  let stateAfterDispute: string;

  let successor: Edge;
  let stateOfParentAtEnd: string;
  let successorStateStudio: string;
  let successorStateAcme: string;
  let successorSigners: string[];

  let retention: RetentionResult;
  let plaintextBeforeRetention: Commitment | null;
  let plaintextAfterRetention: Commitment | null;
  let chainAfterRetention: Assertion[];
  let survivingRecord: string;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'servanda-s5-'));
    // The studio's node acts as its group key (§5.1: a scope is identified by its key).
    studioSide = await freshInstall(PROPOSED_AT, studioGroup);
    acmeSide = await freshInstall(PROPOSED_AT, acme);

    const shared = GitTransport.initShared(join(root, 'shared.git'));
    studioTransport = GitTransport.init({
      dir: join(root, 'studio'),
      persona: studioGroup.personaId,
      remote: shared,
    });
    const acmeTransport = GitTransport.init({
      dir: join(root, 'acme'),
      persona: acme.personaId,
      remote: shared,
    });
    studioFed = new FederatedNode({
      vault: studioSide.vault,
      persona: studioGroup.personaId,
      transport: studioTransport,
      now: studioSide.clock.now,
    });
    acmeFed = new FederatedNode({
      vault: acmeSide.vault,
      persona: acme.personaId,
      transport: acmeTransport,
      now: acmeSide.clock.now,
    });

    // ── §1.3 + §1.5: why Acme believes ────────────────────────────────────────────────────
    attestation = withSignature(
      {
        v: 'servanda/0.1' as const,
        type: 'attestation' as const,
        org: studioOrgRoot.personaId,
        subject: studioGroup.personaId,
        subject_kind: 'group' as const,
        claims: { display_name: 'Studio', handle: 'studio' },
        issued_at: '2026-01-05T00:00:00Z',
        expires_at: '2027-01-05T00:00:00Z',
      },
      studioOrgRoot.privateKey,
    ) as Attestation;
    acmeSide.vault.putAttestation(acme.personaId, attestation);

    verdict = verifyAttestation(attestation, {
      now: new Date(PROPOSED_AT),
      subject: studioGroup.personaId,
      org: studioOrgRoot.personaId,
    });

    // The anchor transport is injected. There is no global-fetch fallback in this package: with
    // nothing injected it fails closed, which the third resolution below shows.
    const wellKnown = JSON.stringify({
      v: 'servanda/0.1',
      org_root: studioOrgRoot.personaId,
      hubs: [],
    });
    anchor = await new DomainAnchorResolver({
      transport: {
        fetchWellKnown: async (url) =>
          url === `https://${DOMAIN}/.well-known/servanda.json`
            ? { status: 200, body: wellKnown, ttlSeconds: 3600 }
            : null,
      },
      clock: { now: () => new Date(PROPOSED_AT) },
    }).resolve(DOMAIN);
    anchorWithoutTransport = await new DomainAnchorResolver().resolve(DOMAIN);

    identity = bindingLevel({
      subject: studioGroup.personaId,
      attestation: verdict,
      anchor,
    });

    // An anchor that names a *different* org root proves nothing about this attestation.
    const otherRoot = await new DomainAnchorResolver({
      transport: {
        fetchWellKnown: async () => ({
          status: 200,
          body: JSON.stringify({ v: 'servanda/0.1', org_root: acme.personaId, hubs: [] }),
          ttlSeconds: 3600,
        }),
      },
      clock: { now: () => new Date(PROPOSED_AT) },
    }).resolve(DOMAIN);
    mismatchedIdentity = bindingLevel({
      subject: studioGroup.personaId,
      attestation: verdict,
      anchor: otherRoot,
    });

    // ── the outward edge: one promise, owned by the group ─────────────────────────────────
    commitment = {
      v: 'servanda/0.1',
      type: 'commitment',
      intent: INTENT,
      owner: studioGroup.personaId,
      owed_to: acme.personaId,
      due: DUE,
      conditions: [],
      evidence_refs: [],
      created_at: PROPOSED_AT,
      source: 'explicit',
      confidence: 1,
    };
    const hash = commitmentHash(commitment);
    studioSide.vault.putCommitment(studioGroup.personaId, commitment);

    // ── the inward decomposition: three sub-edges the client never sees ───────────────────
    children = SUB_INTENTS.map((intent, i) => {
      const member = [studioData, studioCode, studioCutover][i]!;
      const childCommitment: Commitment = {
        ...commitment,
        intent,
        owner: member.personaId,
        owed_to: studioGroup.personaId,
        created_at: PROPOSED_AT,
      };
      const childHash = commitmentHash(childCommitment);
      studioSide.vault.putCommitment(studioGroup.personaId, childCommitment);
      return {
        v: 'servanda/0.1' as const,
        type: 'edge' as const,
        edge_id: edgeId({
          commitment_hash: childHash,
          owner: member.personaId,
          owed_to: studioGroup.personaId,
          proposed_at: PROPOSED_AT,
        }),
        commitment_hash: childHash,
        owner: member.personaId,
        owed_to: studioGroup.personaId,
        proposed_at: PROPOSED_AT,
        due: DUE,
        closure_policy: 'on-acceptance' as const,
        acceptance_window: 'P5D',
        blocked_by: [],
        supersedes: null,
      };
    });
    for (const child of children) studioSide.vault.putEdge(studioGroup.personaId, child);

    parent = {
      v: 'servanda/0.1',
      type: 'edge',
      edge_id: edgeId({
        commitment_hash: hash,
        owner: studioGroup.personaId,
        owed_to: acme.personaId,
        proposed_at: PROPOSED_AT,
      }),
      commitment_hash: hash,
      owner: studioGroup.personaId,
      owed_to: acme.personaId,
      proposed_at: PROPOSED_AT,
      due: DUE,
      closure_policy: 'on-acceptance',
      acceptance_window: 'P5D',
      blocked_by: [],
      // §4.7: `all` over the three children, with a named coordinator. Either alone would
      // satisfy M-9; the studio publishes both.
      fulfillment: {
        policy: 'all',
        children: children.map((c) => c.edge_id),
        coordinator: studioCutover.personaId,
      },
      supersedes: null,
    };
    // §4.7 / M-9: the same edge with neither a decomposition nor a coordinator.
    unverifiableCollective = {
      ...parent,
      edge_id: hashCanonical({ counterfactual: parent.edge_id }),
      fulfillment: { policy: 'all', children: [] },
    };

    const propose = async (edge: Edge, at: string): Promise<Assertion> => {
      const assertion = signAssertion(studioGroup, {
        edge_id: edge.edge_id,
        state: 'proposed',
        asserted_at: at,
      });
      studioSide.vault.putEdge(studioGroup.personaId, edge);
      studioSide.vault.appendAssertion(studioGroup.personaId, assertion);
      await studioTransport.send(
        acme.personaId,
        signMessage(
          'propose',
          { edge, assertion },
          studioGroup.personaId,
          at,
          studioGroup.privateKey,
        ),
      );
      await studioTransport.sync();
      await acmeFed.pull();
      return assertion;
    };

    await propose(parent, PROPOSED_AT);
    acmeSide.node.confirm({ id: parent.edge_id, decision: 'confirm' });
    await acmeFed.push();
    await studioFed.pull();
    acmeEdgeIdsAfterSync = acmeSide.vault.listEdgeIds(acme.personaId);

    // ── Sept 28: the cutover ships, and the acceptance window opens ───────────────────────
    const cutoverEvidence = hashCanonical({ kind: 'cutover-report', at: CUTOVER });
    studioSide.vault.appendAssertion(
      studioGroup.personaId,
      signAssertion(studioGroup, {
        edge_id: parent.edge_id,
        state: 'closed',
        asserted_at: CUTOVER,
        evidence_hash: cutoverEvidence,
      }),
    );
    stateAfterCutover = studioSide.node.edgeState(studioGroup.personaId, parent.edge_id)
      .final_state;
    await studioFed.push();
    await acmeFed.pull();

    // ── Oct 1: "invoice PDFs missing the VAT line" ────────────────────────────────────────
    // §4.3: `disputed` REQUIRES an evidence_hash. A dispute without one is not a dispute.
    disputeWithoutEvidence = verifyAssertionChain(parent, [
      ...acmeSide.vault.getAssertions(acme.personaId, parent.edge_id),
      signAssertion(acme, {
        edge_id: parent.edge_id,
        state: 'disputed',
        asserted_at: DISPUTED_AT,
      }),
    ]).outcomes.at(-1)?.rejection_reason;

    acmeSide.vault.appendAssertion(
      acme.personaId,
      signAssertion(acme, {
        edge_id: parent.edge_id,
        state: 'disputed',
        asserted_at: DISPUTED_AT,
        evidence_hash: hashCanonical({ complaint: 'invoice PDFs missing the VAT line' }),
      }),
    );
    await acmeFed.push();
    await studioFed.pull();
    stateAfterDispute = studioSide.node.edgeState(studioGroup.personaId, parent.edge_id)
      .final_state;

    // ── the fix, as mechanics rather than drama: supersession ─────────────────────────────
    for (const [side, who] of [
      [studioSide, studioGroup],
      [acmeSide, acme],
    ] as const) {
      side.vault.appendAssertion(
        side.node.resolvePersona(null),
        signAssertion(who, {
          edge_id: parent.edge_id,
          state: 'superseded',
          asserted_at: FIXED_AT,
        }),
      );
    }
    await studioFed.push();
    await acmeFed.pull();
    await acmeFed.push();
    await studioFed.pull();
    stateOfParentAtEnd = studioSide.node.edgeState(studioGroup.personaId, parent.edge_id)
      .final_state;

    const fixedCommitment: Commitment = {
      ...commitment,
      intent: `${INTENT} (VAT line on invoice PDFs)`,
      created_at: FIXED_AT,
    };
    const fixedHash = commitmentHash(fixedCommitment);
    studioSide.vault.putCommitment(studioGroup.personaId, fixedCommitment);
    successor = {
      ...parent,
      edge_id: edgeId({
        commitment_hash: fixedHash,
        owner: studioGroup.personaId,
        owed_to: acme.personaId,
        proposed_at: FIXED_AT,
      }),
      commitment_hash: fixedHash,
      proposed_at: FIXED_AT,
      supersedes: parent.edge_id,
    };
    await propose(successor, FIXED_AT);
    acmeSide.node.confirm({ id: successor.edge_id, decision: 'confirm' });
    await acmeFed.push();
    await studioFed.pull();

    const fixEvidence = hashCanonical({ kind: 'vat-line-fix', at: FIXED_AT });
    studioSide.vault.appendAssertion(
      studioGroup.personaId,
      signAssertion(studioGroup, {
        edge_id: successor.edge_id,
        state: 'closed',
        asserted_at: FIXED_AT,
        evidence_hash: fixEvidence,
      }),
    );
    await studioFed.push();
    await acmeFed.pull();

    // Oct 6: Acme accepts explicitly, inside the window. Both signatures, not a timeout.
    acmeSide.vault.appendAssertion(
      acme.personaId,
      signAssertion(acme, {
        edge_id: successor.edge_id,
        state: 'closed',
        asserted_at: CLOSED_AT,
        evidence_hash: null,
      }),
    );
    await acmeFed.push();
    await studioFed.pull();

    successorStateStudio = studioSide.node.edgeState(studioGroup.personaId, successor.edge_id)
      .final_state;
    successorStateAcme = acmeSide.node.edgeState(acme.personaId, successor.edge_id).final_state;
    successorSigners = [
      ...new Set(
        studioSide.vault.getAssertions(studioGroup.personaId, successor.edge_id).map((a) => a.by),
      ),
    ].sort();

    // ── §5.4 / M-15: the retention pass ───────────────────────────────────────────────────
    studioSide.vault.setRetentionPolicy(RETENTION_DAYS);
    // Read before the pass, so "the plaintext is gone" is a change and not a fact about a
    // record that was never written.
    plaintextBeforeRetention = studioSide.vault.getCommitment(studioGroup.personaId, fixedHash);
    retention = runRetention(
      studioSide.vault,
      studioGroup.personaId,
      (persona, id) => {
        const chain = studioSide.node.edgeState(persona, id);
        return { state: chain.final_state, resolved_at: chain.resolved_at };
      },
      { now: new Date(LONG_AFTER) },
    );
    plaintextAfterRetention = studioSide.vault.getCommitment(studioGroup.personaId, fixedHash);
    chainAfterRetention = studioSide.vault.getAssertions(studioGroup.personaId, successor.edge_id);
    survivingRecord = JSON.stringify({
      edge: studioSide.vault.getEdge(studioGroup.personaId, successor.edge_id),
      chain: chainAfterRetention,
      meta: studioSide.vault.getEdgeMeta(studioGroup.personaId, successor.edge_id),
    });
  });

  it('§1.5/§1.6: Acme sees domain-verified, and the anchor was never fetched over a socket', () => {
    expect(verdict.ok).toBe(true);
    expect(anchor.ok).toBe(true);
    expect(anchor.sources).toEqual(['well-known']);

    // Level 3 = a valid org attestation plus that org's root anchored at the domain.
    expect(identity.level).toBe('3');
    expect(identity.levelLabel).toBe('domain-verified');
    expect(identity.anchoredDomain).toBe(DOMAIN);
    expect(identity.attestedBy).toBe(studioOrgRoot.personaId);
    // M-12: the name travels only at the level whose evidence carries it. "from @studio.bg
    // means from the studio" is all Acme's CTO has to understand.
    expect(identity.displayName).toBe('Studio');
    expect(identity.render.level).toBe('3');

    // No transport injected → fails closed. The package cannot reach for a global fetch.
    expect(anchorWithoutTransport.ok).toBe(false);
    expect(anchorWithoutTransport.reason).toBe('no-transport');
  });

  it('§1.6: an anchor for a different org root confers nothing', () => {
    expect(mismatchedIdentity.level).toBe('2');
    expect(mismatchedIdentity.anchoredDomain).toBeNull();
    expect(mismatchedIdentity.downgrades.map((d) => d.reason)).toContain('anchor:org-root-mismatch');
    // Still attested, so the name still travels — just not with a domain behind it.
    expect(mismatchedIdentity.displayName).toBe('Studio');
  });

  it('§4.7/M-9: outward one collective edge; a decomposition that covers nothing is unverifiable', () => {
    expect(parent.owner).toBe(studioGroup.personaId);
    expect(parent.owed_to).toBe(acme.personaId);
    expect(parent.fulfillment?.policy).toBe('all');
    expect(parent.fulfillment?.children).toHaveLength(3);
    expect(parent.fulfillment?.coordinator).toBe(studioCutover.personaId);
    expect(isCollectiveEdgeVerifiable(parent)).toBe(true);

    // M-9 + M-8: neither children nor a coordinator → unverifiable, and unverifiable never
    // auto-escalates however overdue it is. The system has an opinion only where it has evidence.
    expect(isCollectiveEdgeVerifiable(unverifiableCollective)).toBe(false);
    const verification = verifyAssertionChain(unverifiableCollective, []);
    expect(verification.unverifiable).toBe(true);
    expect(mayAutoEscalate(unverifiableCollective, verification, new Date(LONG_AFTER))).toBe(false);
  });

  it('M-4a/§4.7: the client sees the parent, and nothing of the kitchen', () => {
    // Acme holds the parent edge. It holds no sub-edge, no sub-assertion, and no plaintext of
    // anything — not because they were filtered on display, but because they never arrived.
    expect(acmeEdgeIdsAfterSync).toContain(parent.edge_id);
    for (const child of children) {
      expect(acmeEdgeIdsAfterSync).not.toContain(child.edge_id);
      expect(acmeSide.vault.getAssertions(acme.personaId, child.edge_id)).toEqual([]);
    }
    expect(acmeSide.vault.getCommitment(acme.personaId, parent.commitment_hash)).toBeNull();
    for (const sub of SUB_INTENTS) {
      expect(JSON.stringify(acmeSide.vault.listCommitments(acme.personaId))).not.toContain(sub);
    }
  });

  it('§4.4/§4.3: the cutover opens the window; a dispute without evidence is not a dispute', () => {
    expect(stateAfterCutover).toBe('pending-acceptance');
    expect(disputeWithoutEvidence).toBe('evidence-hash-required');
    expect(stateAfterDispute).toBe('disputed');
  });

  it('§4.5: the dispute exits by supersession, and the successor closes with both signatures', () => {
    expect(stateOfParentAtEnd).toBe('superseded');
    expect(successor.supersedes).toBe(parent.edge_id);
    // A new commitment_hash, because the content changed (§4.5).
    expect(successor.commitment_hash).not.toBe(parent.commitment_hash);

    expect(successorStateStudio).toBe('closed');
    expect(successorStateAcme).toBe('closed');
    expect(successorSigners).toEqual([studioGroup.personaId, acme.personaId].sort());
  });

  it('M-15/ADR-0004: after retention the terms are gone and the proof remains', () => {
    // The pass deleted plaintext and preserved every edge — never the other way round.
    expect(retention.deleted_plaintext).toContain(successor.commitment_hash);
    expect(retention.preserved_edges).toContain(successor.edge_id);
    expect(retention.preserved_edges).toContain(parent.edge_id);

    // What the studio can no longer do: say what it promised. It could, right up until the pass.
    expect(plaintextBeforeRetention?.intent).toBe(`${INTENT} (VAT line on invoice PDFs)`);
    expect(retention.skipped_within_window).not.toContain(successor.edge_id);
    expect(plaintextAfterRetention).toBeNull();
    expect(survivingRecord).not.toContain('VAT line on invoice PDFs');
    expect(survivingRecord).not.toContain(INTENT);

    // What the studio can still do, forever: prove that this promise was made, by these two
    // keys, and closed on these dates. The chain still verifies against the edge, and the edge
    // still carries the §3.2 hash — so anyone holding the original text can check it matches,
    // and nobody without it can recover the text from the hash.
    const edge = studioSide.vault.getEdge(studioGroup.personaId, successor.edge_id)!;
    const verification = verifyAssertionChain(edge, chainAfterRetention);
    expect(verification.final_state).toBe('closed');
    expect(verification.outcomes.every((o) => o.accepted)).toBe(true);
    expect(verification.resolved_at).toBe(CLOSED_AT);
    expect(
      commitmentHash({
        intent: `${INTENT} (VAT line on invoice PDFs)`,
        owner: studioGroup.personaId,
        owed_to: acme.personaId,
        due: DUE,
        created_at: FIXED_AT,
      }),
    ).toBe(edge.commitment_hash);

    // And the surviving record still names both parties and both dates — a client reference
    // enforced by math rather than by a testimonial.
    expect(edge.owner).toBe(studioGroup.personaId);
    expect(edge.owed_to).toBe(acme.personaId);
    expect(new Set(chainAfterRetention.map((a) => a.by)).size).toBe(2);
  });

  it('M-7: what survives is what the counterparty could always see anyway', () => {
    // Acme was a party for the whole story and never held the plaintext. Retention on the
    // studio's side brings the studio down to what Acme always had: hashes and states.
    const acmeEdge = acmeSide.vault.getEdge(acme.personaId, successor.edge_id)!;
    expect(acmeEdge.commitment_hash).toBe(successor.commitment_hash);
    expect(acmeSide.vault.getCommitment(acme.personaId, successor.commitment_hash)).toBeNull();
  });
});
