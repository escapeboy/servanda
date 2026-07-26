/**
 * ISO 8601 duration arithmetic for §4.1 `acceptance_window`.
 *
 * Years and months are added calendar-wise (UTC component arithmetic) rather than as a fixed
 * number of days, because "P1M" is not 30 days in ISO 8601. Weeks, days and time components
 * are fixed offsets.
 */

const DURATION_RE =
  /^P(?!$)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

export interface ParsedDuration {
  years: number;
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function parseDuration(duration: string): ParsedDuration {
  const m = DURATION_RE.exec(duration);
  if (!m) throw new TypeError(`not an ISO 8601 duration: ${duration}`);
  const n = (i: number): number => (m[i] === undefined ? 0 : Number(m[i]));
  return {
    years: n(1),
    months: n(2),
    weeks: n(3),
    days: n(4),
    hours: n(5),
    minutes: n(6),
    seconds: n(7),
  };
}

export function addDuration(start: Date, duration: string): Date {
  const d = parseDuration(duration);
  const out = new Date(start.getTime());
  if (d.years || d.months) {
    out.setUTCFullYear(out.getUTCFullYear() + d.years, out.getUTCMonth() + d.months, out.getUTCDate());
  }
  const fixedMs =
    ((d.weeks * 7 + d.days) * 86_400 + d.hours * 3600 + d.minutes * 60 + d.seconds) * 1000;
  return new Date(out.getTime() + fixedMs);
}
