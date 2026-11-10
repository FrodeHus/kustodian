import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { call } from '../bridge';
import { useRevisions } from '../library/saving';
import { errorText } from '../shell/errors';
import { ErrorReportActions, type Shown } from '../shell/error-report';
import { reportIdOf } from '../shell/report-id';
import { inSendDetails } from '../shell/send-details-marker';
import type { SolutionDetails } from '../wire';
import { importFolder, readWorkbookFile, workspacesIn } from '../workbooks/import';
import { newWorkbook } from '../workbooks/model';
import { WorkspaceRows } from '../workbooks/workspace-rows';
import { useSolutionDialog } from './solution-store';
import { SupportBadge } from './solutions-panel';

// Lazy, as workbooks load it: react-markdown stays out of the startup chunk.
const MarkdownWidget = lazy(() => import('../workbooks/widgets/markdown-widget').then((m) => ({ default: m.MarkdownWidget })));

/** A solution's dialog (mockup Solutions), mounted once: its README, what it installs, and Install or Uninstall. */
export function SolutionDialog() {
  const id = useSolutionDialog((s) => s.id);
  const compatible = useSolutionDialog((s) => s.compatible);
  return id && <Dialog key={id} id={id} compatible={compatible} />;
}

function Dialog({ id, compatible }: { id: string; compatible: boolean }) {
  const [details, setDetails] = useState<SolutionDetails | null>(null);
  const [skip, setSkip] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Shown | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  // Read before Cancel's autoFocus moves focus, which happens before any effect runs.
  const [before] = useState(() => document.activeElement);
  const close = () => {
    closing.current = true;
    useSolutionDialog.getState().close();
  };

  useEffect(() => {
    let live = true;
    call<SolutionDetails>('solution.get', { id }).then(
      (d) => {
        if (live) {
          setDetails(d);
        }
      },
      (e: unknown) => live && setError({ text: `The solution couldn’t be read: ${errorText(e)}`, reportId: reportIdOf(e) }),
    );
    return () => {
      live = false;
    };
  }, [id]);

  // A modal: focus that lands outside the dialog goes back to it; closed, focus returns to where it was.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (!closing.current && !inSendDetails(e.target) && (!(e.target instanceof Node) || !dialogRef.current?.contains(e.target))) {
        cancelRef.current?.focus();
      }
    };
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      if (before instanceof HTMLElement) {
        before.focus();
      }
    };
  }, [before]);

  const run = (method: string, params: object) => {
    setBusy(true);
    setError(null);
    call(method, params).then(
      () => {
        useRevisions.getState().bump('library');
        close();
      },
      (e: unknown) => {
        setBusy(false);
        setError({ text: errorText(e), reportId: reportIdOf(e) });
      },
    );
  };
  const cancel = () => !busy && close();
  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (!next.delete(key)) {
      next.add(key);
    }
    return next;
  };

  const m = details?.manifest;
  const installed = details?.installed ?? null;
  // The host never deletes an item changed since install; they are listed so the user knows, and sent as keep.
  const changed = installed?.items.filter((i) => details?.modified.includes(i.libraryId)) ?? [];
  const items = m ? [...m.content.queries.map((i) => ({ kind: 'query' as const, id: i })), ...m.content.workbooks.map((i) => ({ kind: 'workbook' as const, id: i }))] : [];
  const folder = m ? importFolder(m.name) : '';
  const workspaces = workspacesIn({
    ...newWorkbook(''),
    widgets: // readWorkbookFile keeps only known fields, so a crafted file can't break the list.
    (details?.workbooks ?? []).flatMap((w) => {
      const doc = readWorkbookFile(JSON.stringify(w));
      return typeof doc === 'string' ? [] : doc.widgets;
    }),
  });

  return (
    <div className="fixed inset-0 z-20">
      <div className="scrim" onClick={cancel} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={m?.name ?? 'Solution'}
        className="card absolute top-[8vh] left-1/2 flex max-h-[84vh] w-[1044px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault();
            cancel();
          }
        }}
      >
        <div className="flex items-start gap-3 border-b border-line px-5 pt-[18px] pb-3.5">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <b className="text-[17px] leading-[22px]">{m?.name ?? id}</b>
              {m && <SupportBadge support={m.support} />}
              {m && <span className="text-[12px] text-faint">{`${m.solutionVersion} · ${m.author}`}</span>}
            </div>
            {m && <span className="text-[12.5px] text-muted">{m.description}</span>}
          </div>
          <button type="button" className="btn ghost" aria-label="Close" disabled={busy} onClick={close}>
            ×
          </button>
        </div>
        {error && (
          <span role="alert" className="px-5 pt-3 text-[12px] text-bad">
            {error.text}
            <ErrorReportActions reportId={error.reportId} uiSections={{ message: error.text }} />
          </span>
        )}
        {details && m && (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px]">
            <div className="flex min-h-0 flex-col overflow-auto border-r border-line py-3.5 text-[13px] leading-5 text-muted [&_:is(h1,h2,h3,h4)]:mt-0 [&_:is(h1,h2,h3,h4)]:mb-1.5 [&_:is(h1,h2,h3,h4)]:text-[14px] [&_:is(h1,h2,h3,h4)]:font-semibold [&_:is(h1,h2,h3,h4)]:text-text [&_p]:mt-0 [&_p]:mb-2.5">
              {details.readme === '' && installed ? (
                <p className="m-0 px-3">Kustodian couldn’t load the README.</p>
              ) : (
                <Suspense fallback={null}>
                  <MarkdownWidget text={details.readme} values={{}} />
                </Suspense>
              )}
            </div>
            <div className="flex min-h-0 flex-col gap-4 overflow-auto px-[18px] py-4 text-[12.5px]">
              {m.support !== 'kustodian' && (
                <p className="m-0 rounded-lg bg-warn-soft px-3 py-2 text-[12px] text-warn">Not maintained by Kustodian. Review before running.</p>
              )}
              {installed ? (
                <section className="flex flex-col gap-1">
                  <b className="text-[11px] tracking-[0.08em] text-faint uppercase">{`Installed into “${folder}”`}</b>
                  {installed.items.map((i) => (
                    <span key={i.libraryId} className="flex h-7 items-center gap-2">
                      <span className="truncate">{i.itemId}</span>
                      <span className="ml-auto text-[11px] text-faint">{i.kind}</span>
                    </span>
                  ))}
                  {changed.length > 0 && (
                    <>
                      <span className="mt-2 text-[12px] text-muted">These stay in Saved as your own.</span>
                      <ul className="m-0 list-none p-0">
                        {changed.map((i) => (
                          <li key={i.libraryId} className="flex h-7 items-center gap-2">
                            <span className="truncate">{i.itemId}</span>
                            <span className="ml-auto text-[11px] text-faint">{i.kind}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </section>
              ) : (
                <>
                  <section className="flex flex-col">
                    <b className="mb-1.5 text-[11px] tracking-[0.08em] text-faint uppercase">{`Installs into “${folder}”`}</b>
                    {items.map((i) => (
                      <label key={`${i.kind}:${i.id}`} className="flex h-7 items-center gap-2">
                        <input type="checkbox" checked={!skip.has(i.id)} onChange={() => setSkip((s) => toggle(s, i.id))} />
                        <span className="truncate">{i.id}</span>
                        <span className="ml-auto text-[11px] text-faint">{i.kind}</span>
                      </label>
                    ))}
                  </section>
                  <WorkspaceRows found={workspaces} />
                  <p className="m-0 rounded-lg bg-panel2 px-3 py-2 text-[12px] text-muted">
                    Nothing runs on install. Queries and the workbook run when you open them.
                  </p>
                </>
              )}
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 border-t border-line px-5 py-3">
          <span className="flex-1 text-[12px] text-faint">
            {installed
              ? `Installed ${installed.solutionVersion}`
              : !compatible && m
                ? `Needs Kustodian ${m.minAppVersion}`
                : details && `${items.filter((i) => !skip.has(i.id)).length} of ${items.length} items`}
          </span>
          <button ref={cancelRef} type="button" className="btn ghost" autoFocus disabled={busy} onClick={close}>
            Cancel
          </button>
          {installed ? (
            <button type="button" className="btn" disabled={busy} onClick={() => run('solution.uninstall', { id, keep: details?.modified ?? [] })}>
              Uninstall
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={busy || !details || !compatible || items.every((i) => skip.has(i.id))}
              onClick={() => run('solution.install', { id, skip: [...skip] })}
            >
              Install
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
