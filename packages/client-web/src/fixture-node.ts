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
  /**
   * The three views §7 defines, held apart, because a real node holds them apart.
   *
   * `open_loops` here was `input.view === 'all' ? this.state.items : this.state.items` — a
   * ternary whose branches are the same expression, so every client test in this package ran
   * against a node that never bucketed anything. That is why the ledger's role inversion was
   * invisible for the whole of v0: the stand-in could not have exposed it.
   */
  readonly owe: readonly OpenLoopItem[];
  readonly waiting: readonly OpenLoopItem[];
  readonly closed: readonly OpenLoopItem[];
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
    const view =
      input.view === 'owe'
        ? this.state.owe
        : input.view === 'waiting'
          ? this.state.waiting
          : input.view === 'closed'
            ? this.state.closed
            : input.view === 'pending'
              ? this.state.pending
              : this.state.items;
    // `total` is the view's size, never the page's — a stand-in that returned the page size
    // would agree with a truncating node about everything and prove nothing about truncation.
    //
    // This PAGES, and it did not until a client learned to walk. `next_cursor` was the constant
    // `null` with a comment saying it "would stop being the true answer the moment a fixture
    // exceeded a page" — which is exactly the moment a paging test arrives. A stand-in that
    // cannot page cannot fail a client that does not, and this file already carries the scar of
    // that: `open_loops` was once `input.view === 'all' ? this.state.items : this.state.items`,
    // and the ledger's role inversion stayed invisible for the whole of v0 because of it.
    //
    // The cursor is an OFFSET, not a keyset. That is a deliberate limit and worth naming: a real
    // node freezes a ranking instant so removals do not shift the boundary, and an offset does
    // not model that. What this proves is that the client keeps asking until told to stop, which
    // is the client's half of the contract; §7's ordering guarantees are the node's, and
    // `packages/node/test/open-loops-paging.test.ts` is where those are tested.
    // `null` AND `undefined` both mean "start": §7 gives `cursor` a default of null, so a
    // caller who omits it is asking for the first page. Treating only `null` as the start
    // turned every existing call site into `unreadable cursor: undefined`.
    const from = input.cursor === null || input.cursor === undefined ? 0 : Number.parseInt(input.cursor, 10);
    if (!Number.isInteger(from) || from < 0) throw new Error(`unreadable cursor: ${input.cursor}`);
    const items = view.slice(from, from + input.limit);
    const next = from + items.length;
    return {
      items,
      total: view.length,
      // `null` MEANS "the view is finished" — it is a statement, not an absence, so it is emitted
      // only when the walk really is over rather than whenever a page comes back short.
      next_cursor: next >= view.length ? null : String(next),
      skipped: 0,
    };
  }

  async brief(_input: BriefInput): Promise<BriefOutput> {
    return this.state.brief;
  }

  pendingLoops(): OpenLoopsOutput {
    return {
      items: [...this.state.pending],
      total: this.state.pending.length,
      next_cursor: null,
      skipped: 0,
    };
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
    const itemId = `item-${String(i).padStart(4, '0')}`;
    items.push({
      // A promise made TO you is an `edge` — the same kind the promise you made carries, because
      // an edge is one object with two parties. The fixture used to make every waiting item an
      // `expectation`, which is the ONE shape where `kind` happens to imply the role, so the
      // client's `kind === 'expectation'` test looked correct here and inverted the register in
      // production. Half the waiting items are edges now, and they are the half that matters.
      kind: waiting ? (i % 2 === 0 ? 'edge' : 'expectation') : 'commitment',
      id: itemId,
      intent_or_expect: `${INTENTS[i % INTENTS.length]} (${i + 1})`,
      // v0.2 (#39): the fixture must exercise BOTH origins, or a client that ignores the
      // distinction passes on it. Attested names sit on the name-bearing levels; the rest are
      // labels the viewer typed, which are rendered at any level and never suppressed.
      counterparty:
        i % 5 === 4
          ? null
          : {
              value: NAMES[i % NAMES.length] ?? 'someone',
              origin: (levels[i % levels.length] === '2' || levels[i % levels.length] === '3'
                ? 'attested'
                : 'self-labelled') as 'attested' | 'self-labelled',
            },
      verification_level: levels[i % levels.length] ?? '0',
      age_days: (i * 3) % 40,
      due: hasDue ? new Date(nowMs + dueOffsetDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/u, 'Z') : null,
      state: closed ? 'closed' : waiting ? 'open' : i % 5 === 0 ? 'proposed' : 'open',
      actions: waiting
        ? [
            { act: 'release' as const, tool: 'act' as const, args: { id: itemId, act: 'release' } },
            { act: 'ping' as const, tool: null, args: {} },
            { act: 'supersede' as const, tool: null, args: {} },
          ]
        : [
            { act: 'done' as const, tool: 'act' as const, args: { id: itemId, act: 'done' } },
            { act: 'supersede' as const, tool: null, args: {} },
            { act: 'delegate' as const, tool: null, args: {} },
          ],
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
    primary_action: { act: 'done' as const, tool: 'act' as const, args: { id: item.id, act: 'done' } },
  }));

  // Bucketed the way `ServandaNode.itemsFor` buckets: closed wins over role, and role is the
  // fixture's own `waiting`, never re-derived from `kind`.
  const isClosed = (item: OpenLoopItem) => item.state === 'closed';
  const wasWaiting = new Set(items.filter((_, i) => i % 3 === 2).map((item) => item.id));

  return {
    items,
    owe: items.filter((item) => !isClosed(item) && !wasWaiting.has(item.id)),
    waiting: items.filter((item) => !isClosed(item) && wasWaiting.has(item.id)),
    closed: items.filter(isClosed),
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
