import { z } from 'zod';
import { hashCanonical } from '@servanda/crypto';
import { ProtocolVersion, Rfc3339, Sha256Hex } from '@servanda/types';

/**
 * §4.4 — the evidence bundle.
 *
 * "`on-evidence`: a `closed` assertion by the owner with non-null `evidence_hash` (hash of the
 * verification adapter's evidence bundle) closes the edge." That one parenthesis is the whole
 * contract this file implements: an `evidence_hash` in a §4.2 assertion is
 * `sha256(JCS(EvidenceBundle))` and nothing else. Before this package the hash was opaque —
 * a 64-hex field any client could fill with a die roll and every verifier had to accept.
 *
 * Three properties the shape is chosen for:
 *
 *  - **Reproducible.** Every input is injected, including `observed_at`. An adapter is a pure
 *    function of (commitment, context); the same observation hashes identically in another
 *    process, on another machine, a year later. That is what makes the hash citable at all:
 *    the counterparty who later receives the bundle recomputes the hash and compares it to the
 *    one the owner signed. A `new Date()` anywhere in this package would silently destroy that.
 *  - **Unsigned.** There is no `sig`, no `by`, no `signed_by` field, and the schema is strict,
 *    so there is no room to add one at a call site. M-13: automation acts *under* a persona,
 *    never *as* one. An adapter reports; the owner signs (§4.4). See `test/musts/M-13.test.ts`.
 *  - **Plaintext-free (M-7).** The bundle references the commitment by `commitment_hash`. It
 *    never carries `intent`, and no observation field is free text copied out of a signal.
 */

export const ADAPTER_NAMES = ['ci', 'git', 'file'] as const;
export const AdapterName = z.enum(ADAPTER_NAMES);
export type AdapterName = z.infer<typeof AdapterName>;

/** §2 CI conclusions, as GitHub/GitLab-shaped check runs report them. */
export const CiConclusion = z.enum([
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'neutral',
  'skipped',
]);
export type CiConclusion = z.infer<typeof CiConclusion>;

/**
 * What an adapter is allowed to have seen. A closed union of typed records — never a free-text
 * note, never a `details: string` an injected signal could ride in on (§9.2, M-6).
 *
 * `.strict()` on each member is load-bearing: it is what stops a future call site attaching an
 * extra field that a consumer might treat as instruction.
 */
export const Observation = z.discriminatedUnion('kind', [
  /** `ci`: a check run / workflow conclusion, read out of a §2 envelope already received. */
  z
    .object({
      kind: z.literal('ci-run'),
      /** The §2 envelope this was read from. The evidence is the received signal, not a fetch. */
      envelope_id: Sha256Hex,
      source: z.string().min(1),
      workflow: z.string().min(1),
      run_id: z.string().min(1),
      commit: z.string().regex(/^[0-9a-f]{7,40}$/),
      conclusion: CiConclusion,
      completed_at: Rfc3339,
    })
    .strict(),
  /** `git`: the commit is present in the repository. */
  z
    .object({
      kind: z.literal('git-commit'),
      commit: z.string().regex(/^[0-9a-f]{40}$/),
      /** What the ref resolved from, verbatim, so the observation is replayable. */
      queried: z.string().min(1),
      present: z.boolean(),
    })
    .strict(),
  /** `git`: the branch exists, and where its head is. */
  z
    .object({
      kind: z.literal('git-branch'),
      branch: z.string().min(1),
      head: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
      present: z.boolean(),
    })
    .strict(),
  /**
   * `git`: a merged PR, observed locally as "the head ref is an ancestor of the base ref".
   * A merge is a fact about the object graph; asking a forge would need the network.
   */
  z
    .object({
      kind: z.literal('git-merged'),
      head_ref: z.string().min(1),
      base_ref: z.string().min(1),
      head: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
      base: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
      merged: z.boolean(),
    })
    .strict(),
  /** `file`: a path exists (and its digest, so "matches a digest" is the same observation). */
  z
    .object({
      kind: z.literal('file'),
      path: z.string().min(1),
      present: z.boolean(),
      size: z.number().int().nonnegative().nullable(),
      sha256: Sha256Hex.nullable(),
      /** Non-null only when the ref named an expected digest (see `refs.ts`). */
      expected_sha256: Sha256Hex.nullable(),
      digest_matches: z.boolean().nullable(),
    })
    .strict(),
]);
export type Observation = z.infer<typeof Observation>;

export const EvidenceBundle = z
  .object({
    v: ProtocolVersion,
    type: z.literal('evidence_bundle'),
    /**
     * Which adapters contributed. Sorted and duplicate-free, enforced rather than assumed: JCS
     * canonicalizes key order but not array order, so an unsorted list would be a second bundle
     * with the same content and a different hash — the exact failure `evidence_hash` cannot
     * survive. `observations` needs no such rule; its order is the commitment's `evidence_refs`
     * order, which is itself part of the signed commitment.
     */
    adapters: z
      .array(AdapterName)
      .min(1)
      .refine(
        (xs) => xs.every((x, i) => i === 0 || x > (xs[i - 1] as string)),
        'adapters must be sorted and duplicate-free so the bundle hashes reproducibly',
      ),
    /** §3.2 — the promise this is evidence about, by hash. Never its plaintext (M-7). */
    commitment_hash: Sha256Hex,
    /** Injected, never read from the clock. See the reproducibility note above. */
    observed_at: Rfc3339,
    /**
     * Whether what was observed supports the claim. NOT a decision, and not a closure: §4.4
     * keeps closing an edge an owner's signed act. A `satisfied: false` bundle is a perfectly
     * good bundle — it is how "CI ran and failed" is recorded rather than hidden.
     */
    satisfied: z.boolean(),
    observations: z.array(Observation).min(1),
  })
  .strict();
export type EvidenceBundle = z.infer<typeof EvidenceBundle>;

/**
 * The §4.4 `evidence_hash`: `sha256(JCS(bundle))`.
 *
 * JCS (RFC 8785) already fixes key order and number/string forms, so two processes that built
 * the same bundle from the same observation agree on the hash without agreeing on anything else.
 * The bundle is re-parsed first so a hand-built object that is *nearly* a bundle cannot be
 * hashed into an assertion — a hash over an unvalidated shape is a hash over nothing.
 */
export function evidenceHash(bundle: EvidenceBundle): string {
  return hashCanonical(EvidenceBundle.parse(bundle));
}
