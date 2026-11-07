import { useEffect, useId, useState } from 'react';
import { call } from '../bridge';
import { errorText } from '../shell/errors';
import { ErrorReportActions, type Shown } from '../shell/error-report';
import { reportIdOf } from '../shell/report-id';
import { ConfirmDelete } from '../side/row-menu';
import { commandLine, toolColumns } from '../results/tool-args';
import type { ExternalTool, ToolList } from '../wire';

const MODES: { value: ExternalTool['mode']; name: string }[] = [
  { value: 'each', name: 'Once per row' },
  { value: 'batch', name: 'Once, rows as JSON on stdin' },
];

const blank: ExternalTool = { name: '', command: '', args: [], mode: 'each' };

/** Which tool the dialog edits: its place in the list, or null for a new one. */
interface Editing {
  at: number | null;
  tool: ExternalTool;
}

/**
 * The Settings card for the Run tool menu's tools, in its order: add, edit, duplicate, move and delete them. Each change is
 * written to `tools.json` at once, and the host checks it. While `tools.json` can't be read the card shows why and changes
 * nothing, so the file the user wrote stays as it is.
 */
export function ExternalTools() {
  const [list, setList] = useState<ToolList | null>(null);
  const [error, setError] = useState<Shown | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = () =>
    call<ToolList>('tools.list').then(
      (answer) => {
        setError(null);
        setList(answer);
      },
      (e: unknown) => setError({ text: `The tools couldn’t be read: ${errorText(e)}`, reportId: reportIdOf(e) }),
    );
  useEffect(() => void load(), []);

  /** Writes the whole list; the dialog shows a refusal itself. */
  const save = (tools: ExternalTool[]) =>
    call<ToolList>('tools.save', { tools }).then((answer) => {
      setError(null);
      setList(answer);
    });
  const change = (tools: ExternalTool[]) =>
    void save(tools).catch((e: unknown) => setError({ text: `The tools couldn’t be saved: ${errorText(e)}`, reportId: reportIdOf(e) }));

  const openFile = () => void call('tools.edit').catch((e: unknown) => setError({ text: errorText(e), reportId: reportIdOf(e) }));

  const tools = list?.tools ?? [];
  const move = (at: number, by: number) => {
    const next = [...tools];
    const [tool] = next.splice(at, 1);
    next.splice(at + by, 0, tool as ExternalTool);
    change(next);
  };
  const copyName = (name: string) => {
    let n = 1;
    const taken = new Set(tools.map((t) => t.name));
    while (taken.has(`${name} copy${n > 1 ? ` ${n}` : ''}`)) {
      n++;
    }
    return `${name} copy${n > 1 ? ` ${n}` : ''}`;
  };

  return (
    <>
      <div className="flex items-start gap-3">
        <span className="muted flex-1 text-[12px]">
          Commands of your own that the Rows tab’s Run tool menu runs on the selected rows, in this order. Changes are saved to tools.json at once.
        </span>
        <button type="button" className="btn ghost" onClick={openFile}>
          Open tools.json
        </button>
        <button type="button" className="btn primary" disabled={!list || list.problem !== null} onClick={() => setEditing({ at: null, tool: blank })}>
          Add tool
        </button>
      </div>
      {list?.problem && (
        <div className="card flex flex-col items-start gap-2 border-warn bg-warn-soft p-3 text-[12.5px]" role="note">
          <span>tools.json couldn’t be read, so the Run tool menu has no tools. Nothing here changes it until it’s fixed.</span>
          <span className="mono faint text-[11px]">{list.problem}</span>
          <div className="flex gap-2">
            <button type="button" className="btn" onClick={openFile}>
              Open tools.json
            </button>
            <button type="button" className="btn" onClick={() => void load()}>
              Read it again
            </button>
          </div>
        </div>
      )}
      {list && !list.problem && tools.length === 0 && <span className="faint text-[12px]">No tools yet.</span>}
      {tools.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0" aria-label="Tools">
          {tools.map((tool, at) => {
            const parameters = toolColumns(tool);
            return (
              <li key={tool.name} className="flex flex-col gap-1.5 border-t border-line py-2.5">
                <div className="flex items-start gap-3">
                  <div className="flex flex-col">
                    <button type="button" className="btn ghost h-4 px-1 text-[10px]" aria-label={`Move ${tool.name} up`} disabled={at === 0} onClick={() => move(at, -1)}>
                      ▲
                    </button>
                    <button
                      type="button"
                      className="btn ghost h-4 px-1 text-[10px]"
                      aria-label={`Move ${tool.name} down`}
                      disabled={at === tools.length - 1}
                      onClick={() => move(at, 1)}
                    >
                      ▼
                    </button>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                    <div className="flex max-w-full items-center gap-2">
                      <b className="truncate text-[13px]">{tool.name}</b>
                      <span className="chip shrink-0">{tool.mode === 'batch' ? 'Batch' : 'Each row'}</span>
                    </div>
                    <span className="mono muted text-[11.5px] break-all">{commandLine(tool.command, tool.args)}</span>
                    {parameters.length > 0 && <span className="mono text-[11px] text-accent">{parameters.map((p) => `{${p}}`).join(' ')}</span>}
                    {list?.missing.includes(tool.name) && <span className="chip warn">No file at “{tool.command}”: give the full path</span>}
                  </div>
                  <button type="button" className="btn" onClick={() => setEditing({ at, tool })}>
                    Edit…
                  </button>
                  <button type="button" className="btn ghost" aria-label={`Duplicate ${tool.name}`} onClick={() => change([...tools.slice(0, at + 1), { ...tool, name: copyName(tool.name) }, ...tools.slice(at + 1)])}>
                    Duplicate
                  </button>
                  <button type="button" className="btn ghost text-bad" aria-label={`Delete ${tool.name}`} onClick={() => setDeleting(tool.name)}>
                    Delete
                  </button>
                </div>
                {deleting === tool.name && (
                  <ConfirmDelete
                    name={tool.name}
                    onCancel={() => setDeleting(null)}
                    onDelete={() => {
                      setDeleting(null);
                      change(tools.filter((t) => t.name !== tool.name));
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <span className="text-[12px] text-bad" role="alert">
          {error.text}
          <ErrorReportActions reportId={error.reportId} uiSections={{ message: error.text }} />
        </span>
      )}
      {list && (
        <div className="flex items-center gap-3 border-t border-line pt-2.5">
          <span className="mono faint min-w-0 flex-1 truncate text-[11px]">{list.path}</span>
          <span className="faint text-[12px]">Commands start directly, never through a shell, in your home folder.</span>
        </div>
      )}
      {editing && (
        <ToolDialog
          tool={editing.tool}
          taken={tools.filter((_, i) => i !== editing.at).map((t) => t.name)}
          onClose={() => setEditing(null)}
          onSave={(tool) =>
            save(editing.at === null ? [...tools, tool] : tools.map((t, i) => (i === editing.at ? tool : t))).then(() => setEditing(null))
          }
        />
      )}
    </>
  );
}

/** What is wrong with the tool as the dialog has it, worded as the host words it; null when nothing is. */
function toolProblem(tool: ExternalTool, taken: string[]): string | null {
  if (!tool.name.trim()) {
    return 'The tool needs a name.';
  }
  if (taken.includes(tool.name)) {
    return `There is already a tool named ${tool.name}.`;
  }
  if (!tool.command.trim()) {
    return `${tool.name} needs a command.`;
  }
  if (tool.mode === 'batch' && toolColumns(tool).length > 0) {
    return `${tool.name} runs in batch mode, which sends the rows on stdin, so its arguments can’t name columns.`;
  }
  return null;
}

interface ToolDialogProps {
  tool: ExternalTool;
  /** The other tools' names, which this one can't take. */
  taken: string[];
  onClose: () => void;
  /** Saves the tool; a refusal (rejected) leaves the dialog open with the host's message. */
  onSave: (tool: ExternalTool) => Promise<void>;
}

/** Adds or edits a tool: one box per argument, as the command gets them, never split on spaces. */
function ToolDialog({ tool: initial, taken, onClose, onSave }: ToolDialogProps) {
  const id = useId();
  const [tool, setTool] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const edit = (change: Partial<ExternalTool>) => setTool((t) => ({ ...t, ...change }));
  const args = tool.args;
  const parameters = toolColumns(tool);
  const problem = toolProblem({ ...tool, name: tool.name.trim(), command: tool.command.trim() }, taken);
  // Shown once the name is filled in, so a new tool doesn't open on an error.
  const shown = tool.name.trim() ? problem : null;

  const browse = () =>
    call<{ path: string } | null>('tools.pickCommand').then(
      (answer) => answer && edit({ command: answer.path }),
      (e: unknown) => setRefused(errorText(e)),
    );

  const save = () => {
    setBusy(true);
    setRefused(null);
    onSave({ ...tool, name: tool.name.trim(), command: tool.command.trim() })
      .catch((e: unknown) => setRefused(errorText(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="fixed inset-0 z-20">
      <div className="scrim" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="card absolute top-[8%] left-1/2 flex max-h-[84vh] w-[720px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-4 overflow-auto p-5"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // Settings closes on Escape too: only the dialog does.
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <b id={`${id}-title`} className="text-[16px]">
          {initial.name ? 'Edit tool' : 'Add tool'}
        </b>
        <div className="field">
          <label htmlFor={`${id}-name`}>Name</label>
          <input id={`${id}-name`} className="textbox" autoFocus value={tool.name} onChange={(e) => edit({ name: e.target.value })} />
          <span className="faint text-[12px]">As the Run tool menu shows it.</span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-command`}>Command</label>
          <div className="flex gap-2">
            <input
              id={`${id}-command`}
              className="textbox mono min-w-0 flex-1 text-[12px]"
              spellCheck={false}
              placeholder="/opt/homebrew/bin/az"
              value={tool.command}
              onChange={(e) => edit({ command: e.target.value })}
            />
            <button type="button" className="btn h-8" onClick={() => void browse()}>
              Browse…
            </button>
          </div>
          <span className="faint text-[12px]">A full path: an app started from the Finder or the Start menu doesn’t get your shell’s PATH.</span>
        </div>
        <fieldset className="field m-0 border-0 p-0">
          <legend className="mb-1.5 p-0 text-[12px] font-semibold text-muted">Runs</legend>
          <div className="flex gap-4">
            {MODES.map((m) => (
              <label key={m.value} className="flex items-center gap-2 text-[12.5px]">
                <input type="radio" name={`${id}-mode`} checked={tool.mode === m.value} onChange={() => edit({ mode: m.value })} />
                {m.name}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="field m-0 border-0 p-0">
          <legend className="mb-1.5 p-0 text-[12px] font-semibold text-muted">Arguments</legend>
          <span className="faint text-[12px]">
            Each box is exactly one argument, never split on spaces.{' '}
            {tool.mode === 'each' ? (
              <>
                <span className="mono">{'{name}'}</span> becomes that row’s value in the column mapped to it.
              </>
            ) : (
              'A batch tool gets the rows on stdin, so its arguments can’t name columns.'
            )}
          </span>
          {args.map((arg, at) => (
            <div key={at} className="flex items-center gap-2">
              <span className="faint mono w-5 text-right text-[11px]">{at + 1}</span>
              <input
                className="textbox mono min-w-0 flex-1 text-[12px]"
                spellCheck={false}
                aria-label={`Argument ${at + 1}`}
                value={arg}
                onChange={(e) => edit({ args: args.map((a, i) => (i === at ? e.target.value : a)) })}
              />
              <button type="button" className="btn ghost" aria-label={`Remove argument ${at + 1}`} onClick={() => edit({ args: args.filter((_, i) => i !== at) })}>
                ×
              </button>
            </div>
          ))}
          <div>
            <button type="button" className="btn" onClick={() => edit({ args: [...args, ''] })}>
              Add argument
            </button>
          </div>
        </fieldset>
        {tool.mode === 'each' && parameters.length > 0 && (
          <span className="text-[12.5px]">
            Parameters: <span className="mono text-accent">{parameters.map((p) => `{${p}}`).join(' ')}</span>
            <span className="faint"> · each is mapped to a result column when the tool runs.</span>
          </span>
        )}
        {tool.command.trim() && (
          <div className="field">
            <span className="text-[12px] font-semibold text-muted">Command line</span>
            <pre className="codeblock m-0 overflow-auto whitespace-pre-wrap">{commandLine(tool.command.trim(), args)}</pre>
          </div>
        )}
        {(shown ?? refused) && (
          <span className="text-[12px] text-bad" role="alert">
            {shown ?? refused}
          </span>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy || problem !== null} onClick={save}>
            Save tool
          </button>
        </div>
      </div>
    </div>
  );
}
