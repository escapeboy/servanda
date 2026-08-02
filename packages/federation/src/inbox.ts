import { edgeIdBindsBody, hashCanonical } from '@servanda/crypto';
import { verifyAssertionChain } from '@servanda/node';
import type { Assertion, Edge, VerificationLevel, WireMessage } from '@servanda/types';
import { AssertPayload, ProposePayload } from '@servanda/types';
import type { Vault } from '@servanda/vault';
import type { ProposalBudget } from './antispam.js';
import { edgeIdOf, verifyMessage } from './messages.js';
import {
  applyReconResponse,
  inWireOrder,
  ReconRequestSchema,
  ReconResponseSchema,
  type ReconApplyResult,
  type ReconRequest,
} from './recon.js';
import { RecoverRequestSchema, RecoverResponseSchema, type RecoverRequest, type RecoverResponse } from './recovery.js';
import { isParty } from './serve.js';

/**
 * The inbound half of federation: everything that arrives over a transport passes through here
 * before it can touch the vault.
 *
 * Three rules apply in order, and none of them is negotiable by the sender:
 *  1. the message signature must verify under the key it names as `sender` (§6.3);
 *  2. the recipient must be a party to what the message is about (M-4a — a proposal addressed
 *     to someone else is not stored, whoever delivered it);
 *  3. every assertion goes through `verifyAssertionChain`, and whatever it rejects is discarded
 *     (M-14). The wire is the least trusted input in the system; it gets the same table the
 *     node applies to its own assertions, not a lenient variant.
 */

export type DiscardReason =
  | 'signature-does-not-verify'
  /** §6.2: it verifies, and it was signed for somebody else. Not the same failure. */
  | 'addressed-to-another-persona'
  | 'malformed-payload'
  | 'not-addressed-to-this-persona'
  | 'proposer-is-not-the-owner'
  /** §4.1: the identifier is not the digest of the body it arrived attached to. */
  | 'edge-id-does-not-bind-body'
  /** §4.1: an identifier is bound to the first body accepted for it, and this is not it. */
  | 'edge-body-differs-from-held'
  | 'unknown-edge'
  | 'sender-is-not-a-party'
  | `transition-table:${string}`;

export interface IngestResult {
  accepted: { type: WireMessage['type']; edge_id: string | null }[];
  discarded: { type: string; edge_id: string | null; reason: DiscardReason }[];
  /** §6.5: admitted by every rule above, but over the client's budget, so never surfaced. */
  suppressed: { sender: string; edge_id: string; reason: 'rate-limited' | 'level-0-cap-reached' }[];
  /** Requests needing an answer the caller must route back over a transport. */
  reconRequests: { from: string; request: ReconRequest }[];
  recoverRequests: { from: string; request: RecoverRequest }[];
  /** Result of applying any `recon_response` in this batch. */
  recon: ReconApplyResult;
}

/**
 * §4.1: "A node MUST bind an `edge_id` to the first edge body it accepts for that identifier,
 * and MUST reject any subsequent edge body bearing the same `edge_id` whose other members
 * differ, with the whole body discarded rather than merged."
 *
 * The two failures are reported apart because they are different events. The first is a
 * fabricated identifier and can only be hostile — nothing honest produces one. The second is
 * what a party sees when the counterparty's body and its own have drifted, which §4.1 makes an
 * M-8 unverifiability rather than an accusation.
 */
export function edgeBindingFailure(vault: Vault, persona: string, edge: Edge): DiscardReason | null {
  if (!edgeIdBindsBody(edge)) return 'edge-id-does-not-bind-body';
  const held = vault.getEdge(persona, edge.edge_id);
  if (!held) return null;
  const canon = (e: Edge) => hashCanonical(e as unknown as Record<string, unknown>);
  return canon(held) === canon(edge) ? null : 'edge-body-differs-from-held';
}

export interface InboxOptions {
  vault: Vault;
  persona: string;
  /** §6.5 budget. Without one, no proposal is suppressed — the cap is the client's to set. */
  budget?: ProposalBudget;
  /** §1.6 level of a counterparty, used only by the §6.5 budget. */
  verificationLevel?: (counterparty: string) => VerificationLevel;
}

function emptyResult(): IngestResult {
  return {
    accepted: [],
    discarded: [],
    suppressed: [],
    reconRequests: [],
    recoverRequests: [],
    recon: { accepted: [], discarded: [], ignored: [] },
  };
}

export class Inbox {
  private readonly vault: Vault;
  private readonly persona: string;
  private readonly budget: ProposalBudget | undefined;
  private readonly level: (counterparty: string) => VerificationLevel;

  constructor(opts: InboxOptions) {
    this.vault = opts.vault;
    this.persona = opts.persona;
    this.budget = opts.budget;
    this.level = opts.verificationLevel ?? (() => '0');
  }

  ingest(messages: WireMessage[]): IngestResult {
    const result = emptyResult();
    for (const raw of messages) {
      // Re-verified even though transports verify: this class is the security boundary, and a
      // boundary that trusts its caller is not one.
      const message = verifyMessage(raw as unknown);
      if (!message) {
        result.discarded.push({ type: 'unknown', edge_id: null, reason: 'signature-does-not-verify' });
        continue;
      }
      // §6.2, and it gets its own reason rather than being folded into the line above: a message
      // that verifies perfectly and is addressed to somebody else is a re-sealed message, not a
      // corrupt one, and an operator reading a discard log needs to be able to tell those apart.
      // Checked before the type is even looked at, so it holds for every type there will ever be
      // — including the ones whose payload carries no party of its own.
      if (message.recipient !== this.persona) {
        result.discarded.push({
          type: message.type,
          edge_id: edgeIdOf(message),
          reason: 'addressed-to-another-persona',
        });
        continue;
      }
      switch (message.type) {
        case 'propose':
          this.ingestPropose(message, result);
          break;
        case 'assert':
          this.ingestAssert(message, result);
          break;
        case 'recon_request': {
          const parsed = ReconRequestSchema.safeParse(message.payload);
          if (!parsed.success) {
            result.discarded.push({ type: message.type, edge_id: null, reason: 'malformed-payload' });
            break;
          }
          result.reconRequests.push({ from: message.sender, request: parsed.data });
          break;
        }
        case 'recon_response': {
          const parsed = ReconResponseSchema.safeParse(message.payload);
          if (!parsed.success) {
            result.discarded.push({ type: message.type, edge_id: null, reason: 'malformed-payload' });
            break;
          }
          const applied = applyReconResponse(this.vault, this.persona, message.sender, parsed.data);
          result.recon.accepted.push(...applied.accepted);
          result.recon.discarded.push(...applied.discarded);
          result.recon.ignored.push(...applied.ignored);
          break;
        }
        case 'recover_request': {
          const parsed = RecoverRequestSchema.safeParse(message.payload);
          if (!parsed.success) {
            result.discarded.push({ type: message.type, edge_id: null, reason: 'malformed-payload' });
            break;
          }
          result.recoverRequests.push({ from: message.sender, request: parsed.data as RecoverRequest });
          break;
        }
        case 'recover_response':
          // §6.6 responses restore edges this node lost. Applying them is a distinct act with
          // its own trust decision (the requester chose whom to ask), so it is not folded into
          // routine ingestion; `applyRecoverResponse` is called explicitly. What ingestion still
          // owes the caller is that an `accepted` recover_response is one whose payload is
          // actually a recover_response — otherwise "accepted" means only "signed".
          if (!RecoverResponseSchema.safeParse(message.payload).success) {
            result.discarded.push({ type: message.type, edge_id: null, reason: 'malformed-payload' });
            break;
          }
          result.accepted.push({ type: message.type, edge_id: null });
          break;
        default:
          // publish/unpublish/attestation/revocation/rotation are §5 and §1 objects; this layer
          // carries them but does not own their storage rules.
          result.accepted.push({ type: message.type, edge_id: null });
      }
    }
    return result;
  }

  /**
   * §4.1 body binding, as the two ways it can fail. Null means the edge may be read.
   *
   * Shared with `applyRecoverResponse` below rather than duplicated: a §6.6 responder chooses
   * what it hands back, so an edge arriving through recovery is exactly as unattested as one
   * arriving through a propose — and the restoring node, having lost its own copy, has nothing
   * to compare against except the identifier.
   */
  private bindingFailure(edge: Edge): DiscardReason | null {
    return edgeBindingFailure(this.vault, this.persona, edge);
  }

  private ingestPropose(message: WireMessage, result: IngestResult): void {
    const parsed = ProposePayload.safeParse(message.payload);
    if (!parsed.success) {
      result.discarded.push({ type: 'propose', edge_id: null, reason: 'malformed-payload' });
      return;
    }
    const { edge, assertion } = parsed.data as { edge: Edge; assertion: Assertion };

    // §4.1, before any other rule about this edge, because every one of them reads the body to
    // decide — and until the identifier is known to digest the body, "the body" is whatever the
    // sender wanted the checks to see. An unbound edge passed M-1 and M-4a on its own members
    // while its chain was filed under somebody else's identifier.
    const bound = this.bindingFailure(edge);
    if (bound) {
      result.discarded.push({ type: 'propose', edge_id: edge.edge_id, reason: bound });
      return;
    }

    // M-4a: a proposal is addressed to the counterparty named in the edge. Delivery to anyone
    // else — by a curious hub, a shared repository, or a hostile sender — stores nothing.
    if (edge.owed_to !== this.persona) {
      result.discarded.push({ type: 'propose', edge_id: edge.edge_id, reason: 'not-addressed-to-this-persona' });
      return;
    }
    // M-1: a promise is owned by its giver, so the proposer must BE the owner.
    if (message.sender !== edge.owner) {
      result.discarded.push({ type: 'propose', edge_id: edge.edge_id, reason: 'proposer-is-not-the-owner' });
      return;
    }

    // M-14 before anything is written: an invalid `proposed` assertion never creates an edge.
    const { outcomes } = verifyAssertionChain(edge, [assertion]);
    const outcome = outcomes[0]!;
    if (!outcome.accepted) {
      result.discarded.push({
        type: 'propose',
        edge_id: edge.edge_id,
        reason: `transition-table:${outcome.rejection_reason}` as DiscardReason,
      });
      return;
    }

    // §6.5 last, so a rejected proposal never consumes budget.
    if (this.budget) {
      const admission = this.budget.admit(message.sender, this.level(message.sender));
      if (!admission.surface) {
        result.suppressed.push({ sender: message.sender, edge_id: edge.edge_id, reason: admission.reason });
        return;
      }
    }

    this.vault.putEdge(this.persona, edge);
    if (!this.vault.getAssertions(this.persona, edge.edge_id).some((a) => a.sig === assertion.sig)) {
      this.vault.appendAssertion(this.persona, assertion);
    }
    result.accepted.push({ type: 'propose', edge_id: edge.edge_id });
  }

  private ingestAssert(message: WireMessage, result: IngestResult): void {
    const parsed = AssertPayload.safeParse(message.payload);
    if (!parsed.success) {
      result.discarded.push({ type: 'assert', edge_id: null, reason: 'malformed-payload' });
      return;
    }
    const assertion = parsed.data.assertion as Assertion;
    const edge = this.vault.getEdge(this.persona, assertion.edge_id);
    if (!edge) {
      result.discarded.push({ type: 'assert', edge_id: assertion.edge_id, reason: 'unknown-edge' });
      return;
    }
    if (!isParty(edge, this.persona)) {
      result.discarded.push({ type: 'assert', edge_id: edge.edge_id, reason: 'not-addressed-to-this-persona' });
      return;
    }
    if (!isParty(edge, message.sender)) {
      result.discarded.push({ type: 'assert', edge_id: edge.edge_id, reason: 'sender-is-not-a-party' });
      return;
    }

    const local = this.vault.getAssertions(this.persona, edge.edge_id);
    if (local.some((a) => a.sig === assertion.sig)) return; // transports may replay

    const { outcomes } = verifyAssertionChain(edge, [...local, assertion]);
    const outcome = outcomes[local.length]!;
    if (!outcome.accepted) {
      result.discarded.push({
        type: 'assert',
        edge_id: edge.edge_id,
        reason: `transition-table:${outcome.rejection_reason}` as DiscardReason,
      });
      return;
    }
    this.vault.appendAssertion(this.persona, assertion);
    result.accepted.push({ type: 'assert', edge_id: edge.edge_id });
  }
}

/**
 * §6.6: apply a recovery response. Edges arrive with their chains; each chain is replayed
 * through the transition table so a responder cannot hand back a state we would not have
 * reached ourselves.
 *
 * Replaying is not enough on its own: the table is order-sensitive, so a responder that handed
 * back a chain in a chosen order chose the state we recovered into. Reversing an honest
 * `[proposed, accepted]` left the restored node at `proposed` with the acceptance discarded.
 * `inWireOrder` is the same normalisation §6.4 applies, and for the same reason.
 */
export function applyRecoverResponse(vault: Vault, persona: string, response: RecoverResponse): {
  restored: string[];
  discarded: { edge_id: string; index: number; reason: string }[];
} {
  const restored: string[] = [];
  const discarded: { edge_id: string; index: number; reason: string }[] = [];
  for (const { edge, assertions } of response.edges) {
    if (!isParty(edge, persona)) continue;
    // §4.1 before the chain is even looked at. A responder chooses what it returns, and a node
    // that lost its vault is in the worst position to notice: it holds nothing to compare the
    // body against, so the identifier digesting its own body is the only check left standing.
    const bound = edgeBindingFailure(vault, persona, edge);
    if (bound) {
      discarded.push({ edge_id: edge.edge_id, index: -1, reason: bound });
      continue;
    }
    vault.putEdge(persona, edge);
    const local = vault.getAssertions(persona, edge.edge_id);
    const held = new Set(local.map((a) => a.sig));
    const incoming = assertions.filter((a) => !held.has(a.sig)).sort(inWireOrder);
    const { outcomes } = verifyAssertionChain(edge, [...local, ...incoming]);
    for (let i = 0; i < incoming.length; i++) {
      const outcome = outcomes[local.length + i]!;
      if (outcome.accepted) vault.appendAssertion(persona, incoming[i]!);
      else discarded.push({ edge_id: edge.edge_id, index: outcome.index, reason: outcome.rejection_reason! });
    }
    restored.push(edge.edge_id);
  }
  return { restored, discarded };
}
