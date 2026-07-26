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
import type { IntegrationsInput } from './integrations.js';
import type { NodeClient } from './node-client.js';
import type { ProofRecord } from './proof.js';
import type { TeamInput } from './team.js';

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

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const TEAM_SCOPE = 'c'.repeat(64);
const OTHER_SCOPE = 'd'.repeat(64);

/**
 * A closed cross-org promise, as scenarios §5 leaves it: both signatures, an acceptance
 * window, a dispute, a fix, and a close. The plaintext is `null` by default because that is
 * the state an old promise is actually in once its keeping period has passed (§5.4) — and
 * the proof page has to be right in that state first, not as an afterthought.
 */
export function makeProofFixture(overrides: Partial<ProofRecord> = {}): ProofRecord {
  return {
    edge_id: '7'.repeat(64),
    commitment_hash: '3'.repeat(64),
    proposed_at: '2026-06-02T10:15:00Z',
    due: '2026-09-30T00:00:00Z',
    owner: { key: KEY_A, display: 'Studio (studio.bg)', verification_level: '3' },
    owed_to: { key: KEY_B, display: 'Acme (acme.com)', verification_level: '3' },
    chain: [
      { state: 'proposed', asserted_at: '2026-06-02T10:15:00Z', by: KEY_A, evidence_hash: null },
      { state: 'confirmed', asserted_at: '2026-06-02T16:40:00Z', by: KEY_B, evidence_hash: null },
      { state: 'disputed', asserted_at: '2026-10-01T09:00:00Z', by: KEY_B, evidence_hash: '4'.repeat(64) },
      { state: 'closed', asserted_at: '2026-10-06T11:20:00Z', by: KEY_B, evidence_hash: '5'.repeat(64) },
    ],
    plaintext: null,
    ...overrides,
  };
}

export const TEAM_SCOPE_KEY = TEAM_SCOPE;
export const OTHER_SCOPE_KEY = OTHER_SCOPE;

/**
 * A team surface's input, deliberately mixed: one promise shared here, one shared into a
 * different scope, one nobody shared at all. Every test of M-4 in this layer starts from a
 * register that contains things the surface must not show.
 */
export function makeTeamFixture(now = '2026-03-01T09:00:00Z'): TeamInput {
  const base = makeFixture(6, now).items;
  const at = (i: number): OpenLoopItem => base[i] ?? (base[0] as OpenLoopItem);
  return {
    scope: { key: TEAM_SCOPE, label: 'Platform' },
    publications: [
      {
        // Scenarios §4, near enough. Deliberately avoids the word "staging", which an
        // existing affordance test scans for as a substring and would flag as "tag".
        item: { ...at(0), id: 'shared-here', intent_or_expect: 'Pull a copy of live data for the repro' },
        shared: { scope: TEAM_SCOPE, by: KEY_A },
        otherParty: { display: 'Stefan Vidal', level: '2' },
        blocks: ['SPRINT-114'],
      },
      {
        item: { ...at(1), id: 'shared-elsewhere', intent_or_expect: 'Draft the pricing note' },
        shared: { scope: OTHER_SCOPE, by: KEY_B },
        otherParty: { display: 'Ines Ferreira', level: '1' },
        blocks: [],
      },
      {
        item: { ...at(2), id: 'never-shared', intent_or_expect: 'Reply to the recruiter' },
        shared: null,
        otherParty: { display: 'Tom Alderson', level: '0' },
        blocks: [],
      },
    ],
  };
}

/** Sources and gradients, including one kind of work with a ceiling below the top rung. */
export function makeIntegrationsFixture(): IntegrationsInput {
  return {
    sources: [
      { id: 'mail', label: 'Mail', connected: true, lastRead: '2026-03-01T08:40:00Z' },
      { id: 'code-review', label: 'Code review', connected: true, lastRead: null },
      { id: 'calendar', label: 'Calendar', connected: false, lastRead: null },
    ],
    classes: [
      { id: 'tests', label: 'Writing tests', standing: 'draft', toNextRung: 2 },
      { id: 'dead-code', label: 'Removing dead code', standing: 'window', toNextRung: 5 },
      { id: 'ci-config', label: 'Changing how the build runs', standing: 'suggest', toNextRung: 3, ceiling: 'draft' },
    ],
  };
}

/** Twelve words, fixed, so a printed sheet is reproducible in a test. */
export const RECOVERY_WORDS: readonly string[] = [
  'harbour', 'kettle', 'marble', 'orchard', 'plover', 'quarry',
  'ribbon', 'saddle', 'thistle', 'umber', 'vellum', 'walnut',
];
