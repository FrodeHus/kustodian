export const DAY_MS = 24 * 60 * 60 * 1000;

/** The start and end of an interval timespan `start/end`, or null for a duration. */
export function interval(timespan: string): [Date, Date] | null {
  const [start, end, ...rest] = timespan.split('/');
  if (start === undefined || end === undefined || rest.length > 0) {
    return null;
  }
  const from = new Date(start);
  const to = new Date(end);
  return Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) ? null : [from, to];
}

/** Whether a timespan (a preset duration or an interval) covers more than `days`. */
export function exceedsDays(timespan: string, days: number): boolean {
  const range = interval(timespan);
  const covered = range ? (range[1].getTime() - range[0].getTime()) / DAY_MS : Number(/^P(\d+)D$/.exec(timespan)?.[1] ?? 0);
  return covered > days;
}

