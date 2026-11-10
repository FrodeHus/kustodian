import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { CellMatch } from './chart-shape';
import { TOOLTIP, dateTick } from './chart-style';
import { heatStrength, type HeatmapAxis, type HeatmapData } from './heatmap-shape';

const ROW_PX = 22;
const MIN_COLUMN_PX = 6;
const LABEL_PX = 120;
// shortcut: column labels are thinned to about this many, whatever the width; measure the grid if that proves too coarse or too dense.
const MAX_COLUMN_LABELS = 12;

const label = (axis: HeatmapAxis, i: number) => (axis.kind === 'datetime' ? dateTick(axis.labels[i]!) : axis.labels[i]!);

/** A heatmap drawn as a CSS grid: colour only, with the exact value on hover or focus. `fit` squeezes it into its width. */
export default function HeatmapView({
  data,
  value,
  onPick,
  fit,
}: {
  data: HeatmapData;
  value: string;
  onPick?: (filter: CellMatch[]) => void;
  fit?: boolean;
}) {
  const { rows, columns, cells, min, max } = data;
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [active, setActive] = useState<[number, number]>([0, 0]);
  const [focused, setFocused] = useState(false);
  const shown = hover ?? (focused ? active : null);
  const shownCell = shown ? cells[shown[0]]?.[shown[1]] : null;
  const step = Math.ceil(columns.labels.length / MAX_COLUMN_LABELS);

  const pick = (r: number, c: number) => {
    const rowKey = rows.keys[r];
    const colKey = columns.keys[c];
    if (!cells[r]?.[c] || rowKey == null || colKey == null) {
      return;
    }
    onPick?.([
      { id: columns.column, value: colKey },
      { id: rows.column, value: rowKey },
    ]);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const [r, c] = active;
    const move: Record<string, [number, number]> = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
    const d = move[e.key];
    if (d) {
      e.preventDefault();
      setHover(null);
      setActive([Math.min(rows.labels.length - 1, Math.max(0, r + d[0])), Math.min(columns.labels.length - 1, Math.max(0, c + d[1]))]);
    } else if (e.key === 'Enter') {
      pick(r, c);
    }
  };

  const grid: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `${LABEL_PX}px repeat(${columns.labels.length}, minmax(${fit ? 0 : MIN_COLUMN_PX}px, 1fr))`,
    gridAutoRows: ROW_PX,
  };
  const sticky: CSSProperties = { position: 'sticky', left: 0, background: 'var(--glass-menu, var(--panel))', zIndex: 2 };

  return (
    <div className="flex flex-col gap-2 text-xs text-muted">
      {data.notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
      <div style={fit ? undefined : { maxHeight: 360, overflow: 'auto' }}>
        <div
          role="grid"
          tabIndex={0}
          aria-label={`Heatmap of ${value} by ${rows.column} (rows) and ${columns.column} (columns)`}
          style={grid}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onMouseLeave={() => setHover(null)}
          className="focus-visible:outline-none"
        >
          {rows.labels.map((_, r) => (
            <div key={r} role="row" style={{ display: 'contents' }}>
              <div
                title={label(rows, r)}
                style={{ ...sticky, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 6 }}
              >
                {label(rows, r)}
              </div>
              {columns.labels.map((_, c) => {
                const cell = cells[r]?.[c];
                const style = cell
                  ? ({
                      '--heat': `color-mix(in srgb, var(--accent) ${8 + 92 * heatStrength(cell.value, min, max)}%, transparent)`,
                    } as CSSProperties)
                  : undefined;
                return (
                  <div
                    key={c}
                    role="gridcell"
                    data-cell=""
                    data-active={focused && active[0] === r && active[1] === c}
                    data-pickable={!!cell && rows.keys[r] != null && columns.keys[c] != null}
                    className={cell ? 'heat-cell' : 'heat-empty'}
                    style={style}
                    onMouseEnter={() => setHover([r, c])}
                    onClick={() => pick(r, c)}
                  />
                );
              })}
            </div>
          ))}
          <div style={sticky} />
          {columns.labels.map((_, c) => (
            <div key={c} title={label(columns, c)} style={{ position: 'relative', height: 16 }}>
              {c % step === 0 && <span style={{ position: 'absolute', left: 0, whiteSpace: 'nowrap' }}>{label(columns, c)}</span>}
            </div>
          ))}
        </div>
      </div>
      <div data-testid="heat-tip" style={{ ...TOOLTIP.contentStyle, padding: '4px 8px', minHeight: 26, alignSelf: 'flex-start' }}>
        {shown && (
          <>
            {label(rows, shown[0])} / {label(columns, shown[1])}
            {shownCell ? ` — ${shownCell.value} ${value}${shownCell.rows > 1 ? ` from ${shownCell.rows} rows` : ''}` : ''}
          </>
        )}
      </div>
      <div data-testid="heat-legend" className="flex items-center gap-2">
        <span>{min}</span>
        <span
          style={{
            width: 120,
            height: 8,
            borderRadius: 4,
            background: 'linear-gradient(90deg, color-mix(in srgb, var(--accent) 8%, transparent), var(--accent))',
          }}
        />
        <span>{max}</span>
        <span>{value}</span>
      </div>
    </div>
  );
}
