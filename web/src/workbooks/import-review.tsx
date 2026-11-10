import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { errorText } from '../shell/errors';
import { ErrorReportActions, type Shown } from '../shell/error-report';
import { reportIdOf } from '../shell/report-id';
import { inSendDetails } from '../shell/send-details-marker';
import { SourceBadge } from '../tabs/source-badge';
import { importFolder, importSummary, matchTools, workspacesIn } from './import';
import { useAccountWorkspaces } from './account-workspaces';
import { WorkspaceRows } from './workspace-rows';
import { noQueriesAdded, openImported, saveImported, useImportReview, type PendingImport, type ReviewChoices } from './sharing';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The review a shared workbook file gets before anything is saved or run (spec §9.3, screen 7). */
export function ImportReview() {
  const pending = useImportReview((s) => s.pending);
  const shown = useImportReview((s) => s.shown);
  return pending && <Review key={shown} p={pending} />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <b className="text-[12.5px]">{title}</b>
      {children}
    </section>
  );
}

function Review({ p }: { p: PendingImport }) {
  const summary = importSummary(p.doc);
  const matches = matchTools(p.doc, p.tools);
  const myTools = p.tools?.tools.map((t) => t.name) ?? [];
  // A label can say something its tool doesn't do, so each one that differs is shown with its tool.
  const relabelled = [
    ...new Set(
      p.doc.widgets
        .flatMap((w) => w.tools ?? [])
        .filter((b) => b.label !== b.tool)
        .map((b) => `${b.label} → ${b.tool}`),
    ),
  ];
  // Kept across a failed Save, so a retry doesn't add the queries again.
  const added = useRef(noQueriesAdded());
  const [choices, setChoices] = useState<ReviewChoices>(() => ({
    addQueries: true,
    tools: Object.fromEntries(matches.map((m) => [m.tool, m.mine ? m.tool : null])),
    replace: false,
  }));
  const found = workspacesIn(p.doc);
  const mine = useAccountWorkspaces(found.length > 0);
  // Saving or opening names each workspace as the account does; the file's name stays where the list lacks it or wasn't read.
  const withMine = { ...choices, accountWorkspaces: mine };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Shown | null>(null);
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  const close = () => {
    closing.current = true;
    useImportReview.getState().close();
  };

  // A modal: focus that lands outside the dialog goes back to it.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (!closing.current && !inSendDetails(e.target) && (!(e.target instanceof Node) || !dialogRef.current?.contains(e.target))) {
        cancelRef.current?.focus();
      }
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  const save = () => {
    setBusy(true);
    setError(null);
    saveImported(p, withMine, added.current).then(close, (err: unknown) => {
      setBusy(false);
      setError({ text: errorText(err), reportId: reportIdOf(err) });
    });
  };
  const cancel = () => !busy && close();
  const setTool = (tool: string, mineName: string | null) => setChoices((c) => ({ ...c, tools: { ...c.tools, [tool]: mineName } }));
  const collision = p.existing !== null || p.openTabId !== null;

  return (
    <div className="fixed inset-0 z-20">
      <div className="scrim" onClick={cancel} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Open a shared workbook"
        className="card absolute top-[6vh] left-1/2 flex max-h-[88vh] w-[900px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-3 p-5"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault();
            cancel();
          }
        }}
      >
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col">
            <b className="text-[14px]">Open a shared workbook</b>
            <span className="truncate text-[12px] text-muted">{p.fileName}</span>
          </div>
          <button ref={cancelRef} type="button" className="btn ghost" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              openImported(p, withMine);
              close();
            }}
          >
            Open without saving
          </button>
          <button type="button" className="btn primary" autoFocus disabled={busy} onClick={save}>
            Save to my workbooks
          </button>
        </div>
        {error && (
          <span role="alert" className="text-[12px] text-bad">
            {error.text}
            <ErrorReportActions reportId={error.reportId} uiSections={{ message: error.text }} />
          </span>
        )}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
          <div className="flex min-h-0 flex-col gap-4 overflow-auto text-[12.5px]">
            <Section title="What's in it">
              <span className="flex flex-wrap items-center gap-1.5">
                {count(summary.widgets, 'widget', 'widgets')} · {count(summary.parameters, 'workbook parameter', 'workbook parameters')}
                {summary.sources.length > 0 && ' ·'}
                {summary.sources.map((s) => (
                  <SourceBadge key={s} source={s} titled />
                ))}
              </span>
              <span className="text-muted">
                Queries, layout, parameters and button settings only. A workbook file never holds results or tokens.
              </span>
            </Section>
            <WorkspaceRows found={found} mine={mine} />
            {summary.linked > 0 && (
              <Section title="Saved queries">
                <span>
                  ✓ {summary.linked === 1 ? '1 widget uses' : `${summary.linked} widgets use`} saved queries from the sender's library. The
                  file carries their text.
                </span>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={choices.addQueries}
                    onChange={(e) => setChoices((c) => ({ ...c, addQueries: e.target.checked }))}
                  />
                  Add them to my saved queries, under {importFolder(p.doc.name)}, and keep the widgets linked
                </label>
                <span className="text-muted">
                  Turned off, the queries are copied into the widgets instead. Open without saving always copies them.
                </span>
              </Section>
            )}
            {matches.length > 0 && (
              <Section title="Tool buttons">
                <span className="text-muted">
                  A shared workbook never carries commands. Each button runs one of the tools in your own tools.json, matched by name.
                </span>
                {(p.tools === null || p.tools.problem) && (
                  <span className="text-bad">{p.tools?.problem ?? 'Your tools couldn’t be read.'}</span>
                )}
                {matches.map((m) =>
                  m.mine ? (
                    <span key={m.tool}>
                      ✓ {m.tool} matches your “{m.tool}”
                    </span>
                  ) : (
                    <span key={m.tool} className="flex items-center gap-2">
                      ! {m.tool}
                      <select
                        className="textbox"
                        aria-label={`Tool for ${m.tool}`}
                        value={choices.tools[m.tool] ?? ''}
                        onChange={(e) => setTool(m.tool, e.target.value || null)}
                      >
                        <option value="">Leave this button off</option>
                        <optgroup label="Choose one of my tools…">
                          {myTools.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </optgroup>
                      </select>
                    </span>
                  ),
                )}
                {relabelled.map((r) => (
                  <span key={r}>Button: {r}</span>
                ))}
              </Section>
            )}
            {p.doc.parameters.length > 0 && (
              <Section title="Parameter values">
                {p.doc.parameters.map((q) => {
                  const value =
                    q.type === 'list'
                      ? q.value
                          .split(/\r?\n/)
                          .filter((l) => l.trim() !== '')
                          .join(', ')
                      : q.value;
                  return <span key={q.name}>{`${q.label ?? q.name}: ${value || 'no default'}`}</span>;
                })}
              </Section>
            )}
            {collision && (
              <Section title="Already in my workbooks">
                <span>{p.existing ? `You already have “${p.existing.name}” with this id.` : 'It’s already open in a tab.'}</span>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name={`${id}-replace`}
                    checked={!choices.replace}
                    onChange={() => setChoices((c) => ({ ...c, replace: false }))}
                  />
                  Keep both: the import gets a new id
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name={`${id}-replace`}
                    checked={choices.replace}
                    disabled={p.openTabId !== null}
                    onChange={() => setChoices((c) => ({ ...c, replace: true }))}
                  />
                  Replace it
                </label>
                {p.openTabId !== null && <span className="text-muted">It’s open in a tab. Close it to replace it.</span>}
              </Section>
            )}
          </div>
          <div className="flex min-h-0 flex-col gap-1.5">
            <b className="text-[12.5px]">The file</b>
            <pre className="codeblock m-0 min-h-0 flex-1 overflow-auto">{p.text}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}
