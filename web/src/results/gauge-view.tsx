import { useState, type KeyboardEvent } from 'react';
import type { CellMatch } from './chart-shape';
import { TOOLTIP } from './chart-style';
import type { Gauge, GaugeData } from './gauge-shape';

const CX = 65;
const CY = 64;
const R = 52;
const STROKE = 12;
const START = 135;
const SWEEP = 270;

const point = (deg: number, r: number) => [CX + r * Math.cos((deg * Math.PI) / 180), CY + r * Math.sin((deg * Math.PI) / 180)] as const;
const [x0, y0] = point(START, R);
const [x1, y1] = point(START + SWEEP, R);
// The whole 270-degree sweep (large arc, clockwise); the filled part is a dash of it, since pathLength is 1.
const RING = `M ${x0} ${y0} A ${R} ${R} 0 1 1 ${x1} ${y1}`;

const colour = (good: boolean | null) => (good === null ? 'var(--accent)' : good ? 'var(--ok)' : 'var(--bad)');

function Ring({ gauge, target, targetFill, animate }: { gauge: Gauge; target?: number; targetFill?: number; animate: boolean }) {
  const [tx0, ty0] = point(START + SWEEP * (targetFill ?? 0), R - STROKE);
  const [tx1, ty1] = point(START + SWEEP * (targetFill ?? 0), R + 8);
  return (
    <svg viewBox="0 0 130 120" aria-hidden="true" style={{ width: '100%', display: 'block' }}>
      <path d={RING} fill="none" stroke="var(--line)" strokeWidth={STROKE} strokeLinecap="round" />
      {gauge.value !== null && (
        <path
          data-testid="gauge-arc"
          className="gauge-arc"
          d={RING}
          pathLength={1}
          fill="none"
          stroke={colour(gauge.good)}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray="1 1"
          strokeDashoffset={1 - gauge.fill}
          style={animate ? { animation: 'gauge-grow 700ms ease-out' } : undefined}
        />
      )}
      {targetFill !== undefined && (
        <line data-testid="gauge-tick" x1={tx0} y1={ty0} x2={tx1} y2={ty1} stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      )}
      <text x={CX} y={CY + 6} textAnchor="middle" fontSize={26} fontWeight={600} fill="currentColor">
        {gauge.text}
      </text>
      {target !== undefined && (
        <text x={CX} y={CY + 24} textAnchor="middle" fontSize={9} fill="var(--muted)">
          desired {target}
        </text>
      )}
    </svg>
  );
}

/** Ring gauges, one per row: the value, and where it stands against the desired level. Hover or focus reads out the exact value. */
export default function GaugeView({
  data,
  onPick,
  animate = true,
}: {
  data: GaugeData;
  onPick?: (filter: CellMatch[]) => void;
  animate?: boolean;
}) {
  const { gauges, labelColumn, valueColumn, target, targetFill, better } = data;
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const [picked, setActive] = useState(0);
  // Clamped in render, so a rerun with fewer rows never points at a missing gauge.
  const active = Math.min(picked, gauges.length - 1);
  const shown = gauges[hover ?? focused ?? -1];
  const clickable = labelColumn !== null;
  const pick = (g: Gauge) => labelColumn !== null && onPick?.([{ id: labelColumn, value: g.key }]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>, i: number) => {
    const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: gauges.length - 1 }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      const next = Math.min(gauges.length - 1, Math.max(0, to));
      setActive(next);
      (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
    } else if (clickable && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      pick(gauges[i]!);
    }
  };

  return (
    <div className="flex h-full flex-col gap-2 text-xs text-muted">
      {data.note && <p>{data.note}</p>}
      {/* Shrinks to its box (min-height 0) and scrolls, so the readout below stays in view. */}
      <div
        style={{
          minHeight: 0,
          overflowY: 'auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
          gap: 8,
          justifyItems: 'center',
          alignContent: 'start',
        }}
        onMouseLeave={() => setHover(null)}
      >
        {gauges.map((g, i) => (
          <div
            key={i}
            role={clickable ? 'button' : 'group'}
            tabIndex={i === active ? 0 : -1}
            aria-label={g.aria}
            className="text-text focus-visible:outline-none"
            style={{ width: '100%', maxWidth: gauges.length === 1 ? 260 : 180, cursor: clickable ? 'pointer' : undefined, borderRadius: 8 }}
            onMouseOver={() => setHover(i)}
            onFocus={() => {
              setFocused(i);
              setActive(i);
            }}
            onBlur={() => setFocused(null)}
            onClick={() => pick(g)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <Ring gauge={g} target={target} targetFill={targetFill} animate={animate} />
            <div className="truncate text-center text-[12px]" title={g.label}>
              {g.label}
            </div>
          </div>
        ))}
      </div>
      <div
        data-testid="gauge-tip"
        aria-live="polite"
        style={{
          ...TOOLTIP.contentStyle,
          padding: '4px 8px',
          minHeight: 44,
          alignSelf: 'flex-start',
          visibility: shown ? 'visible' : 'hidden',
        }}
      >
        {shown && (
          <>
            <div>{shown.label}</div>
            <div>
              {valueColumn}: {shown.value ?? '–'}
            </div>
            {target !== undefined && (
              <div>
                desired {target} · {better} is better
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
