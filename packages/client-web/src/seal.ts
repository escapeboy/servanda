import type { VerificationLevel } from '@servanda/types';
import { COPY } from './copy.js';

/**
 * The seal — the signature element, and not a padlock. A seal is the historically exact
 * mark for an authenticated promise, and it carries the whole state semantics in one shape.
 *
 * Doctrine names five: proposed → outlined half-seal; confirmed → two half-seals joined
 * (bilaterality made visible); closed → seal and mark; disagreed → cracked seal; replaced →
 * seal with an arrow to its successor.
 *
 * SPEC/DOCTRINE AMBIGUITY (narrowest reading): §4 also produces `released`, `expired`,
 * `pending-acceptance`, `none` and the surface's `vault-local`, for which the doctrine names
 * no mark. Each takes its nearest named neighbour and nothing is invented: an ended promise
 * wears the closed mark, a not-yet-sent one wears no seal. Listed in the stream report.
 */
export const SEAL_SHAPES = ['unsealed', 'half', 'joined', 'marked', 'cracked', 'arrow'] as const;
export type SealShape = (typeof SEAL_SHAPES)[number];

/** Every state the §7 surface can put on an item, mapped to exactly one mark. */
const SHAPE_BY_STATE: Record<string, SealShape> = {
  none: 'unsealed',
  'vault-local': 'unsealed',
  proposed: 'half',
  confirmed: 'joined',
  open: 'joined',
  'pending-acceptance': 'joined',
  closed: 'marked',
  released: 'marked',
  expired: 'marked',
  disputed: 'cracked',
  superseded: 'arrow',
};

export interface SealView {
  readonly shape: SealShape;
  /** Said in words for anyone who cannot see the mark. */
  readonly label: string;
}

const LABEL_BY_SHAPE: Record<SealShape, string> = {
  unsealed: COPY.seal.unsealed,
  half: COPY.seal.half,
  joined: COPY.seal.joined,
  marked: COPY.seal.marked,
  cracked: COPY.seal.cracked,
  arrow: COPY.seal.arrow,
};

export function sealFor(state: string): SealView {
  const shape = SHAPE_BY_STATE[state] ?? 'unsealed';
  return { shape, label: LABEL_BY_SHAPE[shape] };
}

/**
 * Verification as degrees of relief in the seal, replacing identity terminology outright.
 *
 * M-12 lives in this table. `RELIEF_BY_LEVEL` is total and ordered, the renderer reads it
 * and only it, and there is no argument by which a caller could ask for more relief than
 * the evidence carries — the level is the sole input.
 */
export const RELIEFS = ['flat', 'continuity', 'attested', 'domain', 'external'] as const;
export type SealRelief = (typeof RELIEFS)[number];

export const RELIEF_BY_LEVEL: Record<VerificationLevel, SealRelief> = {
  '0': 'flat',
  '1': 'continuity',
  '2': 'attested',
  '3': 'domain',
  ext: 'external',
};

/** Ordering used by the M-12 test: rendered relief must never exceed the evidence. */
export const RELIEF_RANK: Record<SealRelief, number> = {
  flat: 0,
  continuity: 1,
  attested: 2,
  domain: 3,
  external: 3,
};

export interface TrustView {
  readonly level: VerificationLevel;
  readonly relief: SealRelief;
  readonly label: string;
}

export function trustFor(level: VerificationLevel): TrustView {
  return { level, relief: RELIEF_BY_LEVEL[level], label: COPY.trust[level] };
}
