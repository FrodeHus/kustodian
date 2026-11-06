import { Suspense, lazy, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { call } from '../bridge';
import { openSaved } from '../library/open-library';
import { PARAMETER_TYPES } from '../params/find-params';
import { CHART_TYPES } from '../results/chart-shape';
import { useSchemas } from '../schema/schema-store';
import { errorText } from '../shell/errors';
import { inSendDetails } from '../shell/send-details-marker';
import { SourceBadge } from '../tabs/source-badge';
import type { LibraryList, ParameterDef, RunResult, SavedQuery } from '../wire';
import type { ParamFrom, Widget, WidgetQuery } from './model';
import { widgetParams } from './resolve';
import { ChartWidget } from './widgets/chart-widget';
import { MarkdownWidget } from './widgets/markdown-widget';
import { StatWidget } from './widgets/stat-widget';
import { TableWidget } from './widgets/table-widget';
import { readLibrary, useWorkbooks } from './workbook-store';

// The same chunk the query tab's editor loads.
const KqlEditor = lazy(() => import('../editor/kql-editor'));

const SOURCE_NAMES: [WidgetQuery['source'], string][] = [
  ['graph', 'Graph'],
  ['hunting', 'Defender hunting'],
  ['arg', 'Resource Graph'],
];
const FROM_NAMES: [ParamFrom, string][] = [
  ['workbook', 'Workbook'],
  ['widget', 'Widget · shown'],
  ['fixed', 'Fixed'],
];

type Section = 'query' | 'parameters' | 'visualization';
// A table has no visualization settings in v1.
const SECTIONS: [Section, string][] = [
  ['query', 'Query'],
  ['parameters', 'Parameters'],
  ['visualization', 'Visualization'],
];

/** The query a saved one makes: its source, text, options and parameters, linked when `linked`. */
const fromSaved = (query: WidgetQuery, q: SavedQuery, linked: boolean): WidgetQuery =>
  q.source === 'raw'
    ? query
    : { ...query, source: q.source, text: q.text, options: q.options ?? null, parameters: q.parameters, saved: linked ? { id: q.id, name: q.name } : null };

/** A select over the preview's columns; '' is the chart's or stat's own pick. */
function ColumnSelect({ label, value, columns, onChange }: { label: string; value: string; columns: string[]; onChange: (value: string) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select className="textbox" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Automatic</option>
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Edit widget (spec 5.4 and 6.2, screen 3): the title, then for a data widget its Query (written here, or a linked saved
 * query with Copy into widget and Open in tab), Parameters (where each placeholder's value comes from) and Visualization,
 * with a preview run of the draft; a Markdown widget has its text and a rendered preview instead. Apply writes the draft as
 * one `edit` and reruns the widget; Cancel writes nothing.
 */
export function WidgetEditor({ tabId, widgetId, onClose }: { tabId: string; widgetId: string; onClose: () => void }) {
  const doc = useWorkbooks((s) => s.byTab[tabId]?.doc);
  const values = useWorkbooks((s) => s.byTab[tabId]?.values);
  const lastRun = useWorkbooks((s) => s.byTab[tabId]?.runs[widgetId]);
  const original = doc?.widgets.find((w) => w.id === widgetId);
  const [draft, setDraft] = useState(original);
  const [section, setSection] = useState<Section>('query');
  const [queries, setQueries] = useState<SavedQuery[] | null>(null);
  const [preview, setPreview] = useState<{ state: 'running' } | { state: 'done'; result: RunResult } | { state: 'failed'; text: string } | null>(null);
  const schemas = useSchemas((s) => s.byKey);
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const previews = useRef(0);
  // A saved query linked here may be newer than the tab's copy of the library, which linked widgets run from.
  const libraryRead = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let live = true;
    call<LibraryList>('library.list').then(
      (l) => live && setQueries(l.queries.filter((q) => q.source !== 'raw')),
      () => live && setQueries([]),
    );
    return () => {
      live = false;
    };
  }, []);

  // A modal, as the save dialog is: focus that lands outside it goes back to it.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (!closing.current && !inSendDetails(e.target) && (!(e.target instanceof Node) || !dialogRef.current?.contains(e.target))) {
        dialogRef.current?.querySelector<HTMLElement>('input, button')?.focus();
      }
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  const source = draft?.query?.saved ? undefined : draft?.query?.source;
  // The editor completes against the source's schema; a source no tab has opened isn't read yet.
  useEffect(() => {
    const s = useSchemas.getState();
    if (source && !s.byKey[source] && !s.loading[source]) {
      void s.load(source);
    }
  }, [source]);

  if (!doc || !values || !original || !draft) {
    return null;
  }
  const close = () => {
    closing.current = true;
    onClose();
  };
  const store = useWorkbooks.getState;
  const set = (change: Partial<Widget>) => setDraft({ ...draft, ...change });
  const setQuery = (change: Partial<WidgetQuery>) => draft.query && set({ query: { ...draft.query, ...change } });
  const query = draft.query;
  const linked = query?.saved ? queries?.find((q) => q.id === query.saved?.id) : undefined;
  // The draft as it runs: a linked query is the library's.
  const live: Widget = query && linked ? { ...draft, query: fromSaved(query, linked, true) } : draft;

  const link = (q: SavedQuery) => {
    if (query) {
      setQuery(fromSaved(query, q, true));
      libraryRead.current = readLibrary(tabId);
    }
  };
  const copyIn = () => query && setQuery(linked ? fromSaved(query, linked, false) : { saved: null });

  const apply = () => {
    close();
    if (draft === original) {
      return;
    }
    store().edit(tabId, (d) => ({ ...d, widgets: d.widgets.map((w) => (w.id === widgetId ? draft : w)) }));
    // Edits don't rerun widgets (the store's ruling): Apply reruns the one it changed.
    if (draft.query) {
      void libraryRead.current.then(() => store().runWidget(tabId, widgetId));
    }
  };

  const runPreview = () => {
    const n = ++previews.current;
    setPreview({ state: 'running' });
    void libraryRead.current
      .then(() => store().runDraft(tabId, draft))
      .then(
        (result) => n === previews.current && setPreview({ state: 'done', result }),
        (e: unknown) => n === previews.current && !(e instanceof DOMException && e.name === 'AbortError') && setPreview({ state: 'failed', text: errorText(e) }),
      );
  };

  const result = preview?.state === 'done' ? preview.result : lastRun?.state === 'done' ? lastRun.result : null;
  const columns = result?.columns.map((c) => c.name) ?? [];

  const params = widgetParams(doc, live, values);
  const setParam = (name: string, from: ParamFrom, value: string) => {
    const { [name]: _old, ...rest } = draft.parameters;
    set({ parameters: from === 'workbook' ? rest : { ...rest, [name]: { from, value } } });
  };
  const setType = (name: string, type: string) => {
    if (!query) {
      return;
    }
    const def: ParameterDef = query.parameters.find((p) => p.name === name) ?? { name, type, value: '', required: false, choices: null };
    setQuery({ parameters: [...query.parameters.filter((p) => p.name !== name), { ...def, type }] });
  };

  let body: ReactNode;
  if (draft.type === 'markdown') {
    body = (
      <div className="grid min-h-0 grid-cols-2 gap-3">
        <label className="field">
          <span>Markdown</span>
          <textarea className="textbox mono h-64 py-2" value={draft.markdown ?? ''} onChange={(e) => set({ markdown: e.target.value })} />
        </label>
        <div className="card flex h-64 min-h-0 flex-col pt-3">
          <MarkdownWidget text={draft.markdown ?? ''} values={values.workbook} />
        </div>
      </div>
    );
  } else if (query) {
    const queryPanel = (
      <div className="flex flex-col gap-3">
        <div className="flex gap-4 text-[12.5px]" role="radiogroup" aria-label="Query">
          <label className="flex items-center gap-1.5">
            <input type="radio" name={`${id}-form`} checked={!query.saved} onChange={copyIn} />
            Write a query here
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" name={`${id}-form`} checked={!!query.saved} onChange={() => setQuery({ saved: { id: '', name: '' } })} />
            Use a saved query
          </label>
        </div>
        {query.saved ? (
          <>
            <div className="flex items-center gap-2">
              <select
                className="textbox grow"
                aria-label="Saved query"
                value={query.saved.id}
                onChange={(e) => {
                  const q = queries?.find((x) => x.id === e.target.value);
                  if (q) {
                    link(q);
                  }
                }}
              >
                {!linked && <option value={query.saved.id}>{query.saved.id ? `${query.saved.name} (not in the library)` : 'Choose a saved query…'}</option>}
                {queries?.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.name}
                  </option>
                ))}
              </select>
              {linked && <SourceBadge source={linked.source} titled />}
              <button type="button" className="btn" disabled={!linked} onClick={() => linked && openSaved(linked)}>
                Open in tab
              </button>
              {/* The library's text once it is read; a query it no longer has copies the widget's last copy. */}
              <button type="button" className="btn" disabled={!query.saved.id || !queries} onClick={copyIn}>
                Copy into widget
              </button>
            </div>
            {query.saved.id && <pre className="mono card m-0 max-h-48 overflow-auto p-2 text-[12px] whitespace-pre-wrap">{live.query?.text}</pre>}
            {linked && (
              <span className="faint text-[12px]">Linked: changes to the saved query show up here. Saved {new Date(linked.modifiedAt).toLocaleString()}.</span>
            )}
          </>
        ) : (
          <>
            <label className="field">
              <span>Source</span>
              <select
                className="textbox"
                value={query.source}
                onChange={(e) => setQuery({ source: e.target.value as WidgetQuery['source'], options: null })}
              >
                {SOURCE_NAMES.map(([s, name]) => (
                  <option key={s} value={s}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <div className="card h-56 overflow-hidden">
              <Suspense fallback={<p className="faint m-0 p-4 text-[12px]">Loading the editor…</p>}>
                <KqlEditor
                  schemas={schemas}
                  onRun={runPreview}
                  draft={{ id: 'widget-editor', source: query.source, text: query.text, onChange: (text) => setQuery({ text }) }}
                />
              </Suspense>
            </div>
          </>
        )}
      </div>
    );

    const parametersPanel =
      params.length === 0 ? (
        <p className="faint m-0 text-[12px]">The query has no {'{name}'} placeholders.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <table className="text-[12.5px]">
            <thead>
              <tr className="muted text-left">
                <th className="font-normal">Name</th>
                <th className="font-normal">Type</th>
                <th className="font-normal">Value comes from</th>
                <th className="font-normal">Value</th>
              </tr>
            </thead>
            <tbody>
              {params.map((p) => {
                const offered = FROM_NAMES.filter(([from]) => from !== 'workbook' || doc.parameters.some((w) => w.name === p.name));
                const own = draft.parameters[p.name]?.value ?? p.value;
                return (
                  <tr key={p.name}>
                    <td className="mono">{p.name}</td>
                    <td>
                      <select
                        className="textbox"
                        aria-label={`${p.name}: type`}
                        value={p.type}
                        disabled={p.from === 'workbook' || !!query.saved}
                        onChange={(e) => setType(p.name, e.target.value)}
                      >
                        {PARAMETER_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        className="textbox"
                        aria-label={`${p.name}: value comes from`}
                        value={p.from}
                        onChange={(e) => setParam(p.name, e.target.value as ParamFrom, own)}
                      >
                        {offered.map(([from, name]) => (
                          <option key={from} value={from}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="textbox mono"
                        aria-label={`${p.name}: value`}
                        value={p.from === 'workbook' ? p.value : own}
                        disabled={p.from === 'workbook'}
                        onChange={(e) => setParam(p.name, p.from, e.target.value)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <span className="faint text-[12px]">
            Workbook follows the workbook parameter of that name. Widget · shown puts a control in the widget’s header. Fixed
            sends the value set here.
          </span>
        </div>
      );

    const picked = draft.chart ?? {};
    const visualizationPanel =
      draft.type === 'chart' ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Chart type">
            {CHART_TYPES.map((c) => (
              <button key={c.type} type="button" className="btn" aria-pressed={picked.type === c.type} onClick={() => set({ chart: { ...picked, type: c.type } })}>
                {c.name}
              </button>
            ))}
          </div>
          {columns.length === 0 && <span className="faint text-[12px]">Run preview to choose columns.</span>}
          <div className="grid grid-cols-3 gap-3">
            <ColumnSelect label="X" value={picked.x ?? ''} columns={columns} onChange={(x) => set({ chart: { ...picked, x: x || undefined } })} />
            <ColumnSelect
              label="Y"
              value={picked.series?.[0] ?? ''}
              columns={columns}
              onChange={(y) => set({ chart: { ...picked, series: y ? [y] : undefined } })}
            />
            <ColumnSelect label="Series" value={picked.split ?? ''} columns={columns} onChange={(split) => set({ chart: { ...picked, split: split || undefined } })} />
          </div>
        </div>
      ) : draft.type === 'stat' ? (
        <div className="flex flex-col gap-3">
          {columns.length === 0 && <span className="faint text-[12px]">Run preview to choose columns.</span>}
          <div className="grid grid-cols-2 gap-3">
            <ColumnSelect
              label="Value"
              value={draft.stat?.value ?? ''}
              columns={columns}
              onChange={(v) => set({ stat: { value: v || null, compare: draft.stat?.compare ?? null } })}
            />
            <ColumnSelect
              label="Compare with"
              value={draft.stat?.compare ?? ''}
              columns={columns}
              onChange={(v) => set({ stat: { value: draft.stat?.value ?? null, compare: v || null } })}
            />
          </div>
        </div>
      ) : null;

    const shown = preview?.state === 'done' ? ({ state: 'done', result: preview.result } as const) : null;
    body = (
      <>
        <div role="tablist" aria-label="Widget settings" className="flex">
          {SECTIONS.filter(([s]) => s !== 'visualization' || visualizationPanel).map(([s, name]) => (
            <button key={s} type="button" role="tab" className="rtab" aria-selected={section === s} onClick={() => setSection(s)}>
              {name}
            </button>
          ))}
        </div>
        <div className="min-h-0 overflow-auto" role="tabpanel">
          {section === 'query' ? queryPanel : section === 'parameters' ? parametersPanel : visualizationPanel}
        </div>
        <div className="flex items-center gap-2 border-t border-line pt-3">
          <b className="text-[12.5px]">Preview</b>
          <span className="faint text-[12px]">with the workbook’s current values</span>
          <div className="grow" />
          <button type="button" className="btn" disabled={preview?.state === 'running'} onClick={runPreview}>
            Run preview
          </button>
        </div>
        <div className="card flex h-56 min-h-0 flex-col overflow-hidden">
          {preview?.state === 'running' ? (
            <p className="muted m-0 p-4 text-[12px]" role="status">
              Running
            </p>
          ) : preview?.state === 'failed' ? (
            <p className="m-0 p-4 text-[12px] text-bad" role="alert">
              {preview.text}
            </p>
          ) : shown && shown.result.outcome !== 'ok' ? (
            <p className="m-0 p-4 text-[12px] text-bad" role="alert">
              {shown.result.error?.message ?? shown.result.message ?? 'The query failed.'}
            </p>
          ) : shown ? (
            draft.type === 'chart' ? (
              <ChartWidget widget={live} run={shown} picked={picked} onChart={(chart) => set({ chart })} />
            ) : draft.type === 'stat' ? (
              <StatWidget widget={live} run={shown} />
            ) : (
              <TableWidget widget={live} run={shown} />
            )
          ) : (
            <p className="faint m-0 p-4 text-[12px]">Not run yet.</p>
          )}
        </div>
      </>
    );
  }

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
          // Monaco's own Esc (closing its suggestions) comes first.
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault();
            close();
          }
        }}
      >
        <b id={`${id}-title`} className="text-[14px]">
          Edit widget
        </b>
        <label className="field">
          <span>Title</span>
          <input className="textbox" autoFocus value={draft.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        {body}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={query?.saved?.id === ''} onClick={apply}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
