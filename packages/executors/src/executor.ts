import { z } from 'zod';
import { Commitment, PROTOCOL_VERSION } from '@servanda/types';
import type { Workspace } from './workspace.js';

/**
 * The executor interface, unchanged since day one: `(commitment, context) → artifact_for_review`.
 *
 * Two things an executor deliberately cannot do, both enforced by what this file does *not*
 * declare:
 *
 *   - **It cannot act.** There is no verb here that reaches the world — no fs, no process, no
 *     network, no git. It mutates a `Workspace`, which is memory, and returns a title and a
 *     body. The artifact itself is assembled by the host, which is why an executor cannot set
 *     `draft: false`, cannot name a base commit, and cannot attribute a signature to anyone.
 *   - **It cannot read free text.** §9.2: "Executors receive typed objects + enumerated
 *     capabilities" and "output enters no executor as free text". So the commitment handed to an
 *     executor is stripped of `intent` and `evidence_refs` — the two fields whose contents come,
 *     ultimately, from an untrusted signal. The reviewer still sees the intent: the *host* puts
 *     it in the artifact body. The executor never does, because it never has it.
 */

/**
 * A §3.1 commitment with every free-text field removed. What is left is keys, timestamps,
 * enumerations and numbers — nothing an injected instruction can ride in on.
 */
export const ExecutorCommitment = Commitment.omit({ intent: true, evidence_refs: true }).extend({
  /** §3.2, so an executor can reference the promise without holding its plaintext (M-7). */
  commitment_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ExecutorCommitment = z.infer<typeof ExecutorCommitment>;

/**
 * What the executor is pointed at. Chosen by the host's ranking layer, not by a model, and
 * enumerated so that "do this thing to that file" cannot be smuggled in as a sentence.
 */
export const ExecutionTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source-file'), path: z.string().min(1) }).strict(),
  z
    .object({ kind: z.literal('symbol'), symbol: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/), path: z.string().min(1) })
    .strict(),
  z
    .object({
      kind: z.literal('dependency'),
      name: z.string().min(1).max(214),
      toVersion: z.string().regex(/^[\^~]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    })
    .strict(),
]);
export type ExecutionTarget = z.infer<typeof ExecutionTarget>;

export interface ExecutionContext {
  /**
   * The persona the automation acts *under*. M-13: an agent is never a party. This is here so
   * the artifact can say whose queue it belongs in — never so that anything can be signed with
   * it. No key of any kind is reachable from this context.
   */
  readonly persona: string;
  readonly target: ExecutionTarget;
  readonly workspace: Workspace;
  /** RFC 3339. Injected so an executor is a pure function of its inputs. */
  readonly now: string;
}

/** What an executor returns. The host turns this, plus the workspace proposal, into an artifact. */
export const ExecutorOutput = z
  .object({
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(8000),
  })
  .strict();
export type ExecutorOutput = z.infer<typeof ExecutorOutput>;

/** `null` means "nothing to do here" — the correct and common answer. */
export type Executor = (
  commitment: ExecutorCommitment,
  context: ExecutionContext,
) => ExecutorOutput | null;

export const EXECUTOR_PROTOCOL_VERSION = PROTOCOL_VERSION;
