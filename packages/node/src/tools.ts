import {
  ACT_TOOL_ACTS,
  ActInput,
  BriefInput,
  CommitInput,
  ConfirmInput,
  ExpectInput,
  NODE_TOOL_NAMES,
  OpenLoopsInput,
  type NodeToolName,
} from '@servanda/types';
import { assertNoForeignOwner, type ServandaNode } from './node.js';

/**
 * §7 — the six tools, exactly. "Additional tools MAY be exposed; these six are the minimum
 * for the 'conforming node' claim (§8)." This module exposes exactly the six.
 *
 * The JSON Schemas below are hand-written from the §7 contract rather than generated, so that
 * what a client sees is the spec's shape and not zod's rendering of it.
 */

export interface ToolDefinition {
  name: NodeToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

const nullableString = { type: ['string', 'null'] } as const;

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'commit',
    description:
      'Record a promise you are making. The owner is always your persona (M-1) — for what ' +
      'someone else said they would do, use `expect`. `propose:true` requires `owed_to` to ' +
      'resolve to a persona; otherwise the record stays vault-local.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', maxLength: 500 },
        owed_to: nullableString,
        due: nullableString,
        persona: nullableString,
        propose: { type: 'boolean', default: false },
      },
      required: ['intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'expect',
    description:
      'Record what you are waiting on from someone else. Never appears in any wire message ' +
      '(ADR-0013); escalates only to you.',
    inputSchema: {
      type: 'object',
      properties: {
        expect: { type: 'string' },
        from: { type: 'string' },
        context: nullableString,
      },
      required: ['expect', 'from'],
      additionalProperties: false,
    },
  },
  {
    name: 'confirm',
    description:
      'Decide on an inbound proposal or a queued extraction: confirm, dismiss, or edit.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        decision: { type: 'string', enum: ['confirm', 'dismiss', 'edit'] },
        edit: {
          type: 'object',
          properties: { intent: { type: 'string', maxLength: 500 }, due: { type: 'string' } },
          additionalProperties: false,
        },
      },
      required: ['id', 'decision'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_loops',
    description: 'List what you owe, what you are waiting on, or what has closed.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['owe', 'waiting', 'closed', 'all'], default: 'all' },
        persona: nullableString,
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'brief',
    description:
      'The attention market: what deserves attention now. `persona:null` orders across ' +
      'personas; each slot’s content comes from exactly one persona’s pipeline (M-5).',
    inputSchema: {
      type: 'object',
      properties: { persona: nullableString },
      additionalProperties: false,
    },
  },
  {
    name: 'act',
    description:
      'Sign the act that closes a loop. `done` is the owner’s and records delivery; ' +
      '`release` is the counterparty’s and gives up the claim. Every other act on an item ' +
      'belongs to another tool or to no tool at all, and is refused here by name.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        act: { type: 'string', enum: ACT_TOOL_ACTS },
        evidence_hash: { type: ['string', 'null'] },
      },
      required: ['id', 'act'],
      additionalProperties: false,
    },
  },
];

export class UnknownToolError extends Error {
  override name = 'UnknownToolError';
}

/** Dispatch a §7 tool call. Input is parsed by the spec's own zod schema before it reaches L1. */
export function callTool(node: ServandaNode, name: string, args: unknown): unknown {
  const input = (args ?? {}) as Record<string, unknown>;
  switch (name as NodeToolName) {
    case 'commit':
      // M-1 is checked before the schema, so an `owner` key is REJECTED rather than stripped.
      // Silent stripping would tell a rude client it had recorded someone else's promise.
      assertNoForeignOwner(input);
      return node.commit(CommitInput.parse(input));
    case 'expect':
      return node.expect(ExpectInput.parse(input));
    case 'confirm':
      return node.confirm(ConfirmInput.parse(input));
    case 'open_loops':
      return node.openLoops(OpenLoopsInput.parse(input));
    case 'brief':
      return node.brief(BriefInput.parse(input));
    case 'act':
      return node.act(ActInput.parse(input));
    default:
      throw new UnknownToolError(`no such tool: ${name}. §7 defines exactly ${NODE_TOOL_NAMES.join(', ')}`);
  }
}
