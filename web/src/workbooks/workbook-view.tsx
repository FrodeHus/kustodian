import { useEffect, useState } from 'react';
import { call } from '../bridge';
import { useRevisions } from '../library/saving';
import { MenuButton } from '../results/result-grid';
import { runCommand } from '../shell/commands';
import { ErrorReportActions, type Shown } from '../shell/error-report';
import { errorText } from '../shell/errors';
import { reportIdOf } from '../shell/report-id';
import { ConfirmDelete } from '../side/row-menu';
import { useTabs } from '../tabs/tab-store';
import { narrowOrder } from './layout';
import type { Widget, WorkbookParameter } from './model';
import { WidgetFrame } from './widget-frame';
import { ChartWidget } from './widgets/chart-widget';
import { MarkdownWidget } from './widgets/markdown-widget';
import { StatWidget } from './widgets/stat-widget';
import { TableWidget } from './widgets/table-widget';
import { useWorkbooks } from './workbook-store';

const ALL = '\u0000all';

/** A workbook parameter's control in the bar: a select for a list with choices (several values, one per line, when `multi`;
 * `all` adds "All", which picks every choice), else a text box. Text reruns as typing stops, or at once on Enter. */
function ParamControl({ tabId, param, value }: { tabId: string; param: WorkbookParameter; value: string }) {
  const set = (v: string, now = true) => useWorkbooks.getState().setWorkbookValue(tabId, param.name, v, { now });
  const label = param.label ?? param.name;
  const choices = param.type === 'list' ? (param.choices ?? []).filter((c) => c.trim() !== '') : [];
  let control;
  if (choices.length > 0 && param.multi) {
    control = (
      <select
        multiple
        className="textbox mono h-auto py-1"
        aria-label={label}
        value={value.split('\n')}
        onChange={(e) => {
          const picked = [...e.target.selectedOptions].map((o) => o.value);
          set((picked.includes(ALL) ? choices : picked).join('\n'));
        }}
      >
        {param.all && <option value={ALL}>All</option>}
        {choices.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    );
  } else if (choices.length > 0) {
    const all = choices.join('\n');
    const options = [...(param.all ? [{ value: all, text: 'All' }] : []), ...choices.map((c) => ({ value: c, text: c }))];
    control = (
      <select className="textbox mono" style={{ height: 28 }} aria-label={label} value={value} onChange={(e) => set(e.target.value)}>
        {!options.some((o) => o.value === value) && <option value={value}>{value === '' ? '(none)' : value}</option>}
        {options.map((o) => (
          <option key={o.text} value={o.value}>
            {o.text}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <input
        className="textbox mono w-40"
        style={{ height: 28 }}
        aria-label={label}
        value={value}
        onChange={(e) => set(e.target.value, false)}
        onKeyDown={(e) => e.key === 'Enter' && set(e.currentTarget.value)}
      />
    );
  }
  return (
    <label className="flex items-center gap-2 text-[12.5px]">
      <span className="muted">{label}</span>
      {control}
    </label>
  );
}

/** "Updated 12 s ago": since the last widget run ended, ticking each second. */
function Updated({ at }: { at: number }) {
  const [now, setNow] = useState(at);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const s = Math.max(0, Math.round((now - at) / 1000));
  return <span className="faint text-[12px]">Updated {s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`} ago</span>;
}

/**
 * A workbook tab in view mode (spec 5.3, screen 1): the toolbar (name, folder, when it last updated, Refresh all, Edit, and
 * ⋯ with Save, Save current values as defaults and Delete), the parameter bar, and the widgets on the 12-column grid, which
 * stacks them full width in (y, x) order when narrow (`.wb-grid`).
 */
export function WorkbookView({ tabId, onSignIn }: { tabId: string; onSignIn?: () => void }) {
  const state = useWorkbooks((s) => s.byTab[tabId]);
  const savedId = useTabs((s) => s.tabs.find((t) => t.id === tabId)?.savedId);
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<Shown | null>(null);
  if (!state) {
    return <p className="faint m-0 p-4 text-[12px]">Opening the workbook…</p>;
  }
  const { doc, values, runs, editing, viewCharts } = state;
  const store = useWorkbooks.getState;
  const updatedAt = Math.max(0, ...Object.values(runs).map((r) => (r.state === 'done' || r.state === 'failed' ? (r.finishedAt ?? 0) : 0)));

  const remove = () => {
    setDeleting(false);
    if (!savedId) {
      return;
    }
    call('workbook.delete', { id: savedId }).then(
      () => {
        useRevisions.getState().bump('library');
        useTabs.getState().close(tabId);
      },
      (e: unknown) => setProblem({ text: `It couldn’t be deleted: ${errorText(e)}`, reportId: reportIdOf(e) }),
    );
  };

  const body = (w: Widget) => {
    const run = runs[w.id] ?? { state: 'idle' };
    switch (w.type) {
      case 'markdown':
        return <MarkdownWidget text={w.markdown ?? ''} values={values.workbook} />;
      case 'chart':
        return (
          <ChartWidget
            widget={w}
            run={run}
            picked={viewCharts[w.id] ?? w.chart ?? {}}
            // Ruling R3: a pick outside edit mode is view state; in edit mode it is the widget's.
            onChart={(picked) =>
              editing
                ? store().edit(tabId, (d) => ({ ...d, widgets: d.widgets.map((x) => (x.id === w.id ? { ...x, chart: picked } : x)) }))
                : store().setViewChart(tabId, w.id, picked)
            }
          />
        );
      case 'table':
        return <TableWidget widget={w} run={run} />;
      case 'stat':
        return <StatWidget widget={w} run={run} />;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="toolbar">
        <h1 className="m-0 truncate text-[14px] font-semibold">{doc.name}</h1>
        {doc.folder && <span className="muted text-[12px]">{doc.folder}</span>}
        {updatedAt > 0 && <Updated key={updatedAt} at={updatedAt} />}
        <div className="grow" />
        <button type="button" className="btn" onClick={() => void store().runAll(tabId, { refresh: true })}>
          Refresh all
        </button>
        <button type="button" className="btn" aria-pressed={editing} onClick={() => store().setEditing(tabId, true)}>
          Edit
        </button>
        <MenuButton label="Workbook menu" icon="⋯">
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => runCommand('file.save')}>
            Save
          </button>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => store().saveValuesAsDefaults(tabId)}>
            Save current values as defaults
          </button>
          <button type="button" role="menuitem" tabIndex={-1} disabled={!savedId} onClick={() => setDeleting(true)}>
            Delete
          </button>
        </MenuButton>
      </div>
      {deleting && <ConfirmDelete name={doc.name} onDelete={remove} onCancel={() => setDeleting(false)} />}
      {problem && (
        <p className="m-0 flex items-center gap-2 px-3 py-1.5 text-[12px] text-bad" role="alert">
          {problem.text}
          <ErrorReportActions reportId={problem.reportId} uiSections={{ message: problem.text }} />
        </p>
      )}
      {doc.parameters.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-3 py-2" role="group" aria-label="Workbook parameters">
          {doc.parameters.map((p) => (
            <ParamControl key={p.name} tabId={tabId} param={p} value={values.workbook[p.name] ?? p.value} />
          ))}
        </div>
      )}
      <div className="wb-canvas min-h-0 flex-1 overflow-auto p-3">
        {doc.widgets.length === 0 ? (
          <p className="faint m-0 text-[12px]">No widgets yet. Edit the workbook to add some.</p>
        ) : (
          <div className="wb-grid">
            {narrowOrder(doc.widgets).map((w) => (
              <WidgetFrame key={w.id} tabId={tabId} widget={w} onSignIn={onSignIn}>
                {body(w)}
              </WidgetFrame>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
