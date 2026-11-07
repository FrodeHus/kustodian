import { useEffect, useId, useState } from 'react';
import { call } from '../bridge';
import { errorText } from '../shell/errors';
import type { HistorySeries, ResultColumn, RunResult } from '../wire';
import { historyRows } from './history';
import { defaultHistory, type Widget, type WidgetHistory } from './model';

const INTERVALS: [WidgetHistory['interval'], string][] = [
  ['day', 'Once a day'],
  ['run', 'Every run'],
  ['week', 'Once a week'],
];
const RETENTION: WidgetHistory['retentionDays'][] = [30, 90, 365];
const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** Asks before clearing a widget's history: "Clear" style button named by `confirm`, Cancel keeps it. Same shape as `ConfirmDelete`. */
export function ClearConfirm({ title, confirm, error, onConfirm, onCancel }: { title: string; confirm: string; error?: string | null; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div role="group" aria-label={title} className="flex flex-col gap-2 rounded-[7px] border border-line bg-panel2 p-2.5 text-[12px]">
      <span>{title}</span>
      <span className="faint">Its saved snapshots and tracked rows are deleted. This can't be undone.</span>
      {error && (
        <span role="alert" className="text-bad">
          {error}
        </span>
      )}
      <div className="flex justify-end gap-1.5">
        <button type="button" className="btn ghost" autoFocus onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={onConfirm}>
          {confirm}
        </button>
      </div>
    </div>
  );
}

function ColumnMulti({ label, value, columns, onChange }: { label: string; value: string[]; columns: string[]; onChange: (value: string[]) => void }) {
  // Keep a saved column listed when the result lacks it (no preview yet), so the select shows it.
  const names = [...columns, ...value.filter((v) => !columns.includes(v))];
  return (
    <label className="field">
      <span>{label}</span>
      <select multiple className="textbox mono h-auto py-1" value={value} onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}>
        {names.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The widget editor's History tab (screen 9): whether the widget keeps history and how (Values over time or Row tracking), how
 * often and how long, and on the right the series already stored. Edits `draft` through `set`; the editor's Apply writes it.
 */
export function HistorySection({
  draft,
  columns,
  result,
  set,
  workbookId,
}: {
  draft: Widget;
  columns: ResultColumn[];
  result?: RunResult | null;
  set: (change: (w: Widget) => Widget) => void;
  workbookId: string;
}) {
  const id = useId();
  const [series, setSeries] = useState<HistorySeries[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const widgetId = draft.id;
  useEffect(() => {
    let live = true;
    call<HistorySeries[]>('history.series', { workbookId, widgetId }).then(
      (s) => live && setSeries(s),
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [workbookId, widgetId]);

  const h = draft.history;
  const change = (c: Partial<WidgetHistory>) => set((w) => (w.history ? { ...w, history: { ...w.history, ...c } } : w));
  const names = columns.map((c) => c.name);
  const rows = h?.mode === 'rows';
  const unique = h && rows && h.keys.length > 0 && result ? historyRows(result, h) !== 'keysNotUnique' : null;

  return (
    <div className="grid grid-cols-2 gap-4 text-[12.5px]">
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={!!h}
            onChange={(e) => set(({ history: _off, ...w }) => (e.target.checked ? { ...w, history: defaultHistory(w.type) } : w))}
          />
          Keep history for this widget
        </label>
        {h && (
          <>
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="History mode">
              <button
                type="button"
                className="btn"
                aria-pressed={!rows}
                disabled={draft.type === 'table'}
                aria-describedby={draft.type === 'table' ? `${id}-values-hint` : undefined}
                onClick={() => change({ mode: 'values', keys: [], keep: [] })}
              >
                Values over time
              </button>
              <button
                type="button"
                className="btn"
                aria-pressed={rows}
                disabled={draft.type === 'chart'}
                aria-describedby={draft.type === 'chart' ? `${id}-rows-hint` : undefined}
                onClick={() => change({ mode: 'rows' })}
              >
                Row tracking
              </button>
            </div>
            {draft.type === 'table' && (
              <span id={`${id}-values-hint`} className="faint text-[12px]">
                Tables show tracked rows.
              </span>
            )}
            {draft.type === 'chart' && (
              <span id={`${id}-rows-hint`} className="faint text-[12px]">
                Charts plot values over time.
              </span>
            )}
            {rows && (
              <>
                {names.length === 0 && <span className="faint text-[12px]">Run preview to choose columns.</span>}
                <ColumnMulti
                  label="Key columns: what makes a row the same row"
                  value={h.keys}
                  columns={names}
                  onChange={(keys) => change({ keys, keep: h.keep.filter((k) => !keys.includes(k)) })}
                />
                {h.keys.length === 0 ? (
                  <span className="text-[12px] text-bad">Choose at least one key column.</span>
                ) : unique === true && result ? (
                  <span className="text-[12px] text-ok">✓ Unique in the last result ({result.rows.length} rows)</span>
                ) : unique === false ? (
                  <span className="text-[12px] text-bad">Not unique in the last result</span>
                ) : null}
                <ColumnMulti
                  label="Also keep, to show rows that are gone"
                  value={h.keep}
                  columns={names.filter((n) => !h.keys.includes(n))}
                  onChange={(keep) => change({ keep })}
                />
              </>
            )}
            <label className="field">
              <span>Save at most</span>
              <select className="textbox" value={h.interval} onChange={(e) => change({ interval: e.target.value as WidgetHistory['interval'] })}>
                {INTERVALS.map(([v, name]) => (
                  <option key={v} value={v}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{rows ? 'Forget gone rows after' : 'Keep snapshots for'}</span>
              <select className="textbox" value={h.retentionDays} onChange={(e) => change({ retentionDays: Number(e.target.value) as WidgetHistory['retentionDays'] })}>
                {RETENTION.map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <b>Stored history</b>
        {error ? (
          <span role="alert" className="text-[12px] text-bad">
            {error}
          </span>
        ) : series === null ? (
          <span className="faint text-[12px]">Loading…</span>
        ) : series.length === 0 ? (
          <span className="faint text-[12px]">Nothing stored yet.</span>
        ) : (
          <table className="text-[12.5px]">
            <thead>
              <tr className="muted text-left">
                <th className="font-normal">Series</th>
                <th className="font-normal">Since</th>
                <th className="font-normal">Snapshots</th>
                <th className="font-normal">Stored</th>
              </tr>
            </thead>
            <tbody>
              {series.map((s, i) => (
                <tr key={i}>
                  <td>{s.label}</td>
                  <td>{date.format(new Date(s.since))}</td>
                  <td>{s.gaps > 0 ? `${s.snapshots} · ${s.gaps} gaps` : `${s.snapshots}`}</td>
                  <td>{s.stored}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
