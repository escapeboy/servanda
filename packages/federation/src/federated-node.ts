import type { Assertion, WireMessage } from '@servanda/types';
import type { Vault } from '@servanda/vault';
import type { ProposalBudget } from './antispam.js';
import { Inbox, type IngestResult } from './inbox.js';
import { messageId, signMessage, verifyMessage } from './messages.js';
import { answerReconRequest, buildReconRequest, type ReconRequest } from './recon.js';
import { currentKeyOf, isPartyOrSuccessor, partyLineage } from './serve.js';
import type { Transport } from './transport.js';
import type { VerificationLevel } from '@servanda/types';

/**
 * §8 "Federating node": an L1 node plus one transport, reconciliation, and a recovery
 * responder. This class is the seam between them and nothing more — every rule it depends on
 * lives in the module that owns it, so the same behaviour holds when a client wires the pieces
 * together differently.
 *
 * §6.7: "Delivery is optimization; reconciliation is the guarantee." `push`/`pull` may lose or
 * duplicate anything; `reconcile` is what makes both sides converge.
 */

export interface FederatedNodeOptions {
  vault: Vault;
  persona: string;
  transport: Transport;
  budget?: ProposalBudget;
  verificationLevel?: (counterparty: string) => VerificationLevel;
  now?: () => Date;
}

export class FederatedNode {
  readonly vault: Vault;
  readonly persona: string;
  readonly transport: Transport;
  readonly inbox: Inbox;
  private readonly clock: () => Date;
  /** Content addresses handed to the transport, so a re-`push` is not a re-send. */
  private readonly sent = new Set<string>();
  /** Assertion signatures already on the wire, whether inside a `propose` or an `assert`. */
  private readonly sentAssertions = new Set<string>();

  constructor(opts: FederatedNodeOptions) {
    this.vault = opts.vault;
    this.persona = opts.persona;
    this.transport = opts.transport;
    this.clock = opts.now ?? (() => new Date());
    this.inbox = new Inbox({
      vault: opts.vault,
      persona: opts.persona,
      budget: opts.budget,
      verificationLevel: opts.verificationLevel,
    });
  }

  // §6.2: the recipient is signed, so signing and addressing happen in one place. Separating
  // them is how a message ends up signed for one persona and sent to another.
  private sign(type: WireMessage['type'], recipient: string, payload: unknown): WireMessage {
    return signMessage(
      type,
      payload,
      this.persona,
      recipient,
      this.clock().toISOString(),
      this.vault.getPersona(this.persona).private_key,
    );
  }

  private async emit(recipient: string, message: WireMessage): Promise<boolean> {
    if (message.recipient !== recipient) {
      // Belt and braces on the invariant above: a message signed for one persona must never be
      // handed to a transport addressed to another.
      throw new Error(`§6.2: message signed for ${message.recipient} cannot be sent to ${recipient}`);
    }
    const id = messageId(message);
    if (this.sent.has(id)) return false;
    // Marked sent only once the transport ACCEPTED it. Marking first meant a hub that answered
    // 503 — the one case store-and-forward exists for — was recorded as a successful delivery:
    // the next `push` skipped the message for the life of the process, and for a `propose` there
    // is no second chance, because §6.4 reconciliation "never introduces an edge". A promise made
    // during a five-minute outage was never delivered, and the owner's register read `proposed`
    // for ever, indistinguishable from a counterparty ignoring it.
    await this.transport.send(recipient, message);
    this.sent.add(id);
    return true;
  }

  /**
   * Hand the transport everything this node owes its counterparties: the `propose` messages L1
   * queued in the vault outbox, and every assertion held for a shared edge that has not gone
   * out yet.
   *
   * Re-sending an assertion the peer already holds is harmless (they deduplicate by `sig`) and
   * is the cheap half of §6.7's store-and-forward model; the expensive half is `reconcile`.
   */
  async push(): Promise<number> {
    let n = 0;

    for (const item of this.vault.listOutbox(this.persona)) {
      const message = verifyMessage(item.message);
      if (!message) continue; // a queued message that no longer verifies is not sent
      if (await this.emit(item.recipient, message)) n++;
      const assertion = (message.payload as { assertion?: Assertion } | null)?.assertion;
      // The `propose` already carries this assertion; do not send it twice.
      if (assertion) this.sentAssertions.add(assertion.sig);
    }

    const lineage = partyLineage(this.vault, this.persona);
    for (const edgeId of this.vault.listEdgeIds(this.persona)) {
      const edge = this.vault.getEdge(this.persona, edgeId);
      if (!edge || !isPartyOrSuccessor(edge, this.persona, lineage)) continue;
      const named = edge.owner === this.persona ? edge.owed_to : edge.owner;
      // §1.7: address the key the counterparty holds NOW. The edge body is immutable (§4.1) and
      // still names the key they had, so sending to `named` after they rotated posts every act
      // this side takes to a persona nobody is reading — the conversation goes one-way and neither
      // register says why.
      const counterparty = currentKeyOf(named, lineage);
      for (const assertion of this.vault.getAssertions(this.persona, edgeId)) {
        // Only our own assertions: relaying the counterparty's own signature back to them adds
        // nothing, and relaying it to a third party would be an M-4a leak.
        if (assertion.by !== this.persona) continue;
        if (this.sentAssertions.has(assertion.sig)) continue;
        this.sentAssertions.add(assertion.sig);
        if (await this.emit(counterparty, this.sign('assert', counterparty, { assertion }))) n++;
      }
    }

    await this.transport.sync();
    return n;
  }

  /** Sync with the medium, take delivery, and run everything through the inbox. */
  async pull(): Promise<IngestResult> {
    await this.transport.sync();
    return this.inbox.ingest(await this.transport.receive(this.persona));
  }

  /** §6.4: ask a counterparty for anything we are missing on our shared open edges. */
  async requestRecon(counterparty: string): Promise<ReconRequest> {
    const request = buildReconRequest(this.vault, this.persona, counterparty);
    await this.emit(counterparty, this.sign('recon_request', counterparty, request));
    await this.transport.sync();
    return request;
  }

  /** §6.4 responder side. M-4a is applied inside `answerReconRequest`, not here. */
  async answerRecon(requests: { from: string; request: ReconRequest }[]): Promise<number> {
    let n = 0;
    for (const { from, request } of requests) {
      const response = answerReconRequest(this.vault, this.persona, from, request);
      if (response.edges.length === 0) continue;
      if (await this.emit(from, this.sign('recon_response', from, response))) n++;
    }
    await this.transport.sync();
    return n;
  }
}
