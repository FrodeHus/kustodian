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

/** Days in an ISO duration of days, hours, minutes and seconds (`P7D`, `PT800H`); 0 when it isn't one. */
function durationDays(timespan: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(timespan);
  const [d, h, min, s] = [1, 2, 3, 4].map((i) => Number(m?.[i] ?? 0));
  return d! + h! / 24 + min! / 1440 + s! / 86400;
}

/** Whether a timespan (a preset duration or an interval) covers more than `days`. */
export function exceedsDays(timespan: string, days: number): boolean {
  const range = interval(timespan);
  const covered = range ? (range[1].getTime() - range[0].getTime()) / DAY_MS : durationDays(timespan);
  return covered > days;
}
