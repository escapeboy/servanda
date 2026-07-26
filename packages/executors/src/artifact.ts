import { z } from 'zod';
import { PROTOCOL_VERSION } from '@servanda/types';
import { AutonomyLevel, RiskClass } from './trust/gradient.js';

/**
 * The only thing an executor run can produce: a draft PR awaiting a human.
 *
 * `draft: z.literal(true)` is the load-bearing line. A non-draft artifact is not a thing this
 * type can describe, so "never merges, never sends, never acts outward" is not a rule the code
 * follows — it is a shape the code cannot express. Likewise `signed_by: z.null()`: automation
 * acts under a persona and never as one (M-13), and the schema has no room for a signature.
 *
 * Scenario 6's last line is this object: "even if all that fell, the artifact is a draft PR
 * awaiting a signature."
 */

export const FileChangeRecord = z
  .object({
    path: z.string().min(1),
    kind: z.enum(['added', 'modified', 'deleted']),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
  })
  .strict();
export type FileChangeRecord = z.infer<typeof FileChangeRecord>;

export const AutonomyDecision = z
  .object({
    level: AutonomyLevel,
    /** What history alone would have granted, before ceilings. Shown so the cap is auditable. */
    earned: AutonomyLevel,
    ceiling: AutonomyLevel,
    capped_by: z.enum(['ceiling', 'unverifiable-edge']).nullable(),
    /**
     * When `level` is `auto-apply-with-window`, the instant after which it would apply unless
     * stopped. Null at every other level — a draft has no clock, and a silent artifact has no
     * window. Nothing in this package acts on it; it is a statement for the human.
     */
    applies_at: z.string().nullable(),
  })
  .strict();
export type AutonomyDecision = z.infer<typeof AutonomyDecision>;

export const DraftPrArtifact = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal('draft_pr_artifact'),

    executor_class: z.string().min(1),
    risk_class: RiskClass,
    /** §3.2 hash of the promise this serves. The plaintext stays in the vault (M-7). */
    commitment_hash: z.string().regex(/^[0-9a-f]{64}$/),

    /** M-13: the persona the automation acted under. */
    acting_under: z.string().regex(/^[0-9a-f]{64}$/),
    /** M-13: automation is never a party, so this is null and the schema admits nothing else. */
    signed_by: z.null(),

    /** Not a default. There is no other permitted value. */
    draft: z.literal(true),

    base: z
      .object({
        repo_path: z.string().min(1),
        base_commit: z.string().min(1),
        base_branch: z.string().min(1),
      })
      .strict(),
    branch: z.string().min(1),
    title: z.string().min(1).max(120),
    body: z.string().min(1),

    changes: z.array(FileChangeRecord),
    diff: z.string(),

    /** The world this run was given, recorded so a reviewer can see it was not widened. */
    capabilities: z
      .object({
        read: z.array(z.string()),
        write: z.array(z.string()),
        max_changed_lines: z.number().int().positive(),
        max_changed_files: z.number().int().positive(),
      })
      .strict(),

    autonomy: AutonomyDecision,
    created_at: z.string(),
  })
  .strict();
export type DraftPrArtifact = z.infer<typeof DraftPrArtifact>;

/** The outcome of one run: an artifact, or an honest nothing. */
export type ExecutionOutcome =
  | { readonly kind: 'artifact'; readonly artifact: DraftPrArtifact }
  | { readonly kind: 'nothing-to-do'; readonly executorClass: string; readonly reason: string }
  | { readonly kind: 'refused'; readonly executorClass: string; readonly reason: string };
