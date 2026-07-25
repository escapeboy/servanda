import { z } from 'zod';
import { PersonaId, Rfc3339, Sha256Hex, VerificationLevel } from './primitives.js';
import { EffectiveState } from './edge.js';

/**
 * §7 Node surface — the normative MCP contract. Clients are interchangeable above it.
 * These five tools are the minimum for the "conforming node" claim (§8).
 */

export const NODE_TOOL_NAMES = ['commit', 'expect', 'confirm', 'open_loops', 'brief'] as const;
export type NodeToolName = (typeof NODE_TOOL_NAMES)[number];

/** §7 commit */
export const CommitInput = z.object({
  intent: z.string().min(1).max(500),
  owed_to: z.string().nullable(),
  due: Rfc3339.nullable(),
  /** null = active persona. */
  persona: z.string().nullable().default(null),
  propose: z.boolean().default(false),
});
export type CommitInput = z.infer<typeof CommitInput>;

export const CommitOutput = z.object({
  commitment_hash: Sha256Hex,
  edge_id: Sha256Hex.nullable(),
  state: z.enum(['vault-local', 'proposed']),
});
export type CommitOutput = z.infer<typeof CommitOutput>;

/** §7 expect */
export const ExpectInput = z.object({
  expect: z.string().min(1),
  from: z.string().min(1),
  context: z.string().nullable().default(null),
});
export type ExpectInput = z.infer<typeof ExpectInput>;

export const ExpectOutput = z.object({ expectation_id: z.string() });
export type ExpectOutput = z.infer<typeof ExpectOutput>;

/** §7 confirm — serves inbound proposals and the local extraction-confirmation queue. */
export const ConfirmInput = z.object({
  id: z.string().min(1),
  decision: z.enum(['confirm', 'dismiss', 'edit']),
  edit: z
    .object({
      intent: z.string().min(1).max(500).optional(),
      due: Rfc3339.optional(),
    })
    .optional(),
});
export type ConfirmInput = z.infer<typeof ConfirmInput>;

export const ConfirmOutput = z.object({
  state: z.enum(['confirmed', 'dismissed', 'revised']),
});
export type ConfirmOutput = z.infer<typeof ConfirmOutput>;

/** §7 open_loops */
export const OpenLoopsView = z.enum(['owe', 'waiting', 'closed', 'all']);
export type OpenLoopsView = z.infer<typeof OpenLoopsView>;

export const OpenLoopAction = z.enum(['done', 'release', 'supersede', 'delegate', 'ping']);
export type OpenLoopAction = z.infer<typeof OpenLoopAction>;

export const OpenLoopsInput = z.object({
  view: OpenLoopsView.default('all'),
  persona: z.string().nullable().default(null),
  limit: z.number().int().positive().max(500).default(50),
});
export type OpenLoopsInput = z.infer<typeof OpenLoopsInput>;

export const OpenLoopItem = z.object({
  kind: z.enum(['commitment', 'expectation', 'edge']),
  id: z.string(),
  intent_or_expect: z.string(),
  counterparty: z.string().nullable(),
  /** M-12: clients MUST display this and MUST NOT render a name above its evidence level. */
  verification_level: VerificationLevel,
  age_days: z.number().nonnegative(),
  due: Rfc3339.nullable(),
  state: z.union([EffectiveState, z.enum(['vault-local', 'open', 'closed'])]),
  actions: z.array(OpenLoopAction),
});
export type OpenLoopItem = z.infer<typeof OpenLoopItem>;

export const OpenLoopsOutput = z.object({ items: z.array(OpenLoopItem) });
export type OpenLoopsOutput = z.infer<typeof OpenLoopsOutput>;

/** §7 brief */
export const BriefInput = z.object({
  /** null = all personas: the personal attention market. Ordering only, never content mixing (M-5). */
  persona: z.string().nullable().default(null),
});
export type BriefInput = z.infer<typeof BriefInput>;

export const BriefSlot = z.object({
  headline: z.string(),
  item_id: z.string(),
  primary_action: z.object({
    label: z.string(),
    tool: z.string(),
    args: z.record(z.unknown()),
  }),
  /** M-5 audit trail: which persona's pipeline produced this slot's content. */
  persona: PersonaId.optional(),
});
export type BriefSlot = z.infer<typeof BriefSlot>;

export const BriefOutput = z.object({
  generated_at: Rfc3339,
  slots: z.array(BriefSlot),
  below_the_line_count: z.number().int().nonnegative(),
});
export type BriefOutput = z.infer<typeof BriefOutput>;
