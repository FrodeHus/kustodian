import { useEffect, useId, useMemo, useState } from 'react';
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
import { TOOLTIP, dateTick } from './chart-style';
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
  seriesTable,
  splitColumn,
  stackable,
  STACKS,
  withType,
  type CellMatch,
  type Picked,
  type ChartPoint,
  type ChartType,
} from './chart-shape';
import HeatmapView from './heatmap-view';
import GaugeView from './gauge-view';
import { ANY_PICK, GAUGE_NO_SHAPE, GAUGE_PICK, gaugeData, gaugeLabels, gaugeShape } from './gauge-shape';
import { GaugeFields } from './gauge-fields';
import { HEATMAP_NO_SHAPE, heatmapAxes, heatmapData, heatmapShape } from './heatmap-shape';

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

const AXIS = {
  stroke: 'var(--line)',
  axisLine: false,
  tickLine: false,
  tick: { fill: 'var(--muted)', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' },
};
/** A soft glow around a line in its own colour. */
const glow = (i: number) => ({ filter: `drop-shadow(0 0 5px color-mix(in srgb, ${colour(i)} 55%, transparent))` });
// shortcut: Recharts animates every point, so a big chart draws at once; raise this if large charts animate smoothly.
const ANIMATED_POINTS = 2000;
// Many series wrap the legend; capped and scrolling, it can't grow over the options above the chart.
const LEGEND = { wrapperStyle: { fontSize: 12, color: 'var(--muted)', maxHeight: 64, overflowY: 'auto' as const } };
const valueOf = (series: string) => (p: ChartPoint) => p.values[series];

/** The least height a category gets in a chart-only bar chart, which scrolls past that. */
const BAR_ROW_PX = 22;

const percent = (share: number) => `${Math.round(share * 100)}%`;

const RENDER_WORDS = Object.fromEntries(Object.entries(RENDER_HINTS).map(([word, type]) => [type, word])) as Partial<
  Record<ChartType, string>
>;

/**
 * The Chart tab (spec 6.5): the result drawn as the chart its shape (or the query's `| render` and its `with (...)` properties)
 * picks, with pickers for the type, the x axis, the number columns, the split and the stacking that override it. Clicking a
 * column, bar, slice or point gives `onPick` the cells of the rows behind it. Loaded on demand, so Recharts is a chunk of its own.
 */
export default function ChartView({
  columns: resultColumns,
  rows: resultRows,
  kql,
  onPick: resultPick,
  picked,
  setPicked = () => undefined,
  controls = true,
  animate = true,
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
  /** False draws the chart at once, without its entry animation (a workbook being printed). */
  animate?: boolean;
}) {
  const [full, setFull] = useState(false);
  const { columns, rows, expanded } = useMemo(() => seriesTable(resultColumns, resultRows), [resultColumns, resultRows]);
  // A make-series point is one element of an array cell, which the grid's cell filter can't match.
  const onPick = expanded ? undefined : resultPick;
  // Gradient ids are per chart: a workbook shows several.
  const gradient = `fill${useId().replace(/[^\w-]/g, '')}`;
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
    const heat = heatmapShape(columns, rows, options);
    const dial = gaugeShape(columns, options);
    // A gauge picked on a result with no number column still explains itself (and keeps the type picker), rather than a dead end.
    if (!shape && !heat && !dial && picked.type !== 'gauge') {
      return null;
    }
    const names = new Set(columns.map((c) => c.name));
    if (picked.type === 'gauge') {
      const none: string[] = [];
      if (!dial) {
        return {
          hint,
          options,
          type: picked.type,
          note: GAUGE_NO_SHAPE,
          xs: none,
          numbers: none,
          splits: none,
          spec: { type: picked.type, x: null, series: none },
          series: none,
          data: [],
        };
      }
      // A pick counts only for a column the result has, in its role: the value a number, the label any other column.
      const numeric = columns.filter(isNumeric).map((c) => c.name);
      const value = numeric.find((n) => n === picked.series?.[0]) ?? dial.series[0] ?? '';
      const labels = gaugeLabels(columns, value);
      const x =
        picked.x === null || (picked.x !== undefined && labels.includes(picked.x))
          ? picked.x
          : labels.includes(dial.x ?? '')
            ? dial.x
            : null;
      const spec = { type: picked.type, x, series: [value], split: null };
      return {
        hint,
        options,
        type: picked.type,
        xs: labels,
        numbers: numeric,
        splits: none,
        spec,
        series: none,
        data: [],
        gauge: gaugeData(columns, rows, spec, picked),
      };
    }
    if (picked.type === 'heatmap' || !shape) {
      const type = picked.type ?? 'column';
      if (type !== 'heatmap' || !heat) {
        // Only a heatmap or gauge fits, but neither is picked for the user; or the heatmap picked can't lay this result out.
        const note = type === 'heatmap' ? HEATMAP_NO_SHAPE : heat ? ANY_PICK : GAUGE_PICK;
        const none: string[] = [];
        return {
          hint,
          options,
          type,
          note,
          xs: none,
          numbers: none,
          splits: none,
          spec: { type, x: null, series: none },
          series: none,
          data: [],
        };
      }
      // A pick counts only for a column the result has, in its role: the value a number, the axes two others.
      const numeric = columns.filter(isNumeric).map((c) => c.name);
      const value = numeric.find((n) => n === picked.series?.[0]) ?? heat.series[0] ?? '';
      const axes = heatmapAxes(columns, value);
      const x = [picked.x, heat.x].find((a) => a && axes.includes(a)) ?? axes[0] ?? null;
      const split = [picked.split, heat.split, ...axes].find((a) => a && a !== x && axes.includes(a)) ?? null;
      const spec = { type, x, series: [value], split };
      return {
        hint,
        options,
        type,
        xs: axes,
        numbers: numeric.filter((n) => n !== x && n !== split),
        splits: axes.filter((a) => a !== x),
        spec,
        series: [],
        data: [],
        heat: heatmapData(columns, rows, spec),
      };
    }
    const type = picked.type ?? shape.type;
    const auto = picked.type ? (chartShape(columns, rows, picked.type, options) ?? { ...shape, type }) : shape;
    // A pick that the current result has no column for (after a new run) falls back to the shape's.
    const x =
      picked.x === undefined || (picked.x !== null && !names.has(picked.x)) || (picked.x === null && rows.length !== 1) ? auto.x : picked.x;
    const numbers = columns.filter((c) => c.name !== x && isNumeric(c)).map((c) => c.name);
    const chosen = (picked.series ?? auto.series).filter((s) => numbers.includes(s));
    const splits = columns.filter((c) => c.name !== x && isCategory(c)).map((c) => c.name);
    const split = picked.split === undefined || (picked.split !== null && !splits.includes(picked.split)) ? auto.split : picked.split;
    const spec = { type, x, series: type === 'pie' ? chosen.slice(0, 1) : chosen, split };
    const { series, data } = chartData(columns, rows, spec);
    return { hint, options, type, xs: [...names], numbers, splits, spec, series, data };
  }, [columns, rows, kql, picked]);

  if (!view) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <span className="faint text-[12px]">{NO_SHAPE}</span>
      </div>
    );
  }

  const { hint, options, type, xs, numbers, splits, spec, series, data } = view;
  const { x } = spec;
  const heat = 'heat' in view ? view.heat : undefined;
  const gauge = 'gauge' in view ? view.gauge : undefined;
  const note = 'note' in view ? view.note : undefined;
  // Only a heatmap or gauge fits, and none is picked: no type is shown as chosen.
  const choose = note === ANY_PICK || note === GAUGE_PICK;
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
  // A pie, a heatmap and a gauge draw one series, so ticking one replaces the other.
  const toggle = (name: string, on: boolean) =>
    setPicked({
      ...picked,
      series:
        type === 'pie' || type === 'heatmap' || type === 'gauge'
          ? [name]
          : on
            ? numbers.filter((s) => s === name || spec.series.includes(s))
            : spec.series.filter((s) => s !== name),
    });
  // Dates along the axis read as dates, whatever the chart type.
  const time = type === 'timechart' || columns.find((c) => c.name === spec.x)?.type === 'datetime';
  const motion = {
    isAnimationActive:
      animate && data.length * series.length <= ANIMATED_POINTS && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    animationDuration: 700,
    animationEasing: 'ease-out' as const,
  };
  // Bars in a stack keep square corners, so the stack reads as one bar.
  const radius = (corners: [number, number, number, number]) => (stackId ? 0 : corners);
  const xAxis = <XAxis dataKey="x" {...AXIS} tickFormatter={time ? dateTick : undefined} />;
  const common = (
    <>
      {/* Grid lines cross the value axis: vertical when the bars lie along x. */}
      <CartesianGrid stroke="var(--line)" strokeDasharray="3 4" strokeOpacity={0.6} horizontal={type !== 'bar'} vertical={type === 'bar'} />
      <Tooltip {...TOOLTIP} labelFormatter={time ? (label) => dateTick(String(label)) : undefined} />
      {series.length > 1 && <Legend {...LEGEND} />}
    </>
  );

  let chart;
  // A heatmap or gauge, or a note in its place, draws no Recharts chart.
  if (!heat && !gauge && !note) {
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
                radius={radius([4, 4, 0, 0])}
                maxBarSize={56}
                {...motion}
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
                radius={radius([0, 4, 4, 0])}
                maxBarSize={40}
                {...motion}
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
            <defs>
              {series.map((s, i) => (
                <linearGradient key={s} id={`${gradient}-${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" style={{ stopColor: colour(i), stopOpacity: 0.55 }} />
                  <stop offset="100%" style={{ stopColor: colour(i), stopOpacity: 0.04 }} />
                </linearGradient>
              ))}
            </defs>
            {common}
            {xAxis}
            <YAxis {...AXIS} tickFormatter={valueTick} />
            {series.map((s, i) => (
              <Area
                key={s}
                name={s}
                type="monotone"
                dataKey={valueOf(s)}
                stroke={colour(i)}
                strokeWidth={2}
                fill={`url(#${gradient}-${i})`}
                stackId={stackId}
                activeDot={{ r: 4, strokeWidth: 0 }}
                style={glow(i)}
                {...motion}
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
              innerRadius="58%"
              paddingAngle={data.length > 1 ? 2 : 0}
              cornerRadius={4}
              stroke="none"
              {...motion}
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
              <Line
                key={s}
                name={s}
                type="monotone"
                dataKey={valueOf(s)}
                stroke={colour(i)}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0 }}
                strokeWidth={2}
                style={glow(i)}
                {...motion}
              />
            ))}
          </LineChart>
        );
    }
  }

  const plot = (
    <div className="min-h-0 flex-1">
      {note ? (
        <div className="flex h-full items-center justify-center">
          <span className="faint text-[12px]">{note}</span>
        </div>
      ) : gauge ? (
        <GaugeView data={gauge} onPick={onPick} animate={animate} />
      ) : heat ? (
        <HeatmapView data={heat} value={spec.series[0] ?? ''} onPick={onPick} fit={!animate} />
      ) : spec.series.length > 0 && !controls && type === 'bar' ? (
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
  const xLabel = type === 'heatmap' ? 'Columns' : type === 'pie' ? 'Slices' : type === 'gauge' ? 'Label' : 'X axis';
  const splitLabel = type === 'heatmap' ? 'Rows' : 'Split by';
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
          {options.title ??
            (choose
              ? 'Chart'
              : type === 'timechart'
                ? 'Time chart'
                : type === 'heatmap'
                  ? 'Heatmap'
                  : type === 'gauge'
                    ? 'Gauge'
                    : `${CHART_TYPES.find((t) => t.type === type)?.name ?? ''} chart`)}
        </b>
        {hint && type === hint && <span className="muted text-[12px]">From render {RENDER_WORDS[hint]}</span>}
        <div className="grow" />
        <select
          className="textbox"
          style={{ height: 28 }}
          aria-label="Chart type"
          value={choose ? '' : type}
          onChange={(e) => setPicked(withType(picked, CHART_TYPES.find((t) => t.type === e.target.value)?.type))}
        >
          {choose && (
            <option value="" disabled>
              Choose a type
            </option>
          )}
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
      {!note && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px]">
          <label className="flex items-center gap-2">
            <span className="muted">{xLabel}</span>
            <select
              className="textbox"
              style={{ height: 28 }}
              aria-label={type === 'heatmap' || type === 'gauge' ? xLabel : 'X axis'}
              value={x ?? ''}
              onChange={(e) => setPicked({ ...picked, x: e.target.value === '' ? null : e.target.value })}
            >
              {rows.length === 1 && type !== 'heatmap' && type !== 'gauge' && <option value="">Column names</option>}
              {type === 'gauge' && <option value="">Row number</option>}
              {xs.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {type !== 'pie' && type !== 'gauge' && x !== null && (
            <label className="flex items-center gap-2">
              <span className="muted">{splitLabel}</span>
              <select
                className="textbox"
                style={{ height: 28 }}
                aria-label={splitLabel}
                value={type === 'heatmap' ? (spec.split ?? '') : (splitColumn(columns, spec)?.name ?? '')}
                onChange={(e) => setPicked({ ...picked, split: e.target.value === '' ? null : e.target.value })}
              >
                {type !== 'heatmap' && <option value="">None</option>}
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
          <span className="muted">{type === 'heatmap' || type === 'gauge' ? 'Value' : 'Values'}</span>
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
          {type === 'gauge' && <GaugeFields picked={picked} onChange={setPicked} layout="inline" />}
        </div>
      )}
      {plot}
    </section>
  );
}
