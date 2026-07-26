import { PROTOCOL_VERSION } from '@servanda/types';
import type { Envelope, EvidenceRef } from '@servanda/types';
import type { AdapterCommitment, ObservationContext, VerificationAdapter } from '../adapter.js';
import { notVerifiable, observed } from '../adapter.js';
import { CiConclusion } from '../bundle.js';
import type { Observation } from '../bundle.js';
import { MalformedRef, parseEnvelopeRef } from '../refs.js';

/**
 * The `ci` adapter: did a check run conclude?
 *
 * It observes a §2 envelope that has **already been received** — the connector's job — and never
 * goes and asks a forge. That is not an optimisation: an adapter that could fetch would be a
 * network client inside the verification path, and §4.4's evidence would then depend on whatever
 * a server said at hash time rather than on what the node holds. Evidence is a received signal.
 *
 * M-6 is why every field below is pulled by name and type-checked: an envelope's `payload` is
 * data, never instruction. Nothing here branches on a string that is not a closed enumeration.
 */

/** The shape `@servanda/connectors-github` produces for `source: 'ci', kind: 'check_run'`. */
function readCheckRun(envelope: Envelope):
  | {
      workflow: string;
      run_id: string;
      commit: string;
      conclusion: string;
      completed_at: string;
    }
  | { missing: string } {
  const p = envelope.payload;
  const str = (k: string): string | undefined => {
    const v = p[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return undefined;
  };
  const workflow = str('text');
  const runId = str('check_run_id');
  const commit = str('head_sha');
  const conclusion = str('conclusion');
  const completedAt = str('completed_at');
  for (const [name, value] of [
    ['text', workflow],
    ['check_run_id', runId],
    ['head_sha', commit],
    ['conclusion', conclusion],
    ['completed_at', completedAt],
  ] as const) {
    if (value === undefined) return { missing: name };
  }
  return {
    workflow: workflow as string,
    run_id: runId as string,
    commit: commit as string,
    conclusion: conclusion as string,
    completed_at: completedAt as string,
  };
}

export const ciAdapter: VerificationAdapter = {
  name: 'ci',
  declares: ['envelope'],
  summary: 'Observe the conclusion of a CI check run carried by an already-received envelope.',

  observe(
    commitment: AdapterCommitment,
    ref: EvidenceRef,
    context: ObservationContext,
  ) {
    if (ref.kind !== 'envelope') {
      return notVerifiable('no-adapter-for-evidence', `ci does not observe ${ref.kind} refs`);
    }

    let id: string;
    try {
      id = parseEnvelopeRef(ref);
    } catch (err) {
      if (err instanceof MalformedRef) return notVerifiable('malformed-evidence-ref', err.message);
      throw err;
    }

    const envelopes = context.envelopes;
    if (envelopes === undefined) {
      return notVerifiable('adapter-capability-absent', 'no envelopes were provided to observe');
    }
    const envelope = envelopes.find((e) => e.id === id);
    if (envelope === undefined) {
      return notVerifiable('adapter-capability-absent', `envelope ${id} has not been received`);
    }

    // M-5 (no org-context mixing) is upheld by the caller, not here: §2 binds an envelope to
    // exactly one persona at registration, and the envelopes handed to an adapter come out of
    // one persona's vault. An owner check at this layer would be a second, weaker copy of that
    // rule — and would misfire on collective edges, whose owner is a group key while envelopes
    // are always persona-bound.

    if (envelope.source !== 'ci') {
      return notVerifiable('evidence-not-observable', `envelope ${id} is not a CI signal`);
    }

    const read = readCheckRun(envelope);
    if ('missing' in read) {
      return notVerifiable(
        'evidence-not-observable',
        `envelope ${id} carries no ${read.missing} to read`,
      );
    }

    const conclusion = CiConclusion.safeParse(read.conclusion);
    if (!conclusion.success) {
      return notVerifiable(
        'evidence-not-observable',
        `envelope ${id} reports an unknown conclusion`,
      );
    }
    if (!/^[0-9a-f]{7,40}$/.test(read.commit)) {
      return notVerifiable('evidence-not-observable', `envelope ${id} carries no usable head sha`);
    }

    const observation: Observation = {
      kind: 'ci-run',
      envelope_id: envelope.id,
      source: envelope.source,
      workflow: read.workflow,
      run_id: read.run_id,
      commit: read.commit,
      conclusion: conclusion.data,
      completed_at: read.completed_at,
    };

    return observed({
      v: PROTOCOL_VERSION,
      type: 'evidence_bundle',
      adapters: ['ci'],
      commitment_hash: commitment.commitment_hash,
      observed_at: context.now,
      // A failed run is evidence too. The adapter says what it saw; §4.4 leaves the closing to
      // the owner, who is free to look at a `satisfied: false` bundle and not close.
      satisfied: conclusion.data === 'success',
      observations: [observation],
    });
  },
};
