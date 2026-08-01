import { z } from 'zod';
import { matchesGlob, normalizeWorkspacePath } from '../capabilities.js';

/**
 * The trust gradient (execution-and-attention.md, security.md §2, §9.4).
 *
 * Two ideas do all the work here.
 *
 * **Autonomy is a measured quantity, not a permission.** There is no "allow the agent to do X"
 * setting and no `level` field anyone can write. A `TrustRecord` stores *history only* —
 * approvals, corrections, and the current unedited-approval streak — and the level is a pure
 * function of that history. `levelFromHistory` is the whole policy, and it is auditable because
 * you can recompute it from the record.
 *
 * **The ceiling is a property of the class, not of accumulated trust.** History moves a class
 * up the gradient; it can never move it past its ceiling. This is the answer to the patient
 * attacker of scenario 6: fifty flawless artifacts raise the streak and change nothing, because
 * `min(levelFromHistory, ceiling)` is still the ceiling. No amount of good behaviour is
 * convertible into reach.
 */

export const AUTONOMY_LEVELS = [
  'draft-for-review',
  'auto-apply-with-window',
  'silent-with-receipt',
] as const;

export const AutonomyLevel = z.enum(AUTONOMY_LEVELS);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

export function levelRank(level: AutonomyLevel): number {
  return AUTONOMY_LEVELS.indexOf(level);
}

export function minLevel(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
  return levelRank(a) <= levelRank(b) ? a : b;
}

/**
 * Unedited approvals required to reach each level. The gap between them is the asymmetry: one
 * correction resets the streak to zero, so recovering the top costs six approvals while losing
 * it costs one correction. Earned slowly, lost instantly (security.md §2).
 */
export const PROMOTION_THRESHOLDS: Readonly<Record<AutonomyLevel, number>> = {
  'draft-for-review': 0,
  'auto-apply-with-window': 3,
  'silent-with-receipt': 6,
};

/** How long an `auto-apply-with-window` artifact waits before it applies, unless stopped. */
export const AUTO_APPLY_WINDOW_HOURS = 24;

/**
 * Risk classes and their ceilings.
 *
 * security.md §2 names the family that "never reaches silent regardless of history": secrets,
 * auth code, CI config. A dependency bump is placed in that family here — narrowest reading,
 * and reported. The end-feeling paragraph in execution-and-attention.md lists dep-bumps among
 * the things that "close without you seeing them", which reads as permitting silent; but §9.4
 * and security.md §2 are the normative statements, and a dependency bump introduces third-party
 * code that will execute in CI and production, which is the supply-chain shape scenario 6's
 * patient attacker exploits. Where a narrative and a MUST disagree, the MUST wins.
 */
export const RISK_CLASSES = ['routine', 'supply-chain', 'sensitive'] as const;
export const RiskClass = z.enum(RISK_CLASSES);
export type RiskClass = z.infer<typeof RiskClass>;

export const RISK_CEILING: Readonly<Record<RiskClass, AutonomyLevel>> = {
  routine: 'silent-with-receipt',
  'supply-chain': 'auto-apply-with-window',
  sensitive: 'draft-for-review',
};

/**
 * Paths whose mere presence in an artifact caps it, whatever produced it. This is scenario 6's
 * "class CI config has a ceiling and never reaches silent, regardless of history" expressed
 * where it belongs — on the blast radius, not on the executor's name. No v1 executor holds a
 * write capability for any of these; the cap is the second lock on a door that has no handle.
 *
 * Every glob is position-independent. The CI ones were anchored at the repo root, which reads as
 * correct until the repo is a workspace: `packages/api/.github/workflows/ci.yml` runs CI exactly
 * as the root file does, and `apps/web/.env.production` is where the secrets actually are. Both
 * scored `routine` and reached silent. Where a file sits in the tree is not what makes it
 * sensitive.
 */
export const SENSITIVE_PATH_GLOBS: readonly string[] = [
  '**/.github/**',
  '**/.gitlab-ci.yml',
  '**/.circleci/**',
  '**/Jenkinsfile',
  '**/*.pem',
  '**/*.key',
  '**/.env',
  '**/.env.*',
  '**/secrets/**',
  '**/auth/**',
  '**/*secret*',
  '**/*credential*',
];

/**
 * Case-folded, and the asymmetry with `matchesGlob`'s other caller is the point.
 *
 * The capability lists are an ALLOWLIST: an exact match is what makes them safe, and folding case
 * there would widen what an executor may touch. This list is a DENYLIST, so the same exactness
 * inverts — `.ENV`, `src/AUTH/`, `Secrets/` all miss every glob and the artifact scores `routine`.
 * On macOS and Windows those name the same files as the lowercase forms, so the check waves through
 * exactly the file it exists to catch. A denylist that fails open is worse than no denylist,
 * because it reports a ceiling it did not apply.
 *
 * Folded here rather than in `matchesGlob`, which the allowlist must keep exact. BOTH sides fold:
 * the list itself is not all lowercase (`Jenkinsfile`), so folding only the path would drop the
 * entries that are not — trading one silent miss for another.
 */
export function isSensitivePath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path).toLowerCase();
  return SENSITIVE_PATH_GLOBS.some((glob) => matchesGlob(normalized, glob.toLowerCase()));
}

/** The ceiling for an artifact: the lower of its class's ceiling and its blast radius's. */
export function ceilingFor(riskClass: RiskClass, paths: readonly string[] = []): AutonomyLevel {
  const byClass = RISK_CEILING[riskClass];
  const touchesSensitive = paths.some(isSensitivePath);
  return touchesSensitive ? minLevel(byClass, RISK_CEILING.sensitive) : byClass;
}

/** History for one (human, work class). No level is stored — there is nothing to tamper with. */
export const TrustRecord = z
  .object({
    v: z.literal('servanda/0.2'),
    type: z.literal('trust_record'),
    /** The human. Trust is per-persona: it is *this* human's demonstrated review behaviour. */
    persona: z.string().regex(/^[0-9a-f]{64}$/),
    work_class: z.string().min(1),
    /** Unedited approvals since the last correction. The only thing that raises autonomy. */
    streak: z.number().int().min(0),
    approvals: z.number().int().min(0),
    /** Approvals that carried edits. They do not raise autonomy, and they do not collapse it. */
    edited_approvals: z.number().int().min(0),
    corrections: z.number().int().min(0),
    updated_at: z.string(),
  })
  .strict();
export type TrustRecord = z.infer<typeof TrustRecord>;

export function emptyTrustRecord(persona: string, workClass: string, now: string): TrustRecord {
  return TrustRecord.parse({
    v: 'servanda/0.2',
    type: 'trust_record',
    persona,
    work_class: workClass,
    streak: 0,
    approvals: 0,
    edited_approvals: 0,
    corrections: 0,
    updated_at: now,
  });
}

/** The policy, in one place: level is a function of the streak and nothing else. */
export function levelFromHistory(record: TrustRecord): AutonomyLevel {
  if (record.streak >= PROMOTION_THRESHOLDS['silent-with-receipt']) return 'silent-with-receipt';
  if (record.streak >= PROMOTION_THRESHOLDS['auto-apply-with-window']) {
    return 'auto-apply-with-window';
  }
  return 'draft-for-review';
}

export type ReviewOutcome =
  /** Approved with no edits — the only outcome that raises autonomy. */
  | { readonly kind: 'approved' }
  /** Approved, but the human changed the artifact first. Neither reward nor collapse. */
  | { readonly kind: 'approved-with-edits' }
  /** Rejected, reverted, or corrected after the fact. Collapses the streak (asymmetric). */
  | { readonly kind: 'corrected' };

export function applyOutcome(
  record: TrustRecord,
  outcome: ReviewOutcome,
  now: string,
): TrustRecord {
  switch (outcome.kind) {
    case 'approved':
      return { ...record, streak: record.streak + 1, approvals: record.approvals + 1, updated_at: now };
    case 'approved-with-edits':
      // An edit is a signal that the artifact was not right. It does not collapse the gradient,
      // but it certainly does not advance it — the streak stands still.
      return {
        ...record,
        edited_approvals: record.edited_approvals + 1,
        updated_at: now,
      };
    case 'corrected':
      // Asymmetric collapse: one correction returns the class to the floor. Regaining the top
      // costs `PROMOTION_THRESHOLDS['silent-with-receipt']` unedited approvals.
      return { ...record, streak: 0, corrections: record.corrections + 1, updated_at: now };
  }
}

/** How many unedited approvals one correction costs, at the given level. The asymmetry, as data. */
export function collapseCost(level: AutonomyLevel): number {
  return PROMOTION_THRESHOLDS[level];
}

export interface EffectiveAutonomyInput {
  readonly record: TrustRecord;
  readonly ceiling: AutonomyLevel;
  /**
   * Whether the commitment this artifact serves sits on an edge a verification adapter can
   * actually check. `null` means "no adapter" — which is not the same as "unfulfilled".
   */
  readonly edgeVerifiable: boolean | null;
}

export interface EffectiveAutonomy {
  readonly level: AutonomyLevel;
  readonly earned: AutonomyLevel;
  readonly ceiling: AutonomyLevel;
  /** Present when something below the earned level decided the outcome. */
  readonly cappedBy: 'ceiling' | 'unverifiable-edge' | null;
}

/**
 * The level that actually governs an artifact.
 *
 * M-8: an unverifiable edge MUST NOT auto-escalate. An executor artifact is a proposal, not a
 * verification, so when the underlying edge has no adapter — or has one that has not verified —
 * the artifact stays at draft-for-review no matter how much trust the class has earned. Autonomy
 * is permission to skip *review*, never permission to skip *evidence*.
 */
export function effectiveAutonomy(input: EffectiveAutonomyInput): EffectiveAutonomy {
  const earned = levelFromHistory(input.record);
  const capped = minLevel(earned, input.ceiling);
  if (input.edgeVerifiable !== true && capped !== 'draft-for-review') {
    return {
      level: 'draft-for-review',
      earned,
      ceiling: input.ceiling,
      cappedBy: 'unverifiable-edge',
    };
  }
  return {
    level: capped,
    earned,
    ceiling: input.ceiling,
    cappedBy: capped === earned ? null : 'ceiling',
  };
}
