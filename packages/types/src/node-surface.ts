import { z } from 'zod';
import { ExternalLabel, PersonaId, PublicKeyHex, Rfc3339, Sha256Hex, VerificationLevel } from './primitives.js';
import { EffectiveState } from './edge.js';

/**
 * §7 Node surface — the normative MCP contract. Clients are interchangeable above it.
 * These six tools are the minimum for the "conforming node" claim (§8).
 *
 * `act` is the sixth and the only one that signs an assertion. Before it existed a promise could
 * be recorded through this contract and never closed through it — the gap upstream #19 named.
 */

export const NODE_TOOL_NAMES = ['commit', 'expect', 'confirm', 'open_loops', 'brief', 'act'] as const;
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
export const OpenLoopsView = z.enum(['owe', 'waiting', 'closed', 'pending', 'all']);
export type OpenLoopsView = z.infer<typeof OpenLoopsView>;

export const OpenLoopAction = z.enum(['done', 'release', 'supersede', 'delegate', 'ping']);
export type OpenLoopAction = z.infer<typeof OpenLoopAction>;

/**
 * §7 — the shared act vocabulary, and which tool (if any) each act is bound to.
 *
 * Only `done` and `release` reach the `act` tool. `confirm` and `dismiss` belong to `confirm`.
 * The remaining four are advertised on items but bind to no tool in v0: a client may show them,
 * and a node MUST NOT accept them through `act`.
 *
 * That asymmetry is the point of upstream #19. `open_loops` used to advertise five actions and
 * name a tool for none of them, so `release` — the one unilateral act in the protocol — appeared
 * on every waiting item with no way to sign it. Binding an act to nothing at all is honest;
 * binding it to something that produces no assertion tells a person they forgave a debt the
 * counterparty never heard about.
 */
export const ACT_TOOL_BINDINGS = {
  done: 'act',
  release: 'act',
  supersede: null,
  delegate: null,
  ping: null,
  confirm: 'confirm',
  dismiss: 'confirm',
  propose: null,
} as const satisfies Record<string, 'act' | 'confirm' | null>;

export const Act = z.enum(
  Object.keys(ACT_TOOL_BINDINGS) as [keyof typeof ACT_TOOL_BINDINGS, ...(keyof typeof ACT_TOOL_BINDINGS)[]],
);
export type Act = z.infer<typeof Act>;

/** The acts `act` itself will sign. Derived, so the binding table stays the single source. */
export const ACT_TOOL_ACTS = Object.entries(ACT_TOOL_BINDINGS)
  .filter(([, tool]) => tool === 'act')
  .map(([act]) => act) as ('done' | 'release')[];

/** §7 act — the only tool that signs an assertion. */
export const ActInput = z.object({
  id: z.string().min(1),
  act: Act,
  /** Required for `done`, MUST be null for `release`. */
  evidence_hash: Sha256Hex.nullable().default(null),
});
export type ActInput = z.infer<typeof ActInput>;

/**
 * Why an `act` call was refused. Three of these are the §4.3 chain vocabulary reused verbatim —
 * the transition table is the single authority and `act` defers to it rather than re-deciding.
 * The four new ones are §7-surface conditions the chain never sees, because a refused call signs
 * nothing and therefore leaves no assertion to reject.
 */
export const ActRejectionReason = z.enum([
  'not-a-party',
  'wrong-role-for-act',
  'act-not-bound-to-a-tool',
  'evidence-hash-must-be-null',
  'evidence-hash-required',
  'acceptance-window-not-elapsed',
  'illegal-source-state',
]);
export type ActRejectionReason = z.infer<typeof ActRejectionReason>;

export const ActOutput = z.object({
  accepted: z.boolean(),
  rejection_reason: ActRejectionReason.nullable(),
  /** The state signed, when accepted. */
  asserts: z.enum(['closed', 'released']).nullable(),
});
export type ActOutput = z.infer<typeof ActOutput>;

/**
 * §7 — one advertised affordance: what it is, which tool signs it, and with what arguments.
 *
 * There is no `label`. M-21: no user-facing copy crosses the node surface, so a client maps the
 * act to its own wording. `tool: null` means the act is real but v0 binds it to nothing — the
 * client may show it and MUST NOT invent a binding.
 */
export const ItemAction = z
  .object({
    act: Act,
    tool: z.enum(['act', 'confirm']).nullable(),
    args: z.record(z.unknown()),
  })
  /**
   * STRICT, and the oracle is why. zod strips unknown keys by default, so a `label` arriving from
   * another node was silently dropped: this node would never emit one, and a client using these
   * types to read someone else's brief could never DETECT one either. Stripping is not rejecting.
   * `node-surface/brief-slots.json` requires the slot to be refused, and the normative schema says
   * `additionalProperties: false`.
   */
  .strict()
  /**
   * The binding table is the authority, so the schema consults it rather than restating it.
   *
   * Without this, `{act: 'supersede', tool: 'act'}` parsed happily — an advertised call to a tool
   * that signs nothing, which is M-20's whole subject. Unlike the acceptance-window rule, this one
   * belongs in the schema: `ACT_TOOL_BINDINGS` lives in this module and no transition table has a
   * better claim to own it.
   */
  .refine((a) => a.tool === ACT_TOOL_BINDINGS[a.act], {
    message: 'M-20: an act must name the tool it is bound to, or null',
    path: ['tool'],
  })
  /** §7: where `tool` is null there is no call to make, so there is nothing to make it with. */
  .refine((a) => a.tool !== null || Object.keys(a.args).length === 0, {
    message: '§7: an act bound to no tool carries no arguments',
    path: ['args'],
  });
export type ItemAction = z.infer<typeof ItemAction>;

export const OpenLoopsInput = z.object({
  view: OpenLoopsView.default('all'),
  persona: z.string().nullable().default(null),
  limit: z.number().int().positive().max(500).default(50),
});
export type OpenLoopsInput = z.infer<typeof OpenLoopsInput>;

export const OpenLoopItem = z.object({
  kind: z.enum(['commitment', 'expectation', 'edge']),
  id: z.string(),
  /**
   * Bounded like every other §3.1 string, and these two were the exceptions.
   *
   * `intent` is `.max(500)` where it is written and `ExternalLabel` is `.max(200)`, but the values
   * came back across the node surface as bare `z.string()` — unbounded and unscrubbed. A client is
   * the last stop, and every client here renders both: a 200 KB intent, or an ANSI SGR sequence
   * inside a counterparty name, arrived as a well-formed OpenLoopItem. Two of the M-12 defects
   * found by adversarial testing entered through exactly this door, and were patched at the
   * renderers; this is the door.
   *
   * The bounds MIRROR the write side rather than inventing numbers — a value that could be stored
   * must be able to come back.
   */
  intent_or_expect: z.string().max(500),
  counterparty: ExternalLabel.or(PublicKeyHex).nullable(),
  /** M-12: clients MUST display this and MUST NOT render a name above its evidence level. */
  verification_level: VerificationLevel,
  age_days: z.number().nonnegative(),
  due: Rfc3339.nullable(),
  state: z.union([EffectiveState, z.enum(['vault-local', 'open', 'closed'])]),
  actions: z.array(ItemAction),
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
  /**
   * M-21: a person's own recorded words are CONTENT, not copy — the headline is the commitment's
   * intent as they wrote it, rendered verbatim. That is why this field survives while
   * `primary_action.label` did not: one carries what someone said, the other told the client how
   * to word its own button.
   */
  headline: z.string(),
  item_id: z.string(),
  /**
   * M-21: no display wording crosses the surface. This was `{label, tool, args}` and the `label`
   * invited clients to render a string that arrived over a connection (upstream #20). It is the
   * same `{act, tool, args}` shape `open_loops` advertises, so a client has one mapping from act
   * to its own copy and not two.
   */
  primary_action: ItemAction.nullable(),
  /** M-5 audit trail: which persona's pipeline produced this slot's content. */
  persona: PersonaId.optional(),
})
  /** Strict for the same reason `ItemAction` is: copy one level up is the same violation. */
  .strict();
export type BriefSlot = z.infer<typeof BriefSlot>;

export const BriefOutput = z.object({
  generated_at: Rfc3339,
  slots: z.array(BriefSlot),
  below_the_line_count: z.number().int().nonnegative(),
});
export type BriefOutput = z.infer<typeof BriefOutput>;
