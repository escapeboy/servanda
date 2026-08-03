import type { AttestationVerdict } from './attestation.js';
import type { AnchorResolution } from './anchor.js';
import { anchorsOrgRoot } from './anchor.js';
import type { BindingProofVerdict } from './binding-proof.js';
import { normalizeChannelUrl } from './binding-proof.js';
import type { VerifyRotationOptions } from './rotation.js';
import { verifyRotation } from './rotation.js';

/**
 * §1.7 / ADR-0014 — seedless recovery.
 *
 * "(a) org re-attestation of a fresh persona for the same human — org-scope continuity,
 *  level 2; (b) rotation statement published over an existing external binding proof channel —
 *  the channel is the anchor. A persona with no seed, no org, and no external proof is
 *  unrecoverable by design."
 *
 * That last sentence is a requirement, not a gap to fill. `recoveryPaths` returns an empty set
 * and `unrecoverable-by-design` for that case; there is no fallback path in this module,
 * because any fallback would be a way to take over a persona whose owner cannot prove anything.
 *
 * "No seed" is a thing somebody has to have been ASKED, though, and that is the one distinction
 * this module has to keep: see `reason`.
 */

export type RecoveryPathKind = 'seed' | 'org-reattestation' | 'external-proof-rotation';

export interface RecoveryPath {
  readonly kind: RecoveryPathKind;
  /** The verification level the recovered persona reaches by this path (§1.6). */
  readonly level: '2' | '3' | 'ext' | null;
  readonly detail: string;
}

export interface RecoveryInput {
  /** The persona whose key is gone. */
  readonly lostPersona: string;
  /** The persona the human is recovering onto. */
  readonly freshPersona: string;
  /**
   * Does the human still hold the BIP-39 seed? If so, §1.2 derivation restores everything.
   *
   * Three values, not two. `undefined` means NOBODY HAS ASKED, and it must not be read as `false`
   * — see `reason` for what that conflation would tell a person on the worst day of their year.
   */
  readonly seedAvailable?: boolean;
  /** An org attestation of `freshPersona` — path (a). Already time-resolved. */
  readonly reattestation?: AttestationVerdict | null;
  /** The org's domain anchor, if any — lifts path (a) from level 2 to level 3. */
  readonly anchor?: AnchorResolution | null;
  /** A rotation statement `lostPersona → freshPersona` — path (b). */
  readonly rotation?: unknown;
  /** The pre-existing binding proof for `lostPersona`, verified on its channel — path (b). */
  readonly bindingProof?: BindingProofVerdict | null;
  /** Where the rotation statement was published. Must be the binding proof's channel. */
  readonly rotationPublishedAt?: string;
  readonly rotationOptions?: VerifyRotationOptions;
}

export interface RecoveryAssessment {
  readonly lostPersona: string;
  readonly freshPersona: string;
  readonly paths: readonly RecoveryPath[];
  readonly recoverable: boolean;
  /**
   * Why there is no path, when there is none.
   *
   * `unrecoverable-by-design` is ADR-0014's designed dead end and it is a heavy sentence to put in
   * front of somebody: no seed, no org, no external proof, and the honest answer is that this
   * persona is gone. It must be earned, and it was not. `seedAvailable` is optional, so a caller
   * that had not asked about the 24 words got the same verdict as one that had asked and been told
   * no — the assessment could not tell "we did not ask" from "you have nothing", and the first is
   * where nearly every real caller starts. The one path that always works is the one nobody had
   * checked.
   *
   * `seed-not-established` says exactly that instead: nothing else offered a path, and the seed
   * question is still open. It is not a recovery path — `recoverable` stays false — it is the
   * difference between "you are locked out for good" and "go and look for the card you wrote them
   * on".
   */
  readonly reason: 'unrecoverable-by-design' | 'seed-not-established' | null;
  /** Why an offered path did not hold. Empty when nothing was offered. */
  readonly rejected: readonly { readonly kind: RecoveryPathKind; readonly reason: string }[];
}

export function recoveryPaths(input: RecoveryInput): RecoveryAssessment {
  const paths: RecoveryPath[] = [];
  const rejected: { kind: RecoveryPathKind; reason: string }[] = [];

  if (input.seedAvailable === true) {
    // §1.2: derivation is deterministic from the seed, so the persona itself comes back. This
    // is not seedless recovery; it is listed so callers see it ranks above the other two.
    paths.push({
      kind: 'seed',
      level: null,
      detail: 'the seed re-derives the persona itself (§1.2); no new key is needed',
    });
  }

  // ── (a) org re-attestation of a fresh persona ────────────────────────────────────────────
  const att = input.reattestation ?? null;
  if (att !== null) {
    if (!att.ok) {
      rejected.push({ kind: 'org-reattestation', reason: att.reason });
    } else if (att.attestation.subject !== input.freshPersona) {
      rejected.push({ kind: 'org-reattestation', reason: 'attests a different subject' });
    } else {
      const anchored = anchorsOrgRoot(input.anchor ?? null, att.attestation.org);
      paths.push({
        kind: 'org-reattestation',
        level: anchored ? '3' : '2',
        detail: `org ${att.attestation.org} re-attests ${input.freshPersona} (ADR-0014 a)`,
      });
    }
  }

  // ── (b) rotation published over an existing external binding-proof channel ────────────────
  if (input.rotation !== undefined || input.bindingProof != null) {
    const proof = input.bindingProof ?? null;
    const verdict = verifyRotation(input.rotation, input.rotationOptions ?? {});
    if (!verdict.ok) {
      rejected.push({ kind: 'external-proof-rotation', reason: `rotation:${verdict.reason}` });
    } else if (verdict.old !== input.lostPersona || verdict.new !== input.freshPersona) {
      rejected.push({ kind: 'external-proof-rotation', reason: 'rotation:wrong-key-pair' });
    } else if (proof === null || !proof.ok) {
      rejected.push({
        kind: 'external-proof-rotation',
        reason: proof === null ? 'binding-proof:absent' : `binding-proof:${proof.reason}`,
      });
    } else if (proof.proof.persona !== input.lostPersona) {
      // The channel must be the LOST persona's, or it anchors nothing about the lost identity.
      rejected.push({ kind: 'external-proof-rotation', reason: 'binding-proof:wrong-persona' });
    } else {
      // "the channel is the anchor": the rotation only counts if it was published THERE.
      const channel = normalizeChannelUrl(proof.proof.channel_url);
      const publishedAt =
        input.rotationPublishedAt === undefined ? null : normalizeChannelUrl(input.rotationPublishedAt);
      if (channel === null || publishedAt === null || channel !== publishedAt) {
        rejected.push({
          kind: 'external-proof-rotation',
          reason: 'rotation:not-published-on-the-binding-proof-channel',
        });
      } else {
        paths.push({
          kind: 'external-proof-rotation',
          level: 'ext',
          detail: `rotation ${verdict.old} → ${verdict.new} published at ${proof.proof.channel_url} (ADR-0014 b)`,
        });
      }
    }
  }

  return {
    lostPersona: input.lostPersona,
    freshPersona: input.freshPersona,
    paths,
    recoverable: paths.length > 0,
    reason:
      paths.length > 0
        ? null
        : input.seedAvailable === false
          ? 'unrecoverable-by-design'
          : 'seed-not-established',
    rejected,
  };
}
