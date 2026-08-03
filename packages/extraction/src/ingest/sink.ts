import type { ExtractedCommitment, Expectation } from '@servanda/types';
import type { Disposition, Routed } from '../routing.js';
import { EXPECTATION_ONLY } from '../routing.js';

/**
 * The one thing ingest needs from the node, as an injected interface.
 *
 * `@servanda/extraction` proposes; it does not store protocol state, hold a key, or open a vault.
 * So the last hop — "put this in front of the person" — is a port, and `@servanda/node` supplies
 * it. Keeping the dependency pointing that way is not tidiness: an extraction package that could
 * reach a vault would be an extraction package a model's output could reach a vault through.
 *
 * The port has exactly two methods because idempotency needs exactly two. `hasIngestedEnvelope`
 * is the question a restart asks; `ingestEnvelope` is the answer being recorded. What makes the
 * pair sufficient — and what makes a one-method version insufficient — is the second paragraph of
 * `ingestEnvelope` below.
 */

/** A routed extraction result on its way to the queue, flattened for a sink that stores records. */
export interface IngestCandidate {
  readonly disposition: Disposition;
  /** Present for every disposition except `expectation-only`. */
  readonly commitment?: ExtractedCommitment;
  /** Present only for `expectation-only`: someone else's promise, which M-1 keeps off the wire. */
  readonly expectation?: Expectation;
  /** The verbatim span the model claims states it. Evidence for the human, never an instruction. */
  readonly quote: string;
  readonly confidence: number;
}

export interface PendingProposalSink {
  /**
   * Has this node already ingested this envelope, in ANY earlier run?
   *
   * Durable across process restarts, and — this is the part that is easy to get wrong — durable
   * across the pending item's own lifecycle. An envelope whose candidate was confirmed, or
   * rejected, or swept, is still an envelope that has been ingested. Answering from the pending
   * queue's contents would re-propose every promise the person has already signed.
   */
  hasIngestedEnvelope(persona: string, envelopeId: string): boolean;

  /**
   * Queue this envelope's candidates and record the envelope as ingested, as one durable act.
   *
   * Called with an empty `candidates` too, and that call is not a no-op: an envelope the model
   * found nothing in must still be marked, or every run re-sends it and pays for the same answer
   * forever. "Nothing was found here" is a result.
   *
   * The two writes must land together. If the queue is written and the marker is not, a crash in
   * between replays the envelope on the next run and the person sees the same promise twice; if
   * the marker is written and the queue is not, the promise is lost and nothing will ever look at
   * that envelope again. Where a single durable write is genuinely unavailable, queue first and
   * mark second: a duplicate in a confirmation queue is something a person dismisses, and a
   * dropped promise is the product silently not working.
   *
   * Returns the queued item ids, in the order given.
   */
  ingestEnvelope(
    persona: string,
    envelopeId: string,
    candidates: readonly IngestCandidate[],
  ): readonly string[];
}

/** Flatten a `Routed` for the sink, keeping the disposition that says what may become of it. */
export function toCandidate(routed: Routed, quote: string, confidence: number): IngestCandidate {
  if (routed.disposition === EXPECTATION_ONLY) {
    return { disposition: routed.disposition, expectation: routed.expectation, quote, confidence };
  }
  return { disposition: routed.disposition, commitment: routed.commitment, quote, confidence };
}

/**
 * An in-memory sink. Used by the tests here, and by anyone running ingest with `--dry-run`
 * against a real log to see what WOULD be queued without a vault in the picture.
 *
 * It is deliberately not persistent, which makes it wrong for the job the node does: restart it
 * and every envelope looks new again. That is the whole reason the port exists.
 */
export class MemoryPendingSink implements PendingProposalSink {
  readonly #ingested = new Set<string>();
  readonly #queued: { persona: string; envelopeId: string; candidate: IngestCandidate; id: string }[] =
    [];
  #next = 0;

  hasIngestedEnvelope(persona: string, envelopeId: string): boolean {
    return this.#ingested.has(`${persona}/${envelopeId}`);
  }

  ingestEnvelope(
    persona: string,
    envelopeId: string,
    candidates: readonly IngestCandidate[],
  ): readonly string[] {
    const ids = candidates.map((candidate) => {
      const id = `queued-${++this.#next}`;
      this.#queued.push({ persona, envelopeId, candidate, id });
      return id;
    });
    this.#ingested.add(`${persona}/${envelopeId}`);
    return ids;
  }

  get queued(): readonly { persona: string; envelopeId: string; candidate: IngestCandidate; id: string }[] {
    return this.#queued;
  }

  get ingestedCount(): number {
    return this.#ingested.size;
  }
}
