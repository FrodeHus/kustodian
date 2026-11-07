import { useEffect, useId, useState } from 'react';
import { call } from '../bridge';
import { commandLine, defaultMapping, toolColumns } from '../results/tool-args';
import { errorText } from '../shell/errors';
import { ErrorReportActions, type Shown } from '../shell/error-report';
import { reportIdOf } from '../shell/report-id';
import type { ExternalTool, ResultColumn, ToolList } from '../wire';
import { newToolButton, type ToolButton, type Widget } from './model';

/** A select over the result's columns; '' is "Automatic": the widget's (or the tool run's) own pick. */
export function ColumnSelect({ label, value, columns, onChange }: { label: string; value: string; columns: string[]; onChange: (value: string) => void }) {
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

const MODE_NAMES = { each: 'once per row', batch: 'once, rows on stdin' } as const;

/**
 * The widget editor's Tool buttons tab (screen 6): a table widget's buttons, whether its rows can be selected, and for the
 * chosen button its label, placement, tool, column mapping, which rows it runs on and what refreshes after. Edits `draft`
 * through `set`; the editor's Apply writes it.
 */
export function ToolButtonsSection({ draft, columns, set }: { draft: Widget; columns: ResultColumn[]; set: (change: Partial<Widget>) => void }) {
  const id = useId();
  const [list, setList] = useState<ToolList | null>(null);
  const [error, setError] = useState<Shown | null>(null);
  const [selected, setSelected] = useState(0);
  // Read each time the tab opens, so a tool just added to tools.json shows.
  useEffect(() => {
    call<ToolList>('tools.list').then(setList, (e: unknown) => setError({ text: errorText(e), reportId: reportIdOf(e) }));
  }, []);

  const tools = draft.tools ?? [];
  const selection = draft.selection ?? 'multi';
  const at = Math.min(selected, tools.length - 1);
  const button = tools[at];
  const find = (name: string): ExternalTool | undefined => list?.tools.find((t) => t.name === name);
  const tool = button && find(button.tool);
  const problem = error?.text ?? list?.problem;

  // Keep a saved mapping listed when its column isn't in the result (no result yet), so the select shows it.
  const mapped = (saved: string | undefined) => {
    const names = columns.map((c) => c.name);
    return saved && !names.includes(saved) ? [...names, saved] : names;
  };
  const setButton = (change: Partial<ToolButton>) => set({ tools: tools.map((b, i) => (i === at ? { ...b, ...change } : b)) });
  const chooseTool = (name: string) => {
    const next = find(name);
    if (!button || !next) {
      return;
    }
    const label = button.label.trim() === '' || button.label === button.tool ? next.name : button.label;
    setButton({ tool: next.name, label, mapping: defaultMapping(next, columns) });
  };
  const add = () => {
    set({ tools: [...tools, newToolButton()] });
    setSelected(tools.length);
  };
  const editTools = () => void call('tools.edit').catch((e: unknown) => setError({ text: errorText(e), reportId: reportIdOf(e) }));

  return (
    <div className="grid grid-cols-[200px_1fr] gap-4 text-[12.5px]">
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-1" role="group" aria-label="Tool buttons">
          {tools.map((b, i) => {
            const mode = find(b.tool)?.mode;
            return (
              <button key={i} type="button" className="btn justify-start" aria-pressed={i === at} onClick={() => setSelected(i)}>
                <span className="truncate">{b.label || 'New button'}</span>
                {mode && <span className="faint">{mode}</span>}
                {b.placement === 'menu' && <span className="faint">in ⋯</span>}
              </button>
            );
          })}
        </div>
        <button type="button" className="btn ghost justify-start" onClick={add}>
          + Add tool button
        </button>
        <label className="mt-2 flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={selection !== 'none'}
            onChange={(e) =>
              set(e.target.checked ? { selection: 'multi' } : { selection: 'none', tools: tools.map((b) => ({ ...b, runsOn: 'selectedOrAll' as const })) })
            }
          />
          Rows can be selected
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={selection === 'multi'}
            disabled={selection === 'none'}
            onChange={(e) => set({ selection: e.target.checked ? 'multi' : 'single' })}
          />
          Several rows at once
        </label>
      </div>
      {button && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="field">
              <span>Button label</span>
              <input className="textbox" value={button.label} onChange={(e) => setButton({ label: e.target.value })} />
            </label>
            <label className="field">
              <span>Placement</span>
              <select className="textbox" value={button.placement} onChange={(e) => setButton({ placement: e.target.value as ToolButton['placement'] })}>
                <option value="header">In the widget header</option>
                <option value="menu">In the ⋯ menu</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>Tool</span>
            <select className="textbox" value={button.tool} aria-invalid={!button.tool} onChange={(e) => chooseTool(e.target.value)}>
              {!tool && (
                <option value={button.tool}>{!button.tool ? 'Choose a tool…' : list ? `${button.tool} (not in your tools.json)` : button.tool}</option>
              )}
              {list?.tools.map((t) => (
                <option key={t.name} value={t.name}>
                  {`${t.name} · ${MODE_NAMES[t.mode]}`}
                </option>
              ))}
            </select>
          </label>
          {tool && <pre className="codeblock m-0 overflow-auto">{commandLine(tool.command, tool.args)}</pre>}
          {problem && (
            <span role="alert" className="text-[12px] text-bad">
              {problem}
              <ErrorReportActions reportId={error?.reportId} uiSections={{ message: problem }} />
            </span>
          )}
          <span className="faint text-[12px]">
            Tools come from your tools.json (
            <button type="button" className="underline" onClick={editTools}>
              Edit tools…
            </button>
            ). The workbook saves the tool's name and this column mapping, never the command.
          </span>
          {tool?.mode === 'batch' ? (
            <span className="faint text-[12px]">A batch tool gets the rows on stdin as JSON.</span>
          ) : (
            tool &&
            toolColumns(tool).length > 0 && (
              <div className="flex flex-col gap-2">
                <b>Parameters from the result</b>
                <div className="grid grid-cols-2 gap-3">
                  {toolColumns(tool).map((p) => (
                    <ColumnSelect
                      key={p}
                      label={`{${p}}`}
                      value={button.mapping[p] ?? ''}
                      columns={mapped(button.mapping[p])}
                      onChange={(column) => setButton({ mapping: { ...button.mapping, [p]: column } })}
                    />
                  ))}
                </div>
              </div>
            )
          )}
          <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1.5 p-0 font-semibold">Runs on</legend>
            <label className="flex items-center gap-1.5">
              <input type="radio" name={`${id}-runs`} checked={button.runsOn === 'selectedOrAll'} onChange={() => setButton({ runsOn: 'selectedOrAll' })} />
              The selected rows; all rows the filter shows when none are selected
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`${id}-runs`}
                checked={button.runsOn === 'selected'}
                disabled={selection === 'none'}
                onChange={() => setButton({ runsOn: 'selected' })}
              />
              Only selected rows (button is off with none selected)
            </label>
          </fieldset>
          <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1.5 p-0 font-semibold">After it runs</legend>
            {(
              [
                ['refreshWidget', 'Refresh this widget'],
                ['refreshWorkbook', 'Refresh the whole workbook'],
                ['none', 'Nothing'],
              ] as const
            ).map(([after, name]) => (
              <label key={after} className="flex items-center gap-1.5">
                <input type="radio" name={`${id}-after`} checked={button.after === after} onChange={() => setButton({ after })} />
                {name}
              </label>
            ))}
          </fieldset>
          <div>
            <button type="button" className="btn" onClick={() => set({ tools: tools.filter((_, i) => i !== at) })}>
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
