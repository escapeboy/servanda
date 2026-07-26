/**
 * §3.1 + docs/execution — attention-market ranking.
 *
 * "`due: null` is valid and expected to be the majority. Undated commitments MUST NOT
 * time-escalate; they rank by age × blocking."
 *
 * The MUST is encoded as a band, not as a weight. Deadline pressure is a band an item can only
 * enter by having a `due`; no amount of age moves an undated item into it. Within the undated
 * band items are ordered by age × blocking, which is ordering, not escalation.
 */

export const BAND_UNDATED = 0;
export const BAND_DUE_SOON = 1;
export const BAND_OVERDUE = 2;

/** Dated items enter the deadline band only inside this horizon; beyond it they age normally. */
export const DUE_SOON_HORIZON_DAYS = 14;

export interface RankInput {
  since: string;
  due: string | null;
  blocking_count: number;
}

export interface Rank {
  band: number;
  /** Ordering within the band. Comparable only against the same band. */
  weight: number;
  score: number;
}

const BAND_STRIDE = 1e9;

export function rank(item: RankInput, now: Date): Rank {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(item.since)) / 86_400_000);
  const ageWeight = ageDays * (1 + item.blocking_count);

  // The single place a band above UNDATED is assigned — and it is unreachable with due === null.
  if (item.due !== null) {
    const daysToDue = (Date.parse(item.due) - now.getTime()) / 86_400_000;
    if (daysToDue < 0) {
      return band(BAND_OVERDUE, -daysToDue * (1 + item.blocking_count));
    }
    if (daysToDue <= DUE_SOON_HORIZON_DAYS) {
      return band(BAND_DUE_SOON, (DUE_SOON_HORIZON_DAYS - daysToDue) * (1 + item.blocking_count));
    }
  }
  return band(BAND_UNDATED, ageWeight);
}

function band(b: number, weight: number): Rank {
  // Clamped so no within-band weight can ever spill into the next band's score range. Without
  // this the MUST would hold only for plausible ages, and a MUST that holds "usually" is not
  // one the conformance suite can rest on.
  const clamped = Math.min(Math.max(weight, 0), BAND_STRIDE - 1);
  return { band: b, weight: clamped, score: b * BAND_STRIDE + clamped };
}
