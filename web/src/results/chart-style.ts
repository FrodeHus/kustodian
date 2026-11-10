// The glass themes' --panel is near see-through, so over the chart the tooltip takes their menu background, as menus do.
export const TOOLTIP = {
  contentStyle: {
    background: 'var(--glass-menu, var(--panel))',
    backdropFilter: 'var(--glass-blur)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    color: 'var(--text)',
    fontSize: 12,
  },
  labelStyle: { color: 'var(--muted)' },
  // Recharts' own hover band is light grey, glaring on dark themes.
  cursor: { fill: 'var(--raise)', stroke: 'var(--line)' },
};

/** A date along a time chart's axis: day and month, and the time when it isn't midnight. */
export function dateTick(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return date.getUTCHours() === 0 && date.getUTCMinutes() === 0 ? day : `${day} ${date.toISOString().slice(11, 16)}`;
}
