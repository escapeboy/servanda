import type { Assertion, WireMessage } from '@servanda/types';
import type { Vault } from '@servanda/vault';
import type { ProposalBudget } from './antispam.js';
import { Inbox, type IngestResult } from './inbox.js';
import { messageId, signMessage, verifyMessage } from './messages.js';
import { answerReconRequest, buildReconRequest, type ReconRequest } from './recon.js';
import { isParty } from './serve.js';
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

  private sign(type: WireMessage['type'], payload: unknown): WireMessage {
    return signMessage(
      type,
      payload,
      this.persona,
      this.clock().toISOString(),
      this.vault.getPersona(this.persona).private_key,
    );
  }

  private async emit(recipient: string, message: WireMessage): Promise<boolean> {
    const id = messageId(message);
    if (this.sent.has(id)) return false;
    this.sent.add(id);
    await this.transport.send(recipient, message);
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

    for (const edgeId of this.vault.listEdgeIds(this.persona)) {
      const edge = this.vault.getEdge(this.persona, edgeId);
      if (!edge || !isParty(edge, this.persona)) continue;
      const counterparty = edge.owner === this.persona ? edge.owed_to : edge.owner;
      for (const assertion of this.vault.getAssertions(this.persona, edgeId)) {
        // Only our own assertions: relaying the counterparty's own signature back to them adds
        // nothing, and relaying it to a third party would be an M-4a leak.
        if (assertion.by !== this.persona) continue;
        if (this.sentAssertions.has(assertion.sig)) continue;
        this.sentAssertions.add(assertion.sig);
        if (await this.emit(counterparty, this.sign('assert', { assertion }))) n++;
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
    await this.emit(counterparty, this.sign('recon_request', request));
    await this.transport.sync();
    return request;
  }

  /** §6.4 responder side. M-4a is applied inside `answerReconRequest`, not here. */
  async answerRecon(requests: { from: string; request: ReconRequest }[]): Promise<number> {
    let n = 0;
    for (const { from, request } of requests) {
      const response = answerReconRequest(this.vault, this.persona, from, request);
      if (response.edges.length === 0) continue;
      if (await this.emit(from, this.sign('recon_response', response))) n++;
    }
    await this.transport.sync();
    return n;
  }
}
