import type {
  BriefInput,
  BriefOutput,
  CommitInput,
  CommitOutput,
  ConfirmInput,
  ConfirmOutput,
  ExpectInput,
  ExpectOutput,
  OpenLoopItem,
  OpenLoopsInput,
  OpenLoopsOutput,
} from '@servanda/types';
import type { NodeClient } from './node-client.js';

/**
 * A stand-in node: §7 in, §7 out, nothing behind it.
 *
 * It ships in `src` rather than in one package's tests because all three surfaces are built
 * against it, and because the latency budget in gate GE has to be measured against
 * something that answers instantly — a slow stand-in would measure the stand-in.
 */
export interface FixtureState {
  readonly items: readonly OpenLoopItem[];
  readonly pending: readonly OpenLoopItem[];
  readonly brief: BriefOutput;
}

export class FixtureNodeClient implements NodeClient {
  readonly confirmed: ConfirmInput[] = [];

  constructor(private readonly state: FixtureState) {}

  async commit(input: CommitInput): Promise<CommitOutput> {
    return {
      commitment_hash: '0'.repeat(64),
      edge_id: input.propose ? '1'.repeat(64) : null,
      state: input.propose ? 'proposed' : 'vault-local',
    };
  }

  async expect(_input: ExpectInput): Promise<ExpectOutput> {
    return { expectation_id: 'exp-fixture' };
  }

  async confirm(input: ConfirmInput): Promise<ConfirmOutput> {
    this.confirmed.push(input);
    return {
      state: input.decision === 'confirm' ? 'confirmed' : input.decision === 'dismiss' ? 'dismissed' : 'revised',
    };
  }

  async open_loops(input: OpenLoopsInput): Promise<OpenLoopsOutput> {
    const all = input.view === 'all' ? this.state.items : this.state.items;
    return { items: all.slice(0, input.limit) };
  }

  async brief(_input: BriefInput): Promise<BriefOutput> {
    return this.state.brief;
  }

  pendingLoops(): OpenLoopsOutput {
    return { items: [...this.state.pending] };
  }
}

const NAMES = ['Dana Reyes', 'Marek Ilic', 'Priya Nandi', 'Tom Alderson', 'Ines Ferreira'];
const INTENTS = [
  'Send the revised quote for the warehouse fit-out',
  'Review the retry backoff change before it ships',
  'Return the signed lease addendum',
  'Share the migration plan with the operations team',
  'Book the follow-up with the auditors',
];

/**
 * A deterministic register. No clock, no randomness: the same call produces the same
 * fixture, so a latency number and a rendered surface are both reproducible.
 */
export function makeFixture(size = 24, now = '2026-03-01T09:00:00Z'): FixtureState {
  const nowMs = Date.parse(now);
  const items: OpenLoopItem[] = [];
  for (let i = 0; i < size; i++) {
    const waiting = i % 3 === 2;
    const closed = i % 7 === 6;
    const dueOffsetDays = (i % 11) - 4;
    const hasDue = i % 4 !== 3;
    const levels = ['0', '1', '2', '3', 'ext'] as const;
    items.push({
      kind: waiting ? 'expectation' : 'commitment',
      id: `item-${String(i).padStart(4, '0')}`,
      intent_or_expect: `${INTENTS[i % INTENTS.length]} (${i + 1})`,
      counterparty: i % 5 === 4 ? null : (NAMES[i % NAMES.length] ?? null),
      verification_level: levels[i % levels.length] ?? '0',
      age_days: (i * 3) % 40,
      due: hasDue ? new Date(nowMs + dueOffsetDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/u, 'Z') : null,
      state: closed ? 'closed' : waiting ? 'open' : i % 5 === 0 ? 'proposed' : 'open',
      actions: waiting ? ['ping', 'release'] : ['done', 'supersede', 'delegate'],
    });
  }

  const pending: OpenLoopItem[] = items.slice(0, 3).map((item, i) => ({
    ...item,
    id: `pending-${i}`,
    state: 'proposed',
    actions: [],
  }));

  const slots = items.slice(0, Math.min(6, items.length)).map((item) => ({
    headline: item.intent_or_expect,
    item_id: item.id,
    primary_action: { label: 'Mark as done', tool: 'confirm', args: { id: item.id } },
  }));

  return {
    items,
    pending,
    brief: {
      generated_at: now,
      slots,
      below_the_line_count: Math.max(0, items.length - slots.length),
    },
  };
}
