import type { IngestCandidate, PendingProposalSink } from '@servanda/extraction';
import type { Commitment, Expectation } from '@servanda/types';
import type { ServandaNode } from './node.js';

/**
 * The node's half of the §3 ingestion port.
 *
 * `@servanda/extraction` reads the envelope log and proposes; this puts what it proposed in front
 * of the person. The dependency points node → extraction and must never invert — an extraction
 * package able to reach a vault is one a model's output could reach a vault through.
 *
 * **The import above is `import type`, and that is load-bearing rather than stylistic.**
 * `@servanda/extraction` depends on `@anthropic-ai/sdk`, so a value import here would pull an
 * HTTP client into every process that loads the node. M-10 says an L0–L1 node functions with no
 * network at all, and gate GA proves it by running the shipped node with network primitives
 * disabled. A type-only import is erased at compile time, so nothing of the SDK reaches the
 * emitted JavaScript. If a value from `@servanda/extraction` is ever genuinely needed here, it
 * must be moved to a package that has no model client in it — not imported.
 *
 * That is also why the `expectation-only` disposition is detected structurally, by asking whether
 * the candidate carries an expectation, rather than by comparing against the exported
 * `EXPECTATION_ONLY` constant: the constant is a value.
 */
export class LocalPendingSink implements PendingProposalSink {
  constructor(private readonly node: ServandaNode) {}

  hasIngestedEnvelope(persona: string, envelopeId: string): boolean {
    return this.node.local.hasIngested(persona, envelopeId);
  }

  ingestEnvelope(
    persona: string,
    envelopeId: string,
    candidates: readonly IngestCandidate[],
  ): readonly string[] {
    const ids: string[] = [];
    for (const candidate of candidates) {
      if (candidate.expectation !== undefined) {
        ids.push(
          this.node.queuePendingExtraction(
            persona,
            candidate.expectation as Expectation,
            envelopeId,
            'expectation',
          ),
        );
        continue;
      }
      if (candidate.commitment === undefined) continue;
      ids.push(
        this.node.queuePendingExtraction(
          persona,
          candidate.commitment as unknown as Commitment,
          envelopeId,
          'commitment',
        ),
      );
    }

    // Queue first, mark second — the order the port prescribes where one durable write is not
    // available, and it is not available here: the queue and the marker are separate files, and
    // the local store is deliberately not a git repository, so there is no commit to make them
    // one act. A crash between the two lines replays the envelope and the person dismisses a
    // duplicate; the reverse order would lose the promise with nothing ever looking again.
    this.node.local.markIngested(persona, envelopeId);
    return ids;
  }
}
