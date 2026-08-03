import type { Assertion, WireMessage } from '@servanda/types';
import type { OutboxItem, Vault } from '@servanda/vault';
import type { ProposalBudget } from './antispam.js';
import { Inbox, type IngestResult } from './inbox.js';
import { edgeIdOf, messageId, signMessage, verifyMessage } from './messages.js';
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
  /** The courier this node collects from, and the default for everyone it writes to. */
  transport: Transport;
  /**
   * Which courier reaches which counterparty — §6.1 per-recipient routing.
   *
   * Without it, one node speaks exactly one transport, so a person on a shared git repository
   * and a person on an HTTPS hub cannot reach each other however correct both nodes are. With
   * it, a node holds several couriers and picks per recipient.
   *
   * Returning `null` says THIS NODE HAS NO ADDRESS for that persona. That is not an error to
   * swallow and not a queue to retry: nothing will change until a route is configured, so it is
   * recorded on the outbox item as `unroutable_since` and reported — which is the only way a
   * person learns their promise cannot arrive rather than merely has not yet.
   *
   * Omitted, every recipient routes to `transport`, which is what every existing caller means.
   */
  routeFor?: (recipient: string) => Transport | null;
  budget?: ProposalBudget;
  verificationLevel?: (counterparty: string) => VerificationLevel;
  now?: () => Date;
}

/** One recipient this `push` could not reach, and what refused. */
export interface DeliveryFailure {
  /** The outbox item, or null for an assertion, which is held on the edge rather than queued. */
  outbox_id: string | null;
  recipient: string;
  message_type: WireMessage['type'];
  /** The courier that refused, or null when there was no courier to ask. */
  transport: string | null;
  reason: string;
}

/**
 * Raised when a `push` finished with work undelivered.
 *
 * Thrown AFTER every other recipient has been attempted and every courier flushed, which is the
 * whole of the fix: the old loop threw from inside itself, so the first unreachable counterparty
 * abandoned the remaining messages AND skipped `sync()`, and healthy recipients starved behind a
 * broken one. Silence would have been worse than the starvation, so this still throws — a
 * failure a caller can ignore by accident is a promise that quietly never went anywhere.
 */
export class OutboundDeliveryError extends Error {
  override name = 'OutboundDeliveryError';
  constructor(
    readonly delivered: number,
    readonly failures: readonly DeliveryFailure[],
  ) {
    const who = failures.map((f) => `${f.recipient.slice(0, 16)}…: ${f.reason}`).join('; ');
    super(`${delivered} message(s) delivered, ${failures.length} could not be: ${who}`);
  }
}

/** Raised by `emit` when routing yields no courier. Carried into a `DeliveryFailure`. */
export class UnroutableRecipient extends Error {
  override name = 'UnroutableRecipient';
  constructor(readonly recipient: string) {
    super(
      `no courier on this node reaches ${recipient.slice(0, 16)}…; the message has not left this machine`,
    );
  }
}

/** What a person needs in order to know whether a promise they made ever went anywhere. */
export type OutboundState = 'queued' | 'unroutable' | 'sent' | 'acknowledged';

export interface OutboundStatus {
  id: string;
  recipient: string;
  edge_id: string | null;
  queued_at: string;
  state: OutboundState;
  sent_at: string | null;
  sent_via: string | null;
  acknowledged_at: string | null;
  attempts: number;
  last_error: string | null;
  /**
   * One sentence, in words, that says exactly what is known and refuses to imply more. This is
   * the surface the brief asks for: a person must be able to learn that a message will never
   * arrive, and why, without reading source.
   */
  explanation: string;
}

export class FederatedNode {
  readonly vault: Vault;
  readonly persona: string;
  readonly transport: Transport;
  readonly inbox: Inbox;
  private readonly clock: () => Date;
  private readonly routeFor: (recipient: string) => Transport | null;
  /** Content addresses handed to the transport, so a re-`push` is not a re-send. */
  private readonly sent = new Set<string>();
  /** Assertion signatures already on the wire, whether inside a `propose` or an `assert`. */
  private readonly sentAssertions = new Set<string>();

  constructor(opts: FederatedNodeOptions) {
    this.vault = opts.vault;
    this.persona = opts.persona;
    this.transport = opts.transport;
    this.clock = opts.now ?? (() => new Date());
    this.routeFor = opts.routeFor ?? (() => this.transport);
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

  /**
   * Route, then hand over.
   *
   * Returns the courier that accepted the message, or `null` when this process already handed the
   * same content address to one. Throws `UnroutableRecipient` when no courier reaches the
   * recipient, and whatever the courier threw when one exists and refused. Both are the caller's
   * to isolate — see `push`.
   */
  private async emit(recipient: string, message: WireMessage): Promise<Transport | null> {
    if (message.recipient !== recipient) {
      // Belt and braces on the invariant above: a message signed for one persona must never be
      // handed to a transport addressed to another.
      throw new Error(`§6.2: message signed for ${message.recipient} cannot be sent to ${recipient}`);
    }
    const id = messageId(message);
    if (this.sent.has(id)) return null;
    const transport = this.routeFor(recipient);
    if (transport === null) throw new UnroutableRecipient(recipient);
    // Marked sent only once the transport ACCEPTED it. Marking first meant a hub that answered
    // 503 — the one case store-and-forward exists for — was recorded as a successful delivery:
    // the next `push` skipped the message for the life of the process, and for a `propose` there
    // is no second chance, because §6.4 reconciliation "never introduces an edge". A promise made
    // during a five-minute outage was never delivered, and the owner's register read `proposed`
    // for ever, indistinguishable from a counterparty ignoring it.
    await transport.send(recipient, message);
    this.sent.add(id);
    return transport;
  }

  /**
   * Hand the couriers everything this node owes its counterparties: the `propose` messages L1
   * queued in the vault outbox, and every assertion held for a shared edge that has not gone
   * out yet.
   *
   * Re-sending an assertion the peer already holds is harmless (they deduplicate by `sig`) and
   * is the cheap half of §6.7's store-and-forward model; the expensive half is `reconcile`.
   *
   * **Every recipient is attempted.** One unreachable counterparty used to abandon the loop from
   * inside it, so messages to healthy counterparties queued behind a broken one never left — and
   * `sync()` was skipped too, stranding even the messages that HAD been staged. A refusal is now
   * recorded against the item it belongs to, the loop continues, every courier is flushed, and
   * the aggregate is thrown at the end: nothing is starved and nothing is swallowed.
   */
  async push(): Promise<number> {
    const failures: DeliveryFailure[] = [];
    /** Accepted by a courier but not yet flushed — for git, `send` only stages a file. */
    const handed: {
      item: OutboxItem | null;
      recipient: string;
      type: WireMessage['type'];
      transport: Transport;
    }[] = [];

    for (const item of this.vault.listOutbox(this.persona)) {
      // §6.7 makes delivery an optimization, so a message the recipient has PROVED they hold
      // needs no courier. Anything short of that — `sent_at` included — is re-presented, because
      // re-presentation is exactly the store-and-forward that heals a dropped hub queue. That is
      // also why a restart no longer re-sends everything: it re-sends only the unacknowledged.
      if (item.delivery.acknowledged_at !== null) continue;
      const message = verifyMessage(item.message);
      if (!message) continue; // a queued message that no longer verifies is not sent
      let transport: Transport | null;
      try {
        transport = await this.emit(item.recipient, message);
      } catch (error) {
        failures.push(this.failureOf(item.id, item.recipient, message.type, error));
        this.noteFailure(item, error);
        continue;
      }
      const assertion = (message.payload as { assertion?: Assertion } | null)?.assertion;
      // The `propose` already carries this assertion; do not send it twice.
      if (assertion) this.sentAssertions.add(assertion.sig);
      if (transport !== null) handed.push({ item, recipient: item.recipient, type: message.type, transport });
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
        try {
          const transport = await this.emit(counterparty, this.sign('assert', counterparty, { assertion }));
          // Retired only once a courier accepted it — the same correction `emit` records for
          // `this.sent`, which this line did not have. Marking first meant a hub that answered 503
          // retired the assertion for the life of the process, so the counterparty never learned
          // this side had accepted and no later `push` would tell them.
          this.sentAssertions.add(assertion.sig);
          if (transport !== null) handed.push({ item: null, recipient: counterparty, type: 'assert', transport });
        } catch (error) {
          failures.push(this.failureOf(null, counterparty, 'assert', error));
        }
      }
    }

    // Flush every courier that took something, plus the home one: `pull` reads from it, and for
    // the git transport `sync` is the only place a fetch or a push actually happens.
    const touched = new Set<Transport>(handed.map((h) => h.transport));
    touched.add(this.transport);
    const syncFailure = new Map<Transport, unknown>();
    for (const transport of touched) {
      try {
        await transport.sync();
      } catch (error) {
        syncFailure.set(transport, error);
      }
    }

    let n = 0;
    const at = this.clock().toISOString();
    for (const { item, recipient, type, transport } of handed) {
      const error = syncFailure.get(transport);
      if (error !== undefined) {
        // A git push that failed is not a delivery: the bytes sit in a local clone nobody else
        // can read. Reporting `sent_at` here would be the exact lie this state exists to prevent.
        // The message is not lost by staying in `this.sent`: the git transport keeps it in its own
        // working tree and the next `sync` pushes it, and the hub's `sync` is a no-op that cannot
        // fail. So the retry lives in the courier, which is the only layer that knows what it did.
        failures.push(this.failureOf(item?.id ?? null, recipient, type, error));
        if (item) this.noteFailure(item, error);
        continue;
      }
      n++;
      if (!item) continue;
      // Only when something CHANGED. Every vault write is a git commit, and an unacknowledged
      // message is re-presented on every push by design (§6.7 store-and-forward) — recording the
      // same fact each time would put a commit per queued message per push into the vault's
      // history for no new information.
      if (item.delivery.sent_at !== null && item.delivery.sent_via === transport.kind) continue;
      this.vault.recordOutboxDelivery(this.persona, item.id, {
        sent_at: at,
        sent_via: transport.kind,
        attempts: item.delivery.attempts + 1,
        last_attempt_at: at,
        last_error: null,
        unroutable_since: null,
      });
    }

    if (failures.length > 0) throw new OutboundDeliveryError(n, failures);
    return n;
  }

  /** Sync with the medium, take delivery, and run everything through the inbox. */
  async pull(): Promise<IngestResult> {
    await this.transport.sync();
    const messages = await this.transport.receive(this.persona);
    const result = this.inbox.ingest(messages);
    this.recordAcknowledgements(messages);
    return result;
  }

  /**
   * What this node knows about every message it has queued, in words a person can read.
   *
   * The four states are not four shades of the same thing. `unroutable` will never change on its
   * own; `queued` may; `sent` says something about the COURIER only; and `acknowledged` is the
   * one state that says anything about the recipient. A screen that showed one string for all of
   * them is what made a year of silence and a year of being ignored render identically.
   */
  outbound(): OutboundStatus[] {
    const now = this.clock();
    return this.vault.listOutbox(this.persona).map((item) => {
      const message = verifyMessage(item.message);
      const d = item.delivery;
      const state: OutboundState =
        d.acknowledged_at !== null
          ? 'acknowledged'
          : d.sent_at !== null
            ? 'sent'
            : d.unroutable_since !== null
              ? 'unroutable'
              : 'queued';
      return {
        id: item.id,
        recipient: item.recipient,
        edge_id: message === null ? null : edgeIdOf(message),
        queued_at: item.queued_at,
        state,
        sent_at: d.sent_at,
        sent_via: d.sent_via,
        acknowledged_at: d.acknowledged_at,
        attempts: d.attempts,
        last_error: d.last_error,
        explanation: explainDelivery(item, state, now),
      };
    });
  }

  /** §6.4: ask a counterparty for anything we are missing on our shared open edges. */
  async requestRecon(counterparty: string): Promise<ReconRequest> {
    const request = buildReconRequest(this.vault, this.persona, counterparty);
    const transport = await this.emit(counterparty, this.sign('recon_request', counterparty, request));
    await (transport ?? this.transport).sync();
    return request;
  }

  /**
   * §6.4 responder side. M-4a is applied inside `answerReconRequest`, not here.
   *
   * Isolated per requester for the same reason `push` is: this loop answers several
   * counterparties, and one of them being unreachable is not a reason the others go unanswered.
   */
  async answerRecon(requests: { from: string; request: ReconRequest }[]): Promise<number> {
    let n = 0;
    const failures: DeliveryFailure[] = [];
    const touched = new Set<Transport>([this.transport]);
    for (const { from, request } of requests) {
      const response = answerReconRequest(this.vault, this.persona, from, request);
      if (response.edges.length === 0) continue;
      try {
        const transport = await this.emit(from, this.sign('recon_response', from, response));
        if (transport !== null) {
          touched.add(transport);
          n++;
        }
      } catch (error) {
        failures.push(this.failureOf(null, from, 'recon_response', error));
      }
    }
    for (const transport of touched) await transport.sync();
    if (failures.length > 0) throw new OutboundDeliveryError(n, failures);
    return n;
  }

  private failureOf(
    outbox_id: string | null,
    recipient: string,
    message_type: WireMessage['type'],
    error: unknown,
  ): DeliveryFailure {
    return {
      outbox_id,
      recipient,
      message_type,
      transport: error instanceof UnroutableRecipient ? null : (this.routeFor(recipient)?.kind ?? null),
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  private noteFailure(item: OutboxItem, error: unknown): void {
    const at = this.clock().toISOString();
    this.vault.recordOutboxDelivery(this.persona, item.id, {
      attempts: item.delivery.attempts + 1,
      last_attempt_at: at,
      last_error: error instanceof Error ? error.message : String(error),
      // SINCE, not AT: a person needs "nobody has had an address for you in a year", and the
      // instant of the most recent futile attempt cannot say that.
      unroutable_since:
        error instanceof UnroutableRecipient ? (item.delivery.unroutable_since ?? at) : null,
    });
  }

  /**
   * §6.7 gives a sender no delivery receipt, and neither shipped transport can honestly invent
   * one. What a recipient CAN prove is that they hold the edge: §4.1 binds `edge_id` to the edge
   * body, so a signature by them naming it could not exist unless this side's message reached
   * them. That — and only that — sets `acknowledged_at`.
   *
   * Deliberately independent of whether the inbox ACCEPTED the message. The proof is
   * cryptographic; local policy (a budget, a duplicate, a retention window) governs what this
   * node does with their message, not whether they read ours.
   */
  private recordAcknowledgements(messages: readonly WireMessage[]): void {
    const waiting = this.vault
      .listOutbox(this.persona)
      .filter((item) => item.delivery.acknowledged_at === null);
    if (waiting.length === 0) return;

    const proven = new Set<string>();
    for (const raw of messages) {
      // Re-verified even though transports verify: a class that trusts its caller is not a
      // boundary, and this one decides whether a promise stops being re-sent.
      const message = verifyMessage(raw as unknown);
      if (!message) continue;
      const edge = edgeIdOf(message);
      if (edge !== null) proven.add(`${message.sender} ${edge}`);
    }
    if (proven.size === 0) return;

    const at = this.clock().toISOString();
    for (const item of waiting) {
      const message = verifyMessage(item.message);
      const edge = message === null ? null : edgeIdOf(message);
      if (edge === null) continue;
      if (!proven.has(`${item.recipient} ${edge}`)) continue;
      this.vault.recordOutboxDelivery(this.persona, item.id, { acknowledged_at: at });
    }
  }
}

const DAY_MS = 86_400_000;

function daysSince(from: string, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - Date.parse(from)) / DAY_MS));
}

/**
 * The sentence itself. Each branch says what is established and stops there — the `sent` wording
 * in particular names the courier and then explicitly denies the thing a person would otherwise
 * read into it.
 */
function explainDelivery(item: OutboxItem, state: OutboundState, now: Date): string {
  const who = `${item.recipient.slice(0, 16)}…`;
  const d = item.delivery;
  switch (state) {
    case 'acknowledged':
      return `${who} has signed for this edge — proof they received it (${d.acknowledged_at}).`;
    case 'sent':
      return (
        `Handed to the ${d.sent_via ?? 'unknown'} courier ${daysSince(d.sent_at ?? item.queued_at, now)} ` +
        `day(s) ago. That proves the bytes reached the medium, not that ${who} read them — ` +
        `nothing has come back since.`
      );
    case 'unroutable':
      return (
        `No courier on this node reaches ${who}, and none has for ` +
        `${daysSince(d.unroutable_since ?? item.queued_at, now)} day(s). This message has never ` +
        `left this machine and will not arrive until a transport that reaches them is configured.`
      );
    default:
      return d.last_error === null
        ? 'Queued. No courier has been asked for it yet.'
        : `Queued. The last courier refused it: ${d.last_error}`;
  }
}
