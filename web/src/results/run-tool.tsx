import { useEffect, useId, useRef, useState } from 'react';
import { call, on } from '../bridge';
import { errorText } from '../shell/errors';
import { ErrorReportActions, type Shown } from '../shell/error-report';
import { reportIdOf } from '../shell/report-id';
import { newId } from '../shell/ids';
import type { ExternalTool, ResultColumn, ToolList, ToolOutcome } from '../wire';
import type { Row } from './export';
import { commandLine, defaultMapping, fillArgs, toolColumns, type ColumnMapping } from './tool-args';

const rowCount = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'row' : 'rows'}`;

/** The Run tool menu's items: the user's tools, then Edit tools. A tool whose parameters have no column of the same name says
 * which it needs mapping; choosing it opens the run dialog, where they are mapped. */
export function ToolItems({
  columns,
  onChoose,
  onError,
}: {
  columns: ResultColumn[];
  onChoose: (tool: ExternalTool) => void;
  onError: (text: string, reportId?: string) => void;
}) {
  const [list, setList] = useState<ToolList | null>(null);
  const [error, setError] = useState<Shown | null>(null);
  // Read on every open, so a tool just added to tools.json shows.
  useEffect(() => {
    call<ToolList>('tools.list').then(setList, (e: unknown) => setError({ text: errorText(e), reportId: reportIdOf(e) }));
  }, []);
  const names = new Set(columns.map((c) => c.name));
  const problem = error?.text ?? list?.problem;

  return (
    <>
      {!list && !error && <span className="faint px-2.5 py-1 text-[11.5px]">Loading tools…</span>}
      {problem && (
        <span role="alert" className="max-w-[320px] px-2.5 py-1 text-[11.5px] text-bad">
          {problem}
          <ErrorReportActions reportId={error?.reportId} uiSections={{ message: problem }} />
        </span>
      )}
      {list && !problem && list.tools.length === 0 && <span className="faint px-2.5 py-1 text-[11.5px]">No tools yet.</span>}
      {list?.tools.map((tool) => {
        const unmatched = toolColumns(tool).filter((c) => !names.has(c));
        return (
          <button key={tool.name} type="button" role="menuitem" tabIndex={-1} onClick={() => onChoose(tool)}>
            {tool.name}
            {unmatched.length > 0 && <span className="faint"> · map {unmatched.join(', ')}</span>}
          </button>
        );
      })}
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => void call('tools.edit').catch((e: unknown) => onError(errorText(e), reportIdOf(e)))}>
        Edit tools…
      </button>
    </>
  );
}

/**
 * Runs a tool on rows once the user has mapped a column to each of its parameters (a column of the same name is chosen for
 * them) and seen what will run: the command line for the first row (or the one batch run) and how many rows. While it runs it shows how far it got and can be stopped; then it shows each run's command line and output.
 * Closing it stops a run still going.
 */
export function RunToolDialog({ tool, columns, rows, onClose }: { tool: ExternalTool; columns: ResultColumn[]; rows: Row[]; onClose: () => void }) {
  const id = useId();
  const [stage, setStage] = useState<'confirm' | 'running' | 'done'>('confirm');
  const [done, setDone] = useState(0);
  const [outcomes, setOutcomes] = useState<ToolOutcome[]>([]);
  const [error, setError] = useState<Shown | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>(() => defaultMapping(tool, columns));
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const batch = tool.mode === 'batch';
  const first = rows[0];
  const parameters = Object.keys(mapping);
  const mapped = parameters.every((p) => mapping[p]);
  const preview = commandLine(tool.command, batch || !first || !mapped ? tool.args : fillArgs(tool, columns, first, mapping));

  const run = () => {
    const runId = newId();
    const controller = new AbortController();
    abort.current = controller;
    setStage('running');
    const off = on('tools.progress', (data) => {
      const progress = data as { runId?: unknown; done?: unknown };
      if (progress.runId === runId && typeof progress.done === 'number') {
        setDone(progress.done);
      }
    });
    call<{ outcomes: ToolOutcome[] }>('tools.run', { runId, name: tool.name, columns: columns.map((c) => c.name), rows, mapping }, controller.signal)
      .then(
        (answer) => setOutcomes(answer.outcomes),
        (e: unknown) => setError({ text: errorText(e), reportId: reportIdOf(e) }),
      )
      .finally(() => {
        off();
        abort.current = null;
        setStage('done');
      });
  };

  const close = () => {
    if (stage !== 'running') {
      onClose();
    }
  };

  const transcript = outcomes
    .map((o) => {
      const text = o.output + o.error;
      return `$ ${commandLine(tool.command, o.args)}\n${text}${text && !text.endsWith('\n') ? '\n' : ''}${o.exitCode ? `[exit code ${o.exitCode}]\n` : ''}`;
    })
    .join('\n');

  return (
    <div className="fixed inset-0 z-20">
      <div className="scrim" onClick={close} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="card absolute top-[12%] left-1/2 flex max-h-[76vh] w-[640px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-3.5 p-5"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
      >
        <b id={`${id}-title`} className="text-[14px]">
          Run {tool.name}
        </b>
        {!batch && parameters.length > 0 && (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" disabled={stage !== 'confirm'}>
            <legend className="mb-2 p-0 text-[12.5px]">Choose the column for each parameter:</legend>
            {parameters.map((p) => (
              <label key={p} className="flex items-center gap-3 text-[12.5px]">
                <span className="mono w-[160px] shrink-0 truncate">{`{${p}}`}</span>
                <select
                  className="textbox min-w-0 flex-1"
                  value={mapping[p]}
                  aria-invalid={!mapping[p]}
                  onChange={(e) => setMapping({ ...mapping, [p]: e.target.value })}
                >
                  <option value="">Choose a column…</option>
                  {columns.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </fieldset>
        )}
        <span className="text-[12.5px]">
          {batch ? `Runs once, with ${rowCount(rows.length)} on stdin as JSON:` : `Runs once for each of ${rowCount(rows.length)}. The first:`}
        </span>
        <pre className="codeblock m-0 shrink-0 overflow-auto">{preview}</pre>
        {stage === 'running' && (
          <span role="status" className="text-[12.5px]">
            {batch ? 'Running…' : `Ran ${done} of ${rows.length}…`}
          </span>
        )}
        {error && (
          <span role="alert" className="text-[12px] text-bad">
            {error.text}
            <ErrorReportActions reportId={error.reportId} uiSections={{ message: error.text }} />
          </span>
        )}
        {transcript && (
          <pre className="codeblock m-0 min-h-0 flex-1 overflow-auto" tabIndex={0} aria-label="Output">
            {transcript}
          </pre>
        )}
        <div className="flex justify-end gap-2">
          {stage === 'confirm' && (
            <>
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn primary" autoFocus disabled={!batch && (rows.length === 0 || !mapped)} onClick={run}>
                Run
              </button>
            </>
          )}
          {stage === 'running' && (
            <button type="button" className="btn" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          )}
          {stage === 'done' && (
            <button type="button" className="btn primary" autoFocus onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
