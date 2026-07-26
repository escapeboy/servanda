import { COPY } from './copy.js';
import type { ActionView } from './view.js';

/**
 * Integrations & Trust — the fourth view of the one surface.
 *
 * Doctrine, twice, and both halves are structural here:
 *
 * > Trust sliders are displayed but earned; locked rungs explain what unlocks them.
 *
 * So a rung is a *reading*, not a control. `RungView` has no action, no dispatch and no id
 * anything could bind a handler to, and `rungsFor` takes what the work has earned as its
 * only input. There is no argument to any function in this file by which a caller could
 * grant leeway — the way to move up a rung is to do the work that moves it. A locked rung
 * says what would open it, because a lock with no explanation is just a closed door.
 *
 * The one thing this surface *does* control is where promises come from: connecting or
 * disconnecting a source. That is a source of information, not a permission to act.
 */

export const GRADIENT_RUNGS = ['suggest', 'draft', 'window', 'silent'] as const;
export type GradientRung = (typeof GRADIENT_RUNGS)[number];

export const RUNG_RANK: Record<GradientRung, number> = {
  suggest: 0,
  draft: 1,
  window: 2,
  silent: 3,
};

export interface SourceInput {
  readonly id: string;
  readonly label: string;
  readonly connected: boolean;
  /** When it was last read. Null when it never has been. */
  readonly lastRead?: string | null;
}

export interface WorkClassInput {
  readonly id: string;
  readonly label: string;
  /** What this kind of work has earned so far. */
  readonly standing: GradientRung;
  /** How many more approved-unchanged drafts open the next rung. */
  readonly toNextRung?: number;
  /**
   * The highest rung this kind of work can ever reach. Some kinds have a ceiling below the
   * top and never reach it however long the history is (scenarios §6).
   */
  readonly ceiling?: GradientRung;
}

export interface IntegrationsInput {
  readonly sources?: readonly SourceInput[];
  readonly classes?: readonly WorkClassInput[];
}

export type RungState = 'earned' | 'standing' | 'locked' | 'closed';

export interface RungView {
  readonly rung: GradientRung;
  readonly label: string;
  readonly state: RungState;
  readonly stateLabel: string;
  /** Why it is not open yet, for the rungs that are not. Null for the ones that are. */
  readonly explains: string | null;
}

export interface WorkClassView {
  readonly id: string;
  readonly label: string;
  readonly rungs: readonly RungView[];
}

export interface SourceView {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly lastRead: string;
  readonly action: ActionView;
}

export interface IntegrationsView {
  readonly heading: string;
  readonly sourcesHeading: string;
  readonly sources: readonly SourceView[];
  readonly trustHeading: string;
  readonly trustLede: string;
  readonly classes: readonly WorkClassView[];
}

const RUNG_LABELS: Record<GradientRung, string> = COPY.sources.rungs;

const STATE_LABELS: Record<RungState, string> = {
  earned: COPY.sources.earned,
  standing: COPY.sources.standing,
  locked: COPY.sources.lockedLabel,
  closed: COPY.sources.ceilingLabel,
};

export function rungsFor(input: WorkClassInput): RungView[] {
  const standing = RUNG_RANK[input.standing];
  const ceiling = RUNG_RANK[input.ceiling ?? 'silent'];
  return GRADIENT_RUNGS.map((rung): RungView => {
    const rank = RUNG_RANK[rung];
    const state: RungState =
      rank < standing ? 'earned' : rank === standing ? 'standing' : rank > ceiling ? 'closed' : 'locked';
    return {
      rung,
      label: RUNG_LABELS[rung],
      state,
      stateLabel: STATE_LABELS[state],
      explains:
        state === 'locked'
          ? COPY.sources.unlock(Math.max(1, input.toNextRung ?? 1) + (rank - standing - 1))
          : state === 'closed'
            ? COPY.sources.ceiling(RUNG_LABELS[input.ceiling ?? 'silent'])
            : null,
    };
  });
}

function sourceView(source: SourceInput): SourceView {
  const lastRead = source.lastRead ?? null;
  return {
    id: source.id,
    label: source.label,
    status: source.connected ? COPY.sources.connected : COPY.sources.notConnected,
    lastRead: lastRead === null ? COPY.sources.neverRead : COPY.sources.lastRead(lastRead),
    action: {
      id: `source:${source.id}`,
      label: source.connected ? COPY.sources.disconnect : COPY.sources.connect,
      primary: !source.connected,
      dispatch: {
        kind: 'source',
        source: source.id,
        op: source.connected ? 'disconnect' : 'connect',
      },
    },
  };
}

export function buildIntegrations(input: IntegrationsInput = {}): IntegrationsView {
  return {
    heading: COPY.sources.heading,
    sourcesHeading: COPY.sources.sourcesHeading,
    sources: (input.sources ?? []).map(sourceView),
    trustHeading: COPY.sources.trustHeading,
    trustLede: COPY.sources.trustLede,
    classes: (input.classes ?? []).map((c) => ({ id: c.id, label: c.label, rungs: rungsFor(c) })),
  };
}
