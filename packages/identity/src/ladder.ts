import type { VerificationLevel } from '@servanda/types';
import { VERIFICATION_LEVEL_LABELS } from '@servanda/types';
import type { AttestationVerdict } from './attestation.js';
import type { AnchorResolution } from './anchor.js';
import { anchorsOrgRoot } from './anchor.js';
import type { BindingProofVerdict } from './binding-proof.js';

/**
 * §1.6 binding-proof ladder — evidence in, level out. A pure function: no clock, no I/O, no
 * ambient state. Everything time-dependent (is the attestation expired? did the anchor
 * resolve?) has already been decided by the modules that own those questions.
 *
 * | Level | Evidence |
 * |---|---|
 * | 0 unconfirmed    | none |
 * | 1 continuity     | ≥1 prior confirmed edge with this key |
 * | 2 attested       | valid, unrevoked org attestation |
 * | 3 domain-verified| level 2 + org root domain-anchored |
 * | ext external-proof | signed statement published on a controlled external channel |
 *
 * M-12 is enforced structurally rather than by discipline: `VerifiedIdentity` is the only
 * carrier of a display name in this package, it can only be produced by `bindingLevel`, and
 * the name is read out of the evidence in the same expression that fixes the level. There is
 * no argument by which a caller can ask for a name at a level that has not earned it, and no
 * exported constructor that lets one be assembled by hand.
 */

/**
 * RESOLVED. §1.6 once listed the numeric levels "ascending" and gave `ext` no rank relative to
 * them, so this order was a decision taken here: `ext` above continuity and below attested,
 * because a binding proof is the persona's own signature on a channel it controls —
 * self-assertion — while an attestation is a third party staking its key, and where the spec is
 * silent self-assertion must not outrank a third party.
 *
 * `node-surface/verification-levels.json` now pins `0 < 1 < ext < 2 < 3` with that same
 * reasoning, and `packages/identity/test/musts/M-12.test.ts` replays it. The local reading became
 * the rule, which is why the ranks below are no longer ours to change.
 */
export const LEVEL_RANK: Readonly<Record<VerificationLevel, number>> = Object.freeze({
  '0': 0,
  '1': 1,
  ext: 2,
  '2': 3,
  '3': 4,
});

/** A level was available but the evidence failed. Clients can show why the badge is low. */
export interface Downgrade {
  readonly level: VerificationLevel;
  readonly reason: string;
  readonly detail: string | null;
}

export interface LadderEvidence {
  /** The persona or group key being graded. */
  readonly subject: string;
  /**
   * §1.6 level 1: "≥1 prior confirmed edge with this key". A count, not a boolean, so the
   * caller cannot pass a truthy object it never looked at.
   */
  readonly priorConfirmedEdges?: number;
  /** The org attestation verdict from `verifyAttestation`, already time-resolved. */
  readonly attestation?: AttestationVerdict | null;
  /** The §1.5 anchor resolution for the org's domain, already fetched (or already failed). */
  readonly anchor?: AnchorResolution | null;
  /** The §1.6 external binding proof verdict, already observed on its channel. */
  readonly bindingProof?: BindingProofVerdict | null;
}

/** How a key is shown when no evidence carries a name. Never dressed up as a name. */
export function shortKey(key: string): string {
  return key.length <= 16 ? key : `${key.slice(0, 8)}…${key.slice(-8)}`;
}

/**
 * Held only by this module. `private constructor` is erased at compile time; this token is the
 * runtime half, so "a VerifiedIdentity can only come from the grader" survives into JS.
 */
const GRADED = Symbol('VerifiedIdentity.grade');

/**
 * The result of grading one key. Constructed only by `bindingLevel`.
 *
 * `displayName` is null at every level whose evidence does not carry a name, which is levels
 * 0, 1 and ext — a binding proof binds a key to a *channel*, never to a human name. Callers
 * that want something to put on screen use `render`, which falls back to the short key.
 */
export class VerifiedIdentity {
  readonly subject: string;
  readonly level: VerificationLevel;
  readonly levelLabel: string;
  readonly achieved: readonly VerificationLevel[];
  readonly downgrades: readonly Downgrade[];
  readonly displayName: string | null;
  readonly handle: string | null;
  readonly attestedBy: string | null;
  readonly anchoredDomain: string | null;
  readonly externalChannel: string | null;

  private constructor(
    token: symbol,
    fields: {
      subject: string;
      level: VerificationLevel;
      achieved: readonly VerificationLevel[];
      downgrades: readonly Downgrade[];
      displayName: string | null;
      handle: string | null;
      attestedBy: string | null;
      anchoredDomain: string | null;
      externalChannel: string | null;
    },
  ) {
    if (token !== GRADED) {
      throw new TypeError(
        'M-12: a VerifiedIdentity is produced only by bindingLevel(evidence). A name and the ' +
          'level that stands behind it are decided together or not at all.',
      );
    }
    this.subject = fields.subject;
    this.level = fields.level;
    this.levelLabel = VERIFICATION_LEVEL_LABELS[fields.level];
    this.achieved = Object.freeze([...fields.achieved]);
    this.downgrades = Object.freeze([...fields.downgrades]);
    this.displayName = fields.displayName;
    this.handle = fields.handle;
    this.attestedBy = fields.attestedBy;
    this.anchoredDomain = fields.anchoredDomain;
    this.externalChannel = fields.externalChannel;
    Object.freeze(this);
  }

  /** What a client may put on screen for this key, with the level that stands behind it. */
  get render(): {
    readonly name: string;
    readonly isKey: boolean;
    readonly level: VerificationLevel;
    readonly levelLabel: string;
  } {
    const name = this.displayName;
    return {
      name: name ?? shortKey(this.subject),
      isKey: name === null,
      level: this.level,
      levelLabel: this.levelLabel,
    };
  }

  /** True when this identity carries a human name — i.e. when its level's evidence has one. */
  get hasName(): boolean {
    return this.displayName !== null;
  }

  /**
   * §1.6, evaluated. The single place a level and a name are decided together.
   */
  static grade(evidence: LadderEvidence): VerifiedIdentity {
    const achieved: VerificationLevel[] = ['0'];
    const downgrades: Downgrade[] = [];

    const priors = evidence.priorConfirmedEdges ?? 0;
    if (priors >= 1) achieved.push('1');

    const att = evidence.attestation ?? null;
    const attested = att !== null && att.ok ? att : null;
    if (attested !== null) achieved.push('2');
    else if (att !== null && !att.ok) {
      downgrades.push({ level: '2', reason: att.reason, detail: att.detail });
    }

    const anchor = evidence.anchor ?? null;
    let anchoredDomain: string | null = null;
    if (attested !== null) {
      const org = attested.attestation.org;
      if (anchor === null) {
        // No anchor was even looked for. Not a downgrade — level 3 was never in play.
      } else if (!anchor.ok) {
        downgrades.push({ level: '3', reason: `anchor:${anchor.reason ?? 'unknown'}`, detail: anchor.domain });
      } else if (!anchorsOrgRoot(anchor, org)) {
        // GATE GG/2: an anchor for a *different* org root proves nothing about this org.
        downgrades.push({
          level: '3',
          reason: 'anchor:org-root-mismatch',
          detail: `${anchor.domain} anchors ${anchor.anchor?.org_root ?? 'nothing'}, attestation is by ${org}`,
        });
      } else {
        achieved.push('3');
        anchoredDomain = anchor.domain;
      }
    } else if (anchor !== null && anchor.ok) {
      // A resolvable anchor with no valid attestation is level 3 evidence with its level-2
      // prerequisite missing. §1.6 makes 3 = "level 2 + anchored", so it confers nothing.
      downgrades.push({ level: '3', reason: 'anchor:no-attestation-to-anchor', detail: anchor.domain });
    }

    const proof = evidence.bindingProof ?? null;
    let externalChannel: string | null = null;
    if (proof !== null && proof.ok) {
      achieved.push('ext');
      externalChannel = proof.proof.channel_url;
    } else if (proof !== null) {
      downgrades.push({ level: 'ext', reason: proof.reason, detail: proof.detail });
    }

    const level = achieved.reduce((best, l) => (LEVEL_RANK[l] > LEVEL_RANK[best] ? l : best), '0' as VerificationLevel);

    // M-12, structurally: the ONLY branch that lets a human name out of this function requires
    // the level that carries it. `claims.display_name` is an org's assertion (§1.3/§9), so it
    // travels only at the levels an org attestation establishes.
    const nameBearing = (level === '2' || level === '3') && attested !== null;
    const displayName = nameBearing ? attested.attestation.claims.display_name ?? null : null;
    const handle = nameBearing ? attested.attestation.claims.handle ?? null : null;

    return new VerifiedIdentity(GRADED, {
      subject: evidence.subject,
      level,
      achieved,
      downgrades,
      displayName,
      handle,
      attestedBy: attested !== null ? attested.attestation.org : null,
      anchoredDomain,
      externalChannel,
    });
  }
}

/**
 * §1.6 as a pure function: evidence in, level out.
 *
 * Returns the name and the level together, from one call — the illegal state "a name without
 * its evidence" has no representation to be constructed from.
 */
export function bindingLevel(evidence: LadderEvidence): VerifiedIdentity {
  return VerifiedIdentity.grade(evidence);
}
