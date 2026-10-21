import { useState } from 'react';
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
import { CHART_TYPES, NO_SHAPE, RENDER_HINTS, chartData, chartShape, renderHint, type ChartPoint, type ChartType } from './chart-shape';

/** Series colours, from the theme's tokens, so they follow light and dark. */
const COLOURS = ['var(--accent)', 'var(--warn)', 'var(--ok)', 'var(--bad)', 'var(--kw)', 'var(--fn)', 'var(--num)', 'var(--str)', 'var(--col)'];
const colour = (i: number) => COLOURS[i % COLOURS.length];

const AXIS = { stroke: 'var(--line)', tick: { fill: 'var(--muted)', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' } };
const TOOLTIP = {
  contentStyle: { background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, color: 'var(--text)', fontSize: 12 },
  labelStyle: { color: 'var(--muted)' },
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

const RENDER_WORDS = Object.fromEntries(Object.entries(RENDER_HINTS).map(([word, type]) => [type, word])) as Record<ChartType, string>;

/**
 * The Chart tab (spec 6.5): the result drawn as the chart its shape (or the query's `| render`) picks, with a type picker that
 * overrides it. Loaded on demand, so Recharts is a chunk of its own.
 */
export default function ChartView({ columns, rows, kql }: { columns: ResultColumn[]; rows: Row[]; kql: string }) {
  const hint = renderHint(kql);
  const shape = chartShape(columns, rows, hint);
  const [picked, setPicked] = useState<ChartType | null>(null);

  if (!shape) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <span className="faint text-[12px]">{NO_SHAPE}</span>
      </div>
    );
  }

  const type = picked ?? shape.type;
  const spec = picked ? (chartShape(columns, rows, picked) ?? { ...shape, type: picked }) : shape;
  const { series, data } = chartData(columns, rows, spec);
  // Dates along the axis read as dates, whatever the chart type.
  const time = type === 'timechart' || columns.find((c) => c.name === spec.x)?.type === 'datetime';
  const xAxis = <XAxis dataKey="x" {...AXIS} tickFormatter={time ? dateTick : undefined} />;
  const common = (
    <>
      <CartesianGrid stroke="var(--line)" vertical={false} />
      <Tooltip {...TOOLTIP} labelFormatter={time ? (label) => dateTick(String(label)) : undefined} />
      {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: 'var(--muted)' }} />}
    </>
  );

  let chart;
  switch (type) {
    case 'column':
      chart = (
        <BarChart data={data}>
          {common}
          {xAxis}
          <YAxis {...AXIS} />
          {series.map((s, i) => (
            <Bar key={s} name={s} dataKey={valueOf(s)} fill={colour(i)} isAnimationActive={false} />
          ))}
        </BarChart>
      );
      break;
    case 'bar':
      chart = (
        <BarChart data={data} layout="vertical">
          {common}
          <XAxis type="number" {...AXIS} />
          <YAxis type="category" dataKey="x" width={140} {...AXIS} tickFormatter={time ? dateTick : undefined} />
          {series.map((s, i) => (
            <Bar key={s} name={s} dataKey={valueOf(s)} fill={colour(i)} isAnimationActive={false} />
          ))}
        </BarChart>
      );
      break;
    case 'area':
      chart = (
        <AreaChart data={data}>
          {common}
          {xAxis}
          <YAxis {...AXIS} />
          {series.map((s, i) => (
            <Area key={s} name={s} dataKey={valueOf(s)} stroke={colour(i)} fill={colour(i)} fillOpacity={0.2} isAnimationActive={false} />
          ))}
        </AreaChart>
      );
      break;
    case 'pie':
      chart = (
        <PieChart>
          <Tooltip {...TOOLTIP} />
          <Legend wrapperStyle={{ fontSize: 12, color: 'var(--muted)' }} />
          <Pie data={data} dataKey={valueOf(series[0] ?? '')} nameKey="x" stroke="var(--panel)" isAnimationActive={false}>
            {data.map((p, i) => (
              <Cell key={p.x} fill={colour(i)} />
            ))}
          </Pie>
        </PieChart>
      );
      break;
    default:
      chart = (
        <LineChart data={data}>
          {common}
          {xAxis}
          <YAxis {...AXIS} />
          {series.map((s, i) => (
            <Line key={s} name={s} dataKey={valueOf(s)} stroke={colour(i)} dot={false} strokeWidth={2} isAnimationActive={false} />
          ))}
        </LineChart>
      );
  }

  return (
    <section className="card m-4 flex min-h-0 flex-1 flex-col gap-3 p-4" aria-label="Chart">
      <div className="flex items-center gap-2.5">
        <b className="text-[14px]">{type === 'timechart' ? 'Time chart' : `${CHART_TYPES.find((t) => t.type === type)?.name ?? ''} chart`}</b>
        {hint && type === hint && <span className="muted text-[12px]">From render {RENDER_WORDS[hint]}</span>}
        <div className="grow" />
        <select
          className="textbox"
          style={{ height: 28 }}
          aria-label="Chart type"
          value={type}
          onChange={(e) => setPicked(CHART_TYPES.find((t) => t.type === e.target.value)?.type ?? null)}
        >
          {CHART_TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          {chart}
        </ResponsiveContainer>
      </div>
    </section>
  );
}
