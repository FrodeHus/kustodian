import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { PARAMETER_TYPES } from '../params/find-params';
import { inSendDetails } from '../shell/send-details-marker';
import type { WorkbookParameter } from './model';
import { widgetsUsing } from './resolve';
import { useWorkbooks } from './workbook-store';

const NAME_RULE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A parameter in the draft: `orig` is its name in the workbook (null when new), `key` keeps its place in the list. */
interface Row {
  key: string;
  orig: string | null;
  p: WorkbookParameter;
}

/** Choices as kept: each line trimmed, blank ones dropped; null when there are none. */
const clean = (p: WorkbookParameter): WorkbookParameter => {
  const kept = (p.choices ?? []).map((c) => c.trim()).filter((c) => c !== '');
  const choices = p.choices && kept.length > 0 ? kept : null;
  const several = p.type === 'list' && !!choices;
  return {
    ...p,
    choices,
    multi: several && p.multi,
    all: several && p.all,
    huntingTimespan: p.type === 'timespan' && p.huntingTimespan,
  };
};

/**
 * Workbook parameters (spec 6.3, screen 4, v1 parts): a reorderable list (drag, or Alt+↑/↓) and the selected parameter's
 * details, with the widgets that use it. Save writes one `edit` (a rename renames the widgets' own entries, never query
 * text) and reruns the widgets, since edits don't; Cancel writes nothing.
 */
export function ParametersDialog({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const doc = useWorkbooks((s) => s.byTab[tabId]?.doc);
  const [rows, setRows] = useState<Row[]>(() => (doc?.parameters ?? []).map((p) => ({ key: crypto.randomUUID(), orig: p.name, p })));
  const [at, setAt] = useState(0);
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const itemRefs = useRef<Record<string, HTMLElement | null>>({});
  const focusKey = useRef<string | null>(null);
  const dragged = useRef<number | null>(null);

  // Focus starts on the first parameter, or Add parameter when there is none: the first button.
  useEffect(() => dialogRef.current?.querySelector<HTMLElement>('button')?.focus(), []);
  // A modal, as the widget editor is: focus that lands outside it goes back to it.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (!closing.current && !inSendDetails(e.target) && (!(e.target instanceof Node) || !dialogRef.current?.contains(e.target))) {
        dialogRef.current?.querySelector<HTMLElement>('input, button')?.focus();
      }
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);
  useEffect(() => {
    if (focusKey.current !== null) {
      itemRefs.current[focusKey.current]?.focus();
      focusKey.current = null;
    }
  });

  if (!doc) {
    return null;
  }
  const close = () => {
    closing.current = true;
    onClose();
  };
  const sel = Math.min(at, rows.length - 1);
  const row = rows[sel];
  const draftDoc = { ...doc, parameters: rows.map((r) => r.p) };
  const widgetTitle = (wid: string) => doc.widgets.find((w) => w.id === wid)?.title || 'Untitled widget';
  const usedBy = (name: string) => widgetsUsing(draftDoc, name);

  const error = (r: Row, i: number) => {
    if (!NAME_RULE.test(r.p.name)) {
      return 'Use letters, digits and _, not starting with a digit.';
    }
    return rows.some((o, j) => j !== i && o.p.name === r.p.name) ? `Another parameter is already named ${r.p.name}.` : null;
  };
  const invalid = rows.some((r, i) => error(r, i));

  const change = (patch: Partial<WorkbookParameter>) => setRows(rows.map((r, i) => (i === sel ? { ...r, p: { ...r.p, ...patch } } : r)));
  // One workbook timespan sends the hunting timespan: marking this one clears the mark elsewhere.
  const markHunting = (on: boolean) => setRows(rows.map((r, i) => ({ ...r, p: { ...r.p, huntingTimespan: i === sel ? on : on ? false : r.p.huntingTimespan } })));
  const add = () => {
    let n = 1;
    while (rows.some((r) => r.p.name === `Parameter${n}`)) {
      n++;
    }
    const p: WorkbookParameter = {
      name: `Parameter${n}`,
      type: 'text',
      value: '',
      required: false,
      choices: null,
      label: null,
      multi: false,
      all: false,
      remember: false,
      huntingTimespan: false,
    };
    setRows([...rows, { key: crypto.randomUUID(), orig: null, p }]);
    setAt(rows.length);
  };
  const remove = () => {
    setRows(rows.filter((_, i) => i !== sel));
    setAt(Math.max(0, sel - 1));
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length || from === to) {
      return;
    }
    const moved = [...rows];
    const [r] = moved.splice(from, 1);
    moved.splice(to, 0, r!);
    setRows(moved);
    setAt(to);
    focusKey.current = r!.key;
  };
  const onItemKey = (e: KeyboardEvent, i: number) => {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      move(i, i + (e.key === 'ArrowUp' ? -1 : 1));
    }
  };

  const save = () => {
    close();
    const kept = rows.map((r) => clean(r.p));
    const renamed = new Map(rows.filter((r) => r.orig !== null && r.orig !== r.p.name).map((r) => [r.orig!, r.p.name]));
    if (JSON.stringify(kept) === JSON.stringify(doc.parameters)) {
      return;
    }
    const store = useWorkbooks.getState();
    store.edit(tabId, (d) => ({
      ...d,
      parameters: kept,
      widgets:
        renamed.size === 0
          ? d.widgets
          : d.widgets.map((w) => ({ ...w, parameters: Object.fromEntries(Object.entries(w.parameters).map(([k, v]) => [renamed.get(k) ?? k, v])) })),
    }));
    // Edits don't rerun widgets (the store's ruling): the parameters changed, so everything reruns.
    void store.runAll(tabId);
  };

  const p = row?.p;
  const err = row ? error(row, sel) : null;
  const several = p?.type === 'list' && !!p.choices;

  return (
    <div className="fixed inset-0 z-20">
      <div className="scrim" onClick={close} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="card absolute top-[6vh] left-1/2 flex max-h-[88vh] w-[760px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-3 overflow-auto p-5"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault();
            close();
          }
        }}
      >
        <b id={`${id}-title`} className="text-[14px]">
          Workbook parameters
        </b>
        <div className="grid min-h-0 grid-cols-[240px_minmax(0,1fr)] gap-4">
          <div className="flex flex-col gap-2">
            <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Parameters">
              {rows.map((r, i) => {
                const n = usedBy(r.p.name).length;
                return (
                  <li
                    key={r.key}
                    draggable
                    onDragStart={() => (dragged.current = i)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => dragged.current !== null && move(dragged.current, i)}
                  >
                    <button
                      ref={(el) => {
                        itemRefs.current[r.key] = el;
                      }}
                      type="button"
                      className="btn ghost flex w-full flex-col items-start text-left"
                      aria-current={i === sel}
                      onClick={() => setAt(i)}
                      onKeyDown={(e) => onItemKey(e, i)}
                    >
                      <span className="mono">{r.p.name}</span>
                      <span className="faint text-[11.5px]">
                        {r.p.type}
                        {r.p.value ? ` · ${r.p.value}` : ''} · {n === 0 ? 'Not used' : `${n} ${n === 1 ? 'widget' : 'widgets'}`}
                        {error(r, i) ? ' · Fix the name' : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <button type="button" className="btn" onClick={add}>
              Add parameter
            </button>
            <span className="faint text-[11.5px]">Drag, or Alt+↑ / Alt+↓, to reorder.</span>
          </div>
          {p ? (
            <div className="flex flex-col gap-3">
              <label className="field">
                <span>Name</span>
                <input className="textbox mono" value={p.name} aria-invalid={!!err} aria-describedby={`${id}-name`} onChange={(e) => change({ name: e.target.value })} />
              </label>
              <span id={`${id}-name`} className="faint text-[11.5px]">
                Renaming renames the widgets’ own entries only; it doesn’t edit query text, so change {'{' + (row?.orig ?? p.name) + '}'} in queries yourself.
              </span>
              {err && (
                <span className="text-[12px] text-bad" role="alert">
                  {err}
                </span>
              )}
              <label className="field">
                <span>Label</span>
                <input className="textbox" value={p.label ?? ''} onChange={(e) => change({ label: e.target.value === '' ? null : e.target.value })} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="field">
                  <span>Type</span>
                  <select className="textbox" value={p.type} onChange={(e) => change({ type: e.target.value })}>
                    {PARAMETER_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Choices</span>
                  <select className="textbox" value={p.choices ? 'fixed' : 'none'} onChange={(e) => change({ choices: e.target.value === 'fixed' ? [''] : null })}>
                    <option value="none">None, free entry</option>
                    <option value="fixed">Fixed list</option>
                  </select>
                </label>
              </div>
              {p.choices && (
                <label className="field">
                  <span>Fixed list</span>
                  <textarea className="textbox mono h-auto py-1.5" rows={3} placeholder="One per line" value={p.choices.join('\n')} onChange={(e) => change({ choices: e.target.value.split('\n') })} />
                </label>
              )}
              <label className="field">
                <span>Default</span>
                <input className="textbox mono" value={p.value} onChange={(e) => change({ value: e.target.value })} />
              </label>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px]">
                {several && (
                  <>
                    <label className="flex items-center gap-1.5">
                      <input type="checkbox" checked={p.multi} onChange={(e) => change({ multi: e.target.checked })} />
                      Several values
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input type="checkbox" checked={p.all} onChange={(e) => change({ all: e.target.checked })} />
                      Offer “All”
                    </label>
                  </>
                )}
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={p.required} onChange={(e) => change({ required: e.target.checked })} />
                  Required
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={p.remember} onChange={(e) => change({ remember: e.target.checked })} />
                  Remember my last value
                </label>
                {p.type === 'timespan' && (
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={p.huntingTimespan} onChange={(e) => markHunting(e.target.checked)} />
                    Use as the Defender hunting timespan
                  </label>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <b className="text-[12.5px]">Used by</b>
                {usedBy(p.name).length === 0 ? (
                  <span className="faint text-[12px]">Not used</span>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[12.5px]" aria-label="Used by">
                    {usedBy(p.name).map((wid) => (
                      <li key={wid}>{widgetTitle(wid)}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <button type="button" className="btn ghost" onClick={remove}>
                  Remove parameter
                </button>
              </div>
            </div>
          ) : (
            <p className="faint m-0 text-[12px]">No parameters yet.</p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={invalid} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
