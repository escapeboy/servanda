import { commitmentHash, edgeId, hashCanonical, withSignature } from '@servanda/crypto';
import type {
  Assertion,
  BriefInput,
  BriefOutput,
  BriefSlot,
  Commitment,
  CommitInput,
  CommitOutput,
  ActInput,
  ActOutput,
  ConfirmInput,
  ConfirmOutput,
  Edge,
  EffectiveState,
  Expectation,
  ExpectInput,
  ExpectOutput,
  ItemAction,
  OpenLoopItem,
  OpenLoopsInput,
  OpenLoopsOutput,
  RejectionReason,
  VerificationLevel,
} from '@servanda/types';
import { ACT_TOOL_BINDINGS, type ActRejectionReason, PROTOCOL_VERSION } from '@servanda/types';
import { DEFAULT_ACCEPTANCE_WINDOW } from '@servanda/types';
import type { OrderingKey, PendingExtraction, Vault } from '@servanda/vault';
import { verifyAssertionChain, type ChainVerification } from './transitions.js';
import { actionsFor } from './actions.js';
import { addDuration } from './duration.js';
import { mayAutoEscalate } from './escalation.js';
import { rank } from './ranking.js';

/**
 * @servanda/node — L1 plus the §7 node surface.
 *
 * M-10: everything here is local. No socket is opened, no server is contacted, and no second
 * participant is required for any operation. `propose` produces a signed wire message and
 * queues it in the vault outbox; handing that to a transport is §6's job, not L1's.
 */

export class NodeError extends Error {
  override name = 'NodeError';
}

/** §7 conformance note + M-1: you cannot record someone else's promise as theirs. */
export class M1Violation extends NodeError {
  override name = 'M1Violation';
}

/** M-2: an owner cannot supply the counterparty's confirmation. */
export class M2Violation extends NodeError {
  override name = 'M2Violation';
}

/** M-11: no cross-party fulfillment statistics. */
export class M11Violation extends NodeError {
  override name = 'M11Violation';
}

export interface ServandaNodeOptions {
  vault: Vault;
  /** persona_id of the active persona (§7: `persona: null` means "default active"). */
  activePersona: string;
  now?: () => Date;
  /** §7 brief: how many slots are above the line. */
  briefSlots?: number;
}

export const DEFAULT_BRIEF_SLOTS = 5;

/**
 * §4.3's fifteen rejection reasons projected onto the seven `act` may report.
 *
 * `act` defers to the transition table, and the table's vocabulary is the larger one — so the
 * projection has to be total. It was a `.parse()`, which meant every reason without a surface name
 * threw a ZodError out of a tool whose contract is to REFUSE, not to throw: `act({act:'done'})`
 * with no evidence (the schema's own default) and a second `done` on a closed edge both crashed.
 * Two of the collapses below are not this module's choice — `node-surface/act-tool.json` states
 * `evidence-hash-required` for the first and `illegal-source-state` for the second, and those two
 * vectors are the ones the crash was hiding.
 *
 * Total by type, so a new reason in `RejectionReason` cannot compile until it has an answer here.
 * The remaining collapses to `illegal-source-state` are lossy: the surface enum has no member for
 * "the edge itself is malformed" or "you already signed this one".
 */
const ACT_REJECTION: Record<RejectionReason, ActRejectionReason> = {
  'wrong-signer-for-transition': 'wrong-role-for-act',
  'signer-not-a-party': 'not-a-party',
  'illegal-source-state': 'illegal-source-state',
  'evidence-hash-required': 'evidence-hash-required',
  'evidence-hash-required-for-owner-closure': 'evidence-hash-required',
  'due-is-null': 'illegal-source-state',
  'expiry-before-due': 'illegal-source-state',
  'acceptance-window-not-elapsed': 'acceptance-window-not-elapsed',
  'dispute-window-not-elapsed': 'illegal-source-state',
  'malformed-edge-acceptance-window': 'illegal-source-state',
  'implicit-transition-not-assertable': 'illegal-source-state',
  'invalid-signature': 'illegal-source-state',
  'terminal-state-reached': 'illegal-source-state',
  'edge-id-mismatch': 'illegal-source-state',
  'duplicate-assertion-by-same-party': 'illegal-source-state',
};

/**
 * What `intent_or_expect` says when this node holds the edge but not the plaintext — either
 * because retention deleted it (§5.4, M-15) or because it never had it (a counterparty
 * receives the edge and its chain, never the commitment text: M-7). "Remember that, not what."
 */
export const NO_LOCAL_PLAINTEXT = '(no local plaintext for this commitment)';

/**
 * M-1 at the tool boundary. Checked BEFORE schema validation, so a client attempting to record
 * someone else's promise is told which rule it broke rather than which field it mistyped — the
 * constitutional refusal is the more useful answer, and the more honest one.
 */
export function assertNoForeignOwner(input: { owner?: unknown }): void {
  if (input.owner !== undefined) {
    throw new M1Violation(
      'M-1: a promise is owned by its giver. `commit` records the calling persona’s own ' +
        'promise and takes no `owner`; use `expect` for what someone else said they would do.',
    );
  }
}

export class ServandaNode {
  readonly vault: Vault;
  private readonly activePersona: string;
  private readonly clock: () => Date;
  private readonly briefSlots: number;

  constructor(opts: ServandaNodeOptions) {
    this.vault = opts.vault;
    this.activePersona = opts.activePersona;
    this.clock = opts.now ?? (() => new Date());
    this.briefSlots = opts.briefSlots ?? DEFAULT_BRIEF_SLOTS;
  }

  private now(): Date {
    return this.clock();
  }

  /**
   * §7: `persona: null` means the active persona. A persona may be named by its persona_id or
   * by its local context label (§1.2: "the vault records {persona_index → context_label}").
   */
  resolvePersona(persona: string | null | undefined): string {
    if (persona === null || persona === undefined || persona === '') return this.activePersona;
    if (/^[0-9a-f]{64}$/.test(persona)) return persona;
    for (const id of this.vault.listPersonaIds()) {
      if (this.vault.getPersona(id).label === persona) return id;
    }
    throw new NodeError(`no such persona: ${persona}`);
  }

  // ── §7 commit ───────────────────────────────────────────────────────────────────────────

  /**
   * §7 `commit`. The owner is ALWAYS the calling persona — there is no input field for it, and
   * supplying one is rejected rather than ignored (M-1: "the correct object for 'they said they
   * would' is an expectation"). Silently dropping an `owner` key would let a rude client
   * believe it had recorded someone else's promise.
   */
  commit(rawInput: CommitInput & { owner?: unknown }): CommitOutput {
    assertNoForeignOwner(rawInput);
    const persona = this.resolvePersona(rawInput.persona);
    const created_at = this.now().toISOString();

    const commitment: Commitment = {
      v: PROTOCOL_VERSION,
      type: 'commitment',
      intent: rawInput.intent,
      owner: persona,
      owed_to: rawInput.owed_to,
      due: rawInput.due,
      conditions: [],
      evidence_refs: [],
      created_at,
      source: 'explicit',
      confidence: 1,
    };
    const hash = commitmentHash({
      intent: commitment.intent,
      owner: commitment.owner,
      owed_to: commitment.owed_to,
      due: commitment.due,
      created_at: commitment.created_at,
    });
    this.vault.putCommitment(persona, commitment);

    if (!rawInput.propose) return { commitment_hash: hash, edge_id: null, state: 'vault-local' };

    // §7: "`propose:true` requires `owed_to` resolvable to a persona; otherwise the record
    // stays vault-local." Narrowest reading of "resolvable": a 64-hex persona key. An
    // external_label (§3.1, half-network case) is not resolvable, and neither is oneself —
    // §4 edges are cross-person and §4.4 says reflexive commitments have no edges at all.
    const owedTo = rawInput.owed_to;
    if (owedTo === null || !/^[0-9a-f]{64}$/.test(owedTo) || owedTo === persona) {
      return { commitment_hash: hash, edge_id: null, state: 'vault-local' };
    }

    const edge = this.buildEdge(hash, persona, owedTo, created_at, commitment.due);
    this.vault.putEdge(persona, edge);
    const assertion = this.signAssertion(persona, edge.edge_id, 'proposed', created_at, null);
    this.vault.appendAssertion(persona, assertion);
    this.queuePropose(persona, owedTo, edge, assertion);

    return { commitment_hash: hash, edge_id: edge.edge_id, state: 'proposed' };
  }

  private buildEdge(
    commitment_hash: string,
    owner: string,
    owed_to: string,
    proposed_at: string,
    due: string | null,
  ): Edge {
    return {
      v: PROTOCOL_VERSION,
      type: 'edge',
      edge_id: edgeId({ commitment_hash, owner, owed_to, proposed_at }),
      commitment_hash,
      owner,
      owed_to,
      proposed_at,
      due,
      // §4.4: on-acceptance "MUST be the default for cross-person edges".
      closure_policy: 'on-acceptance',
      acceptance_window: DEFAULT_ACCEPTANCE_WINDOW,
      blocked_by: [],
      supersedes: null,
    };
  }

  /** M-10: the wire message is produced and stored locally. No transport is required to exist. */
  private queuePropose(persona: string, recipient: string, edge: Edge, assertion: Assertion): void {
    const message = withSignature(
      {
        v: PROTOCOL_VERSION,
        type: 'propose',
        payload: { edge, assertion },
        sender: persona,
        // §6.2: signed, not merely routed. The outbox already carries `recipient` for delivery,
        // but a delivery field binds nothing — a recipient could re-seal this to a third party
        // and the signature would still verify there.
        recipient,
        sent_at: this.now().toISOString(),
      },
      this.vault.getPersona(persona).private_key,
    );
    this.vault.putOutbox({
      v: PROTOCOL_VERSION,
      type: 'outbox_item',
      id: hashCanonical(message),
      persona,
      recipient,
      message: message as unknown as Record<string, unknown>,
      queued_at: this.now().toISOString(),
    });
  }

  private signAssertion(
    persona: string,
    edge_id: string,
    state: Assertion['state'],
    asserted_at: string,
    evidence_hash: string | null,
  ): Assertion {
    const unsigned = {
      v: PROTOCOL_VERSION,
      type: 'assertion' as const,
      edge_id,
      state,
      asserted_at,
      by: persona,
      evidence_hash,
    };
    return withSignature(unsigned, this.vault.getPersona(persona).private_key) as Assertion;
  }

  // ── §7 expect ───────────────────────────────────────────────────────────────────────────

  /**
   * §7 `expect`. ADR-0013 / M-1: an expectation MUST NOT appear in any wire message. Nothing
   * here signs anything or queues anything for transport — that is the whole point of the
   * object's existence.
   */
  expect(input: ExpectInput): ExpectOutput {
    const persona = this.activePersona;
    const expectation: Expectation = {
      v: PROTOCOL_VERSION,
      type: 'expectation',
      expect: input.expect,
      from: input.from,
      since: this.now().toISOString(),
      context_refs: input.context ? [{ kind: 'file', value: input.context }] : [],
      state: 'open',
    };
    const id = hashCanonical(expectation);
    this.vault.putExpectation(persona, id, expectation);
    return { expectation_id: id };
  }

  // ── §7 confirm ──────────────────────────────────────────────────────────────────────────

  /**
   * §7 `confirm` — serves both inbound proposals and the local extraction-confirmation queue.
   *
   * The id is routed by looking it up in the ordering-key index, which carries ids and their
   * persona but no content: finding out WHERE an id lives is routing, not the content mixing
   * M-5 forbids. Every read after the lookup is scoped to that one persona.
   */
  confirm(input: ConfirmInput): ConfirmOutput {
    const located = this.locate(input.id);
    if (located === null) throw new NodeError(`no such id in this vault: ${input.id}`);

    if (located.kind === 'pending') return this.confirmPending(located.persona, input);
    return this.confirmEdge(located.persona, input);
  }

  private confirmPending(persona: string, input: ConfirmInput): ConfirmOutput {
    const pending = this.vault.getPending(persona, input.id);
    if (!pending) throw new NodeError(`no such pending extraction: ${input.id}`);

    if (input.decision === 'dismiss') {
      this.vault.deletePending(persona, input.id);
      return { state: 'dismissed' };
    }

    const candidate = { ...(pending.candidate as unknown as Commitment) };
    // §3.4: extraction results are `source: "extracted"` and stay so; confirming is a human
    // act on the record, not a rewrite of its provenance.
    if (candidate.owner !== persona) {
      throw new M1Violation(
        'M-1: an extracted record whose owner is another person is an expectation, not a ' +
          'commitment this node may confirm on their behalf.',
      );
    }
    if (input.decision === 'edit' && input.edit) {
      if (input.edit.intent !== undefined) candidate.intent = input.edit.intent;
      if (input.edit.due !== undefined) candidate.due = input.edit.due;
    }
    this.vault.putCommitment(persona, candidate);
    this.vault.deletePending(persona, input.id);
    return { state: input.decision === 'edit' ? 'revised' : 'confirmed' };
  }

  private confirmEdge(persona: string, input: ConfirmInput): ConfirmOutput {
    const edge = this.vault.getEdge(persona, input.id);
    if (!edge) throw new NodeError(`no such edge: ${input.id}`);

    if (input.decision === 'dismiss') {
      // §6.5: a proposed edge is socially nothing. Dismissal produces no assertion — there is
      // no "rejected" state in §4.3, and inventing one would be a protocol change.
      const meta = this.vault.getEdgeMeta(persona, input.id);
      this.vault.putEdgeMeta(persona, { ...meta, dismissed: true });
      return { state: 'dismissed' };
    }

    if (input.decision === 'edit') {
      // §4.5: content changes to a live edge require supersession (new commitment_hash, new
      // edge, both parties signing). `edit` cannot do it silently.
      throw new NodeError(
        '§4.5: an edge’s content cannot be edited in place; changing it requires supersession.',
      );
    }

    if (edge.owner === persona) {
      throw new M2Violation(
        'M-2: the counterparty’s signature is what makes an edge exist. An owner cannot ' +
          'confirm their own proposal.',
      );
    }
    if (edge.owed_to !== persona) {
      throw new NodeError('M-3: only a party to the edge may assert on it.');
    }

    const assertion = this.signAssertion(
      persona,
      edge.edge_id,
      'confirmed',
      this.now().toISOString(),
      null,
    );
    // The node validates its OWN assertion against the table before storing it. A node that
    // trusts itself is a node that can write an invalid chain (M-14).
    const chain = [...this.vault.getAssertions(persona, edge.edge_id), assertion];
    const verification = verifyAssertionChain(edge, chain);
    const last = verification.outcomes[verification.outcomes.length - 1];
    if (!last || !last.accepted) {
      throw new NodeError(
        `M-14: refusing to record an invalid assertion (${last?.rejection_reason ?? 'unknown'})`,
      );
    }
    this.vault.appendAssertion(persona, assertion);
    return { state: 'confirmed' };
  }

  /**
   * §7 `act` — the sixth tool, and the only one that signs an assertion.
   *
   * `done` is the owner's act and asserts `closed`; `release` is the counterparty's and asserts
   * `released`. Nothing else reaches this tool: the four advertised-but-unbound acts and the two
   * that belong to `confirm` are refused by name, so a client that offers them learns here rather
   * than by watching an assertion silently fail to appear.
   *
   * State legality is NOT decided here. The candidate assertion is signed, run through
   * `verifyAssertionChain`, and only appended if the table accepts it — the same self-distrust
   * `confirm` practises, and the reason `illegal-source-state` and `acceptance-window-not-elapsed`
   * need no second implementation. A refused call appends nothing, so the chain keeps no trace of
   * it (§7: a rejected call leaves no trace).
   */
  act(input: ActInput): ActOutput {
    const refuse = (reason: ActRejectionReason): ActOutput => ({
      accepted: false,
      rejection_reason: reason,
      asserts: null,
    });

    const located = this.locate(input.id);
    if (located === null) throw new NodeError(`no such id in this vault: ${input.id}`);
    const persona = located.persona;

    const edge = this.vault.getEdge(persona, input.id);
    if (!edge) throw new NodeError(`no such edge: ${input.id}`);

    // M-3: a non-party has no standing at all, whatever they asked for.
    if (edge.owner !== persona && edge.owed_to !== persona) return refuse('not-a-party');

    if (ACT_TOOL_BINDINGS[input.act] !== 'act') return refuse('act-not-bound-to-a-tool');

    // `release` is the protocol's one unilateral act and it belongs to the party owed. Accepting
    // it from the owner would let a debtor forgive their own debt.
    const requiredRole = input.act === 'done' ? edge.owner : edge.owed_to;
    if (persona !== requiredRole) return refuse('wrong-role-for-act');

    if (input.act === 'release' && input.evidence_hash !== null) {
      // Releasing is giving up a claim, not evidencing delivery. Evidence here would record a
      // closure that never happened as though it had been performed.
      return refuse('evidence-hash-must-be-null');
    }

    const asserts = input.act === 'done' ? 'closed' : 'released';
    const assertion = this.signAssertion(
      persona,
      edge.edge_id,
      asserts,
      this.now().toISOString(),
      input.evidence_hash,
    );

    const chain = [...this.vault.getAssertions(persona, edge.edge_id), assertion];
    const verification = verifyAssertionChain(edge, chain);
    const last = verification.outcomes[verification.outcomes.length - 1];
    if (!last || !last.accepted) {
      const reason = last?.rejection_reason;
      return refuse(reason ? ACT_REJECTION[reason] : 'illegal-source-state');
    }

    this.vault.appendAssertion(persona, assertion);
    return { accepted: true, rejection_reason: null, asserts };
  }

  /**
   * Routing lookup: which persona holds this id, and what kind of thing is it.
   * The active persona is checked first — "confirm this" means "as me", and both parties to an
   * edge legitimately hold the same edge_id.
   */
  private locate(id: string): { persona: string; kind: OrderingKey['kind'] | 'pending' } | null {
    for (const key of this.vault.listOrderingKeys(this.activePersona)) {
      if (key.id === id) return { persona: key.persona, kind: key.kind };
    }
    if (this.vault.getPending(this.activePersona, id)) {
      return { persona: this.activePersona, kind: 'pending' };
    }
    for (const key of this.vault.listOrderingKeysAcrossPersonas()) {
      if (key.id === id) return { persona: key.persona, kind: key.kind };
    }
    for (const persona of this.vault.listPersonaIds()) {
      if (this.vault.getPending(persona, id)) return { persona, kind: 'pending' };
    }
    return null;
  }

  // ── edge state ──────────────────────────────────────────────────────────────────────────

  /** The effective state of an edge from its stored chain (§4.2: latest valid assertion). */
  /**
   * Has the acceptance window run out for this edge, as of `now`?
   *
   * Only `pending-acceptance` has a window to run, and only then does the owner gain `done`. The
   * clock is passed in rather than read here so `actionsFor` stays deterministic — the vectors
   * supply `window_elapsed` as an input for exactly this reason.
   */
  private acceptanceWindowElapsed(persona: string, edge: Edge, now: Date): boolean {
    if (edge.closure_policy !== 'on-acceptance' || edge.acceptance_window == null) return false;
    const chain = this.vault.getAssertions(persona, edge.edge_id);
    // §4.4: under on-acceptance the owner's `closed` assertion does not close — it opens the
    // window. That assertion's instant is when the clock started.
    const openedAt = chain.find((a) => a.state === 'closed' && a.by === edge.owner)?.asserted_at ?? null;
    if (openedAt === null) return false;
    return now.getTime() >= addDuration(new Date(Date.parse(openedAt)), edge.acceptance_window).getTime();
  }

  edgeState(persona: string, edge_id: string): ChainVerification {
    const edge = this.vault.getEdge(persona, edge_id);
    if (!edge) throw new NodeError(`no such edge: ${edge_id}`);
    return verifyAssertionChain(edge, this.vault.getAssertions(persona, edge_id));
  }

  /** M-8: edges this node may escalate on its own initiative — never undated, never unverifiable. */
  escalatable(persona: string): string[] {
    const now = this.now();
    return this.vault.listEdgeIds(persona).filter((id) => {
      const edge = this.vault.getEdge(persona, id);
      if (!edge) return false;
      return mayAutoEscalate(edge, this.edgeState(persona, id), now);
    });
  }

  // ── §1.6 verification level ─────────────────────────────────────────────────────────────

  /**
   * §1.6 binding proof ladder. Level 3 requires checking the org root's domain anchor (§1.5),
   * which is a network act; an L0–L1 node (M-10) can reach it only from a cached anchor
   * record, so an offline node with no cache tops out at level 2. Stated rather than faked.
   */
  verificationLevel(persona: string, counterparty: string | null): VerificationLevel {
    if (counterparty === null || !/^[0-9a-f]{64}$/.test(counterparty)) return '0';

    const attestation = this.vault.getAttestation(persona, counterparty);
    if (attestation) {
      const revocation = this.vault.getRevocation(persona, counterparty);
      const revoked =
        revocation !== null && Date.parse(revocation.revoked_at) <= Date.parse(this.now().toISOString());
      const expired = Date.parse(attestation.expires_at) < this.now().getTime();
      if (!revoked && !expired) {
        return this.vault.getDomainAnchor(persona, attestation.org) ? '3' : '2';
      }
    }
    // Level 1 continuity: ≥1 prior confirmed edge with this key.
    for (const id of this.vault.listEdgeIds(persona)) {
      const edge = this.vault.getEdge(persona, id);
      if (!edge) continue;
      if (edge.owner !== counterparty && edge.owed_to !== counterparty) continue;
      const state = this.edgeState(persona, id).final_state;
      if (state !== 'none' && state !== 'proposed') return '1';
    }
    return '0';
  }

  // ── M-11 ────────────────────────────────────────────────────────────────────────────────

  /**
   * M-11: "nodes and hubs MUST NOT compute, store, or serve cross-party fulfillment
   * statistics; clients MAY display only local pairwise history."
   *
   * So this is a LOCAL PAIRWISE counter and nothing else: it counts only edges the requesting
   * persona is itself a party to, and it refuses outright to answer about a pair that does not
   * include the requester. There is deliberately no aggregate, no rate, and no API that takes
   * two counterparties.
   */
  localPairwiseHistory(
    persona: string,
    counterparty: string,
  ): Record<'closed' | 'released' | 'expired' | 'disputed' | 'open', number> {
    const counts = { closed: 0, released: 0, expired: 0, disputed: 0, open: 0 };
    for (const id of this.vault.listEdgeIds(persona)) {
      const edge = this.vault.getEdge(persona, id);
      if (!edge) continue;
      const parties = [edge.owner, edge.owed_to];
      if (!parties.includes(persona)) {
        throw new M11Violation(
          'M-11: this vault holds an edge the requesting persona is not a party to; pairwise ' +
            'history is local-only and MUST NOT be computed over third-party edges.',
        );
      }
      if (!parties.includes(counterparty)) continue;
      const state = this.edgeState(persona, id).final_state;
      if (state === 'closed') counts.closed++;
      else if (state === 'released') counts.released++;
      else if (state === 'expired') counts.expired++;
      else if (state === 'disputed') counts.disputed++;
      else if (state === 'open' || state === 'pending-acceptance') counts.open++;
    }
    return counts;
  }

  // ── §7 open_loops ───────────────────────────────────────────────────────────────────────

  /**
   * §7 `open_loops`.
   *
   * NARROW READING (§7 + M-5): §7 says `persona:null` in **brief** is "the only place cross-org
   * ordering occurs". `open_loops` returns CONTENT, so a null persona here resolves to the
   * active persona rather than fanning out — the alternative would create a second cross-org
   * mixing point that §7 says does not exist.
   */
  openLoops(input: OpenLoopsInput): OpenLoopsOutput {
    const persona = this.resolvePersona(input.persona);
    const items = this.itemsFor(persona, input.view);
    return { items: items.slice(0, input.limit) };
  }

  private itemsFor(persona: string, view: OpenLoopsInput['view']): OpenLoopItem[] {
    const now = this.now();
    const out: OpenLoopItem[] = [];
    const edgeCommitments = new Set<string>();

    for (const id of this.vault.listEdgeIds(persona)) {
      const edge = this.vault.getEdge(persona, id);
      if (!edge) continue;
      edgeCommitments.add(edge.commitment_hash);
      if (this.vault.getEdgeMeta(persona, id).dismissed) continue;

      const state = this.edgeState(persona, id).final_state;
      const isOwner = edge.owner === persona;
      const counterparty = isOwner ? edge.owed_to : edge.owner;
      const live = state === 'open' || state === 'pending-acceptance' || state === 'proposed' ||
        state === 'disputed';

      if (view === 'owe' && !(isOwner && live)) continue;
      if (view === 'waiting' && !(!isOwner && live)) continue;
      if (view === 'closed' && live) continue;
      if (view === 'pending') continue; // the confirm queue is not an edge view

      const commitment = this.vault.getCommitment(persona, edge.commitment_hash);
      out.push({
        kind: 'edge',
        id,
        // M-15: after retention the plaintext is gone but the edge remains. What the record
        // said is unrecoverable; that it existed is not.
        intent_or_expect: commitment?.intent ?? NO_LOCAL_PLAINTEXT,
        counterparty,
        verification_level: this.verificationLevel(persona, counterparty),
        age_days: ageDays(edge.proposed_at, now),
        due: edge.due,
        state,
        actions: actionsFor({
          state,
          role: isOwner ? 'owner' : 'owed_to',
          edgeId: id,
          windowElapsed: this.acceptanceWindowElapsed(persona, edge, now),
        }),
      });
    }

    for (const { hash, commitment } of this.vault.listCommitments(persona)) {
      if (edgeCommitments.has(hash)) continue; // already surfaced as an edge
      if (view === 'waiting' || view === 'closed' || view === 'pending') continue;
      out.push({
        kind: 'commitment',
        id: hash,
        intent_or_expect: commitment.intent,
        counterparty: commitment.owed_to,
        verification_level: this.verificationLevel(persona, commitment.owed_to),
        age_days: ageDays(commitment.created_at, now),
        due: commitment.due,
        state: 'vault-local',
        // A vault-local commitment has no edge and no counterparty signature, so nothing here
        // signs anything. `propose` is the act that would change that, and v0 binds it to no
        // tool — said plainly rather than pointed at `commit` as though it were the same thing.
        actions: [{ act: 'propose', tool: null, args: {} }],
      });
    }

    // §7 `view: "pending"` — the extraction-confirmation queue, readable at last.
    //
    // The queue was writable through `confirm` and invisible through the surface: `confirm` takes
    // an id and nothing handed one out, so a client could act on a pending item only if it had
    // learned the id some other way. Upstream #27. `dismiss` is bound here alongside `confirm`
    // because a queue you can only say yes to is not a queue.
    if (view === 'pending' || view === 'all') {
      for (const pending of this.vault.listPending(persona)) {
        const candidate = pending.candidate as { intent?: string; owed_to?: string | null; due?: string | null };
        out.push({
          kind: 'commitment',
          id: pending.id,
          intent_or_expect: candidate.intent ?? NO_LOCAL_PLAINTEXT,
          counterparty: candidate.owed_to ?? null,
          verification_level: this.verificationLevel(persona, candidate.owed_to ?? null),
          age_days: ageDays(pending.queued_at, now),
          due: candidate.due ?? null,
          state: 'vault-local',
          actions: [
            { act: 'confirm', tool: 'confirm', args: { id: pending.id, decision: 'confirm' } },
            { act: 'dismiss', tool: 'confirm', args: { id: pending.id, decision: 'dismiss' } },
          ],
        });
      }
    }

    for (const { id, expectation } of this.vault.listExpectations(persona)) {
      if (view === 'owe' || view === 'pending') continue;
      if (view === 'waiting' && expectation.state !== 'open') continue;
      if (view === 'closed' && expectation.state !== 'closed') continue;
      out.push({
        kind: 'expectation',
        id,
        intent_or_expect: expectation.expect,
        counterparty: expectation.from,
        verification_level: this.verificationLevel(persona, expectation.from),
        age_days: ageDays(expectation.since, now),
        due: null,
        state: expectation.state,
        actions: expectation.state === 'open' ? [{ act: 'ping', tool: null, args: {} }] : [],
      });
    }

    return out;
  }

  // ── §7 brief ────────────────────────────────────────────────────────────────────────────

  /**
   * §7 `brief` — the attention market.
   *
   * `persona: null` is "the only place cross-org *ordering* occurs (§5.3 M-5: ordering yes,
   * content mixing no — each slot's content originates from exactly one persona's pipeline)".
   *
   * Implemented exactly that way: ranking runs over the vault's ORDERING KEYS, which carry no
   * content at all, and only after an item has won a slot is its headline fetched through that
   * one persona's scoped read. No stage ever holds two personas' content at once.
   */
  brief(input: BriefInput): BriefOutput {
    const now = this.now();
    const all =
      input.persona === null || input.persona === undefined
        ? this.vault.listOrderingKeysAcrossPersonas()
        : this.vault.listOrderingKeys(this.resolvePersona(input.persona));

    // The vault emits a key for a commitment AND a key for the edge built from it, so a proposed
    // promise arrived here twice: once as an edge, and once as a commitment whose only advertised
    // act is `propose` — on a record already proposed. `open_loops` has always dropped the second
    // (`edgeCommitments`); `brief` did not, and the two §7 read tools disagreed about how many
    // things were in the same vault. The comparison is per-persona and over hashes, so no content
    // and no persona boundary is crossed.
    const withEdges = new Map<string, Set<string>>();
    const supersededByAnEdge = (key: OrderingKey): boolean => {
      if (key.kind !== 'commitment') return false;
      let hashes = withEdges.get(key.persona);
      if (!hashes) {
        hashes = new Set(
          this.vault
            .listEdgeIds(key.persona)
            .map((id) => this.vault.getEdge(key.persona, id)?.commitment_hash)
            .filter((hash): hash is string => hash !== undefined),
        );
        withEdges.set(key.persona, hashes);
      }
      return hashes.has(key.id);
    };

    const ranked = all
      .filter((key) => !supersededByAnEdge(key))
      .map((key) => ({ key, rank: rank(key, now) }))
      .sort((a, b) => b.rank.score - a.rank.score);

    const chosen = ranked.slice(0, this.briefSlots);
    const slots: BriefSlot[] = [];
    for (const { key } of chosen) {
      // Single-persona content fetch. This is the boundary M-5 protects.
      const slot = this.slotFor(key);
      if (slot) slots.push(slot);
    }

    return {
      generated_at: now.toISOString(),
      slots,
      below_the_line_count: Math.max(0, ranked.length - slots.length),
    };
  }

  private slotFor(key: OrderingKey): BriefSlot | null {
    const persona = key.persona;
    if (key.kind === 'edge') {
      const edge = this.vault.getEdge(persona, key.id);
      if (!edge) return null;
      const state = this.edgeState(persona, key.id).final_state;
      const commitment = this.vault.getCommitment(persona, edge.commitment_hash);
      const isOwner = edge.owner === persona;
      const headline = commitment?.intent ?? NO_LOCAL_PLAINTEXT;
      return {
        headline,
        item_id: key.id,
        // The same act vocabulary open_loops advertises, so a client has one act→copy mapping.
        // The old shape said `label: 'Mark done'` pointed at `confirm` — wording supplied by the
        // node (M-21), aimed at a tool that would not have marked anything done (M-20).
        primary_action: primaryActionOf(
          actionsFor({
            state,
            role: isOwner ? 'owner' : 'owed_to',
            edgeId: key.id,
            windowElapsed: this.acceptanceWindowElapsed(persona, edge, this.now()),
          }),
        ),
        persona,
      };
    }
    if (key.kind === 'commitment') {
      const commitment = this.vault.getCommitment(persona, key.id);
      if (!commitment) return null;
      return {
        headline: commitment.intent,
        item_id: key.id,
        // v0 binds `propose` to no tool. Saying so beats pointing at `commit`, which would
        // create a second commitment rather than propose this one.
        primary_action: { act: 'propose', tool: null, args: {} },
        persona,
      };
    }
    const expectation = this.vault.getExpectation(persona, key.id);
    if (!expectation) return null;
    return {
      headline: expectation.expect,
      item_id: key.id,
      primary_action: { act: 'ping', tool: null, args: {} },
      persona,
    };
  }

  // ── extraction queue plumbing (used by the extraction stream) ───────────────────────────

  queuePendingExtraction(persona: string, candidate: Commitment, envelopeId: string | null): string {
    const id = hashCanonical({ candidate, envelopeId, persona });
    const item: PendingExtraction = {
      v: PROTOCOL_VERSION,
      type: 'pending_extraction',
      id,
      persona,
      candidate: candidate as unknown as Record<string, unknown>,
      envelope_id: envelopeId,
      queued_at: this.now().toISOString(),
    };
    this.vault.putPending(item);
    return id;
  }
}

function ageDays(since: string, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(since)) / 86_400_000);
}

/**
 * The primary affordance for a brief slot: the one act that signs, if there is one.
 *
 * `actionsFor` returns them in the order §7 advertises; the first with a tool is the one a person
 * would reach for. When nothing signs — a proposed edge from the owner's side, a terminal item —
 * the slot says so with `null` rather than offering a control that does nothing.
 */
function primaryActionOf(actions: ItemAction[]): ItemAction | null {
  return actions.find((a) => a.tool !== null) ?? null;
}
