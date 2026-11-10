import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ResultColumn } from '../wire';
import type { Row } from './export';
import {
  CHART_TYPES,
  NO_SHAPE,
  RENDER_HINTS,
  chartData,
  chartShape,
  isCategory,
  markFilter,
  isNumeric,
  renderHint,
  renderOptions,
  splitColumn,
  stackable,
  STACKS,
  type CellMatch,
  type ChartPoint,
  type ChartType,
  type Stack,
} from './chart-shape';

/** Series colours, from the theme's tokens, so they follow light and dark. */
const COLOURS = [
  'var(--accent)',
  'var(--warn)',
  'var(--ok)',
  'var(--bad)',
  'var(--kw)',
  'var(--fn)',
  'var(--num)',
  'var(--str)',
  'var(--col)',
];
const colour = (i: number) => COLOURS[i % COLOURS.length];

const AXIS = { stroke: 'var(--line)', tick: { fill: 'var(--muted)', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' } };
// Many series wrap the legend; capped and scrolling, it can't grow over the options above the chart.
const LEGEND = { wrapperStyle: { fontSize: 12, color: 'var(--muted)', maxHeight: 64, overflowY: 'auto' as const } };
// The glass themes' --panel is near see-through, so over the chart the tooltip takes their menu background, as menus do.
const TOOLTIP = {
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
function dateTick(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return date.getUTCHours() === 0 && date.getUTCMinutes() === 0 ? day : `${day} ${date.toISOString().slice(11, 16)}`;
}

const valueOf = (series: string) => (p: ChartPoint) => p.values[series];

/** What the Chart tab's pickers override: the type, the x axis (null for the series' names) and the series. */
export interface Picked {
  type?: ChartType;
  x?: string | null;
  series?: string[];
  split?: string | null;
  stack?: Stack;
}

/** The least height a category gets in a chart-only bar chart, which scrolls past that. */
const BAR_ROW_PX = 22;

const percent = (share: number) => `${Math.round(share * 100)}%`;

const RENDER_WORDS = Object.fromEntries(Object.entries(RENDER_HINTS).map(([word, type]) => [type, word])) as Record<ChartType, string>;

/**
 * The Chart tab (spec 6.5): the result drawn as the chart its shape (or the query's `| render` and its `with (...)` properties)
 * picks, with pickers for the type, the x axis, the number columns, the split and the stacking that override it. Clicking a
 * column, bar, slice or point gives `onPick` the cells of the rows behind it. Loaded on demand, so Recharts is a chunk of its own.
 */
export default function ChartView({
  columns,
  rows,
  kql,
  onPick,
  picked,
  setPicked = () => undefined,
  controls = true,
}: {
  columns: ResultColumn[];
  rows: Row[];
  kql: string;
  onPick?: (filter: CellMatch[]) => void;
  /** Held by the results panel, so the picks outlive switching tabs. */
  picked: Picked;
  setPicked?: (picked: Picked) => void;
  /** False draws the chart alone, without the title, pickers and Full screen (a workbook widget, set in its editor). */
  controls?: boolean;
}) {
  const [full, setFull] = useState(false);
  // Esc leaves full screen first, before anything else that listens for it.
  useEffect(() => {
    if (!full) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        setFull(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);
  // Shaping sorts and copies every row: once per result and pick, not on every render.
  const view = useMemo(() => {
    const hint = renderHint(kql);
    const options = renderOptions(kql);
    const shape = chartShape(columns, rows, hint, options);
    if (!shape) {
      return null;
    }
    const type = picked.type ?? shape.type;
    const auto = picked.type ? (chartShape(columns, rows, picked.type, options) ?? { ...shape, type }) : shape;
    // A pick that the current result has no column for (after a new run) falls back to the shape's.
    const names = new Set(columns.map((c) => c.name));
    const x =
      picked.x === undefined || (picked.x !== null && !names.has(picked.x)) || (picked.x === null && rows.length !== 1) ? auto.x : picked.x;
    const numbers = columns.filter((c) => c.name !== x && isNumeric(c)).map((c) => c.name);
    const chosen = (picked.series ?? auto.series).filter((s) => numbers.includes(s));
    const splits = columns.filter((c) => c.name !== x && isCategory(c)).map((c) => c.name);
    const split = picked.split === undefined || (picked.split !== null && !splits.includes(picked.split)) ? auto.split : picked.split;
    const spec = { type, x, series: type === 'pie' ? chosen.slice(0, 1) : chosen, split };
    const { series, data } = chartData(columns, rows, spec);
    return { hint, options, type, x, numbers, splits, spec, series, data };
  }, [columns, rows, kql, picked]);

  if (!view) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <span className="faint text-[12px]">{NO_SHAPE}</span>
      </div>
    );
  }

  const { hint, options, type, x, numbers, splits, spec, series, data } = view;
  // The point at `index` (a mark's, or the chart's active one for lines and areas), and the series clicked when there is one.
  const pick = (index: unknown, name?: string) => {
    const point = data[Number(index)];
    const filter = point && markFilter(columns, rows, spec, point.x, name);
    if (filter) {
      onPick?.(filter);
    }
  };
  const pointer = onPick && spec.x !== null ? { cursor: 'pointer' } : undefined;
  // Stacked to 100%, the value axis reads as shares.
  const stack = stackable(type) ? (picked.stack ?? options.stack ?? 'none') : 'none';
  const stackId = stack === 'none' ? undefined : 'stack';
  const stackOffset = stack === 'stacked100' ? 'expand' : undefined;
  const valueTick = stackOffset ? percent : undefined;
  // A pie draws one series, so ticking one replaces the other.
  const toggle = (name: string, on: boolean) =>
    setPicked({
      ...picked,
      series:
        type === 'pie' ? [name] : on ? numbers.filter((s) => s === name || spec.series.includes(s)) : spec.series.filter((s) => s !== name),
    });
  // Dates along the axis read as dates, whatever the chart type.
  const time = type === 'timechart' || columns.find((c) => c.name === spec.x)?.type === 'datetime';
  const xAxis = <XAxis dataKey="x" {...AXIS} tickFormatter={time ? dateTick : undefined} />;
  const common = (
    <>
      <CartesianGrid stroke="var(--line)" vertical={false} />
      <Tooltip {...TOOLTIP} labelFormatter={time ? (label) => dateTick(String(label)) : undefined} />
      {series.length > 1 && <Legend {...LEGEND} />}
    </>
  );

  let chart;
  switch (type) {
    case 'column':
      chart = (
        <BarChart data={data} stackOffset={stackOffset}>
          {common}
          {xAxis}
          <YAxis {...AXIS} tickFormatter={valueTick} />
          {series.map((s, i) => (
            <Bar
              key={s}
              name={s}
              dataKey={valueOf(s)}
              fill={colour(i)}
              stackId={stackId}
              isAnimationActive={false}
              style={pointer}
              onClick={(_, i) => pick(i, s)}
            />
          ))}
        </BarChart>
      );
      break;
    case 'bar':
      chart = (
        <BarChart data={data} layout="vertical" stackOffset={stackOffset}>
          {common}
          <XAxis type="number" {...AXIS} tickFormatter={valueTick} />
          <YAxis type="category" dataKey="x" width={140} {...AXIS} tickFormatter={time ? dateTick : undefined} />
          {series.map((s, i) => (
            <Bar
              key={s}
              name={s}
              dataKey={valueOf(s)}
              fill={colour(i)}
              stackId={stackId}
              isAnimationActive={false}
              style={pointer}
              onClick={(_, i) => pick(i, s)}
            />
          ))}
        </BarChart>
      );
      break;
    case 'area':
      chart = (
        <AreaChart data={data} stackOffset={stackOffset} style={pointer} onClick={(state) => pick(state.activeIndex)}>
          {common}
          {xAxis}
          <YAxis {...AXIS} tickFormatter={valueTick} />
          {series.map((s, i) => (
            <Area
              key={s}
              name={s}
              dataKey={valueOf(s)}
              stroke={colour(i)}
              fill={colour(i)}
              fillOpacity={0.2}
              stackId={stackId}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      );
      break;
    case 'pie':
      chart = (
        <PieChart>
          <Tooltip {...TOOLTIP} />
          <Legend {...LEGEND} />
          <Pie
            data={data}
            dataKey={valueOf(series[0] ?? '')}
            nameKey="x"
            stroke="var(--panel)"
            isAnimationActive={false}
            style={pointer}
            onClick={(_, i) => pick(i)}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={colour(i)} />
            ))}
          </Pie>
        </PieChart>
      );
      break;
    default:
      chart = (
        <LineChart data={data} style={pointer} onClick={(state) => pick(state.activeIndex)}>
          {common}
          {xAxis}
          <YAxis {...AXIS} />
          {series.map((s, i) => (
            <Line key={s} name={s} dataKey={valueOf(s)} stroke={colour(i)} dot={false} strokeWidth={2} isAnimationActive={false} />
          ))}
        </LineChart>
      );
  }

  const plot = (
    <div className="min-h-0 flex-1">
      {spec.series.length > 0 && !controls && type === 'bar' ? (
        // A widget can be short: a bar chart keeps 22 px a category and scrolls, rather than squeezing dozens into slivers.
        <div className="h-full overflow-y-auto">
          <div style={{ height: `max(100%, ${data.length * BAR_ROW_PX}px)` }}>
            <ResponsiveContainer width="100%" height="100%">
              {chart}
            </ResponsiveContainer>
          </div>
        </div>
      ) : spec.series.length > 0 ? (
        <ResponsiveContainer width="100%" height="100%">
          {chart}
        </ResponsiveContainer>
      ) : (
        <div className="flex h-full items-center justify-center">
          <span className="faint text-[12px]">
            {numbers.length === 0
              ? 'No number columns to chart along this axis.'
              : controls
                ? 'Tick a value to chart.'
                : 'No value picked to chart.'}
          </span>
        </div>
      )}
    </div>
  );
  if (!controls) {
    return (
      <section className="flex min-h-0 flex-1 flex-col px-3 pb-3" aria-label="Chart">
        {plot}
      </section>
    );
  }
  return (
    <section
      className={`card flex min-h-0 flex-1 flex-col gap-3 p-4 ${full ? 'fixed inset-0 z-20 rounded-none' : 'm-4'}`}
      aria-label="Chart"
    >
      <div className="flex items-center gap-2.5">
        <b className="text-[14px]">
          {options.title ?? (type === 'timechart' ? 'Time chart' : `${CHART_TYPES.find((t) => t.type === type)?.name ?? ''} chart`)}
        </b>
        {hint && type === hint && <span className="muted text-[12px]">From render {RENDER_WORDS[hint]}</span>}
        <div className="grow" />
        <select
          className="textbox"
          style={{ height: 28 }}
          aria-label="Chart type"
          value={type}
          onChange={(e) => setPicked({ ...picked, type: CHART_TYPES.find((t) => t.type === e.target.value)?.type })}
        >
          {CHART_TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn ghost" aria-pressed={full} onClick={() => setFull(!full)}>
          {full ? 'Exit full screen' : 'Full screen'}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px]">
        <label className="flex items-center gap-2">
          <span className="muted">{type === 'pie' ? 'Slices' : 'X axis'}</span>
          <select
            className="textbox"
            style={{ height: 28 }}
            aria-label="X axis"
            value={x ?? ''}
            onChange={(e) => setPicked({ ...picked, x: e.target.value === '' ? null : e.target.value })}
          >
            {rows.length === 1 && <option value="">Column names</option>}
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {type !== 'pie' && x !== null && (
          <label className="flex items-center gap-2">
            <span className="muted">Split by</span>
            <select
              className="textbox"
              style={{ height: 28 }}
              aria-label="Split by"
              value={splitColumn(columns, spec)?.name ?? ''}
              onChange={(e) => setPicked({ ...picked, split: e.target.value === '' ? null : e.target.value })}
            >
              <option value="">None</option>
              {splits.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        {stackable(type) && (
          <label className="flex items-center gap-2">
            <span className="muted">Stacking</span>
            <select
              className="textbox"
              style={{ height: 28 }}
              aria-label="Stacking"
              value={stack}
              onChange={(e) => setPicked({ ...picked, stack: STACKS.find((t) => t.stack === e.target.value)?.stack })}
            >
              {STACKS.map((t) => (
                <option key={t.stack} value={t.stack}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="muted">Values</span>
        {numbers.map((name) => (
          <label key={name} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              aria-label={name}
              checked={spec.series.includes(name)}
              onChange={(e) => toggle(name, e.target.checked)}
            />
            {name}
          </label>
        ))}
      </div>
      {plot}
    </section>
  );
}
