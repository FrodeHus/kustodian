import { useEffect, useId, useRef, useState } from 'react';
import { call } from '../bridge';
import { MAX_FOLDER_LENGTH, MAX_NAME_LENGTH } from '../library/saving';
import { errorText } from '../shell/errors';
import { ErrorReportActions, type Shown } from '../shell/error-report';
import { reportIdOf } from '../shell/report-id';
import { inSendDetails } from '../shell/send-details-marker';
import type { Tab } from '../tabs/tab-store';
import { useTabs } from '../tabs/tab-store';
import type { WorkbookList, WorkbookSummary } from '../wire';
import { defaultKind, linksSaved, widgetFromTab, type AddKind } from './add-to-workbook';
import { applyAdd } from './apply-add';
import { MAX_WIDGETS } from './model';

const KINDS: { kind: AddKind; name: string }[] = [
  { kind: 'table', name: 'Table' },
  { kind: 'chart', name: 'Chart' },
  { kind: 'stat', name: 'Stat' },
];
const NEW = '';
// The list's widget count, so no workbook is read to know.
const full = (w: WorkbookSummary) => w.widgets >= MAX_WIDGETS;

/**
 * Adds a query tab's query to a workbook, an existing one or a new one, as a Table, Chart or Stat widget. `onNotice` gets what
 * the add has to say once it's done (it went into unsaved changes). A failure shows in the dialog, which stays open.
 */
export function AddToWorkbookDialog({ tab, onClose, onNotice }: { tab: Tab; onClose: () => void; onNotice?: (text: string) => void }) {
  const view = useTabs((s) => s.resultViews[tab.id]);
  const [list, setList] = useState<WorkbookList | null>(null);
  const [search, setSearch] = useState('');
  // A workbook's id, or NEW.
  const [chosen, setChosen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [kind, setKind] = useState<AddKind>(() => (tab.run?.result ? defaultKind(tab.run.result, view?.view) : 'table'));
  const [title, setTitle] = useState(tab.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Shown | null>(null);
  const id = useId();
  const dialogRef = useRef<HTMLFormElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const opener = useRef(document.activeElement);
  const closing = useRef(false);
  const close = (restore: boolean) => {
    closing.current = true;
    if (restore && opener.current instanceof HTMLElement) {
      opener.current.focus();
    }
    onClose();
  };

  // A modal: focus that lands outside the dialog goes back to its search box.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (!closing.current && !inSendDetails(e.target) && (!(e.target instanceof Node) || !dialogRef.current?.contains(e.target))) {
        searchRef.current?.focus();
      }
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  useEffect(() => {
    let live = true;
    call<WorkbookList>('workbook.list').then(
      (l) => {
        if (live) {
          setList(l);
          setChosen((c) => c ?? l.workbooks.find((w) => !full(w))?.id ?? NEW);
        }
      },
      (e: unknown) => {
        if (live) {
          // A new workbook can still be made.
          setList({ workbooks: [], folders: [], skipped: 0 });
          setChosen(NEW);
          setError({ text: `The workbooks couldn’t be read: ${errorText(e)}`, reportId: reportIdOf(e) });
        }
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const needle = search.trim().toLowerCase();
  const shown = (list?.workbooks ?? [])
    .filter((w) => !needle || w.name.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));
  const groups = [null, ...new Set(shown.map((w) => w.folder).filter((f): f is string => !!f))]
    .sort((a, b) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)))
    .map((f) => ({ folder: f, workbooks: shown.filter((w) => (w.folder || null) === f) }))
    .filter((g) => g.workbooks.length > 0);
  const existing = list?.workbooks.find((w) => w.id === chosen);
  const ready = chosen === NEW ? !!name.trim() : !!existing && !full(existing);

  const radio = (w: WorkbookSummary) => (
    <label key={w.id} className="flex min-h-[32px] items-center gap-2.5 px-1.5" title={full(w) ? 'This workbook is full' : undefined}>
      <input type="radio" name={`${id}-workbook`} disabled={full(w)} checked={chosen === w.id} onChange={() => setChosen(w.id)} />
      <span className={`truncate ${full(w) ? 'faint' : ''}`}>{w.name}</span>
    </label>
  );

  return (
    <div className="fixed inset-0 z-20">
      <div className="scrim" onClick={() => close(true)} />
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="card absolute top-[12%] left-1/2 flex max-h-[80vh] w-[480px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-3.5 overflow-y-auto p-5"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close(true);
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready || busy) {
            return;
          }
          const target =
            chosen === NEW
              ? { kind: 'new' as const, name: name.trim(), folder: folder.trim() || null }
              : { kind: 'existing' as const, id: existing!.id, name: existing!.name };
          setBusy(true);
          setError(null);
          closing.current = true;
          applyAdd(target, widgetFromTab(tab, kind, title.trim(), view?.chart), tab.parameters).then(
            ({ notice }) => {
              if (notice) {
                onNotice?.(notice);
              }
              close(false);
            },
            (err: unknown) => {
              closing.current = false;
              setBusy(false);
              setError({ text: `The query couldn’t be added: ${errorText(err)}`, reportId: reportIdOf(err) });
            },
          );
        }}
      >
        <b id={`${id}-title`} className="text-[14px]">
          Add to workbook
        </b>
        <fieldset className="field m-0 min-w-0 border-0 p-0">
          <legend className="mb-1.5 p-0 text-[12px] font-semibold text-muted">Workbook</legend>
          <input
            ref={searchRef}
            className="search !m-0 !w-full"
            type="search"
            aria-label="Find a workbook"
            placeholder="Find a workbook"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div role="radiogroup" aria-label="Workbook" className="max-h-[220px] overflow-y-auto">
            {!list && <span className="faint text-[12px]">Reading the workbooks…</span>}
            {groups.map((g) =>
              g.folder === null ? (
                g.workbooks.map(radio)
              ) : (
                <div key={g.folder} role="group" aria-labelledby={`${id}-f-${g.folder}`}>
                  <span id={`${id}-f-${g.folder}`} className="faint block px-1.5 pt-1.5 text-[11.5px]">
                    {g.folder}
                  </span>
                  {g.workbooks.map(radio)}
                </div>
              ),
            )}
            {list && needle && shown.length === 0 && <span className="faint block px-1.5 text-[12px]">No workbook matches.</span>}
            <label className="flex min-h-[32px] items-center gap-2.5 px-1.5">
              <input type="radio" name={`${id}-workbook`} checked={chosen === NEW} onChange={() => setChosen(NEW)} />
              New workbook
            </label>
          </div>
          {chosen === NEW && (
            <div className="flex gap-2">
              <div className="field min-w-0 flex-1">
                <label htmlFor={`${id}-name`}>Name</label>
                <input
                  id={`${id}-name`}
                  className="textbox"
                  maxLength={MAX_NAME_LENGTH}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="field min-w-0 flex-1">
                <label htmlFor={`${id}-folder`}>Folder</label>
                <input
                  id={`${id}-folder`}
                  className="textbox"
                  list={`${id}-folders`}
                  maxLength={MAX_FOLDER_LENGTH}
                  placeholder="No folder"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                />
                <datalist id={`${id}-folders`}>
                  {(list?.folders ?? []).map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
              </div>
            </div>
          )}
        </fieldset>
        <fieldset className="field m-0 border-0 p-0">
          <legend className="mb-1.5 p-0 text-[12px] font-semibold text-muted">Widget</legend>
          <div className="flex gap-4">
            {KINDS.map((k) => (
              <label key={k.kind} className="flex items-center gap-2 text-[12.5px]">
                <input type="radio" name={`${id}-kind`} checked={kind === k.kind} onChange={() => setKind(k.kind)} />
                {k.name}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor={`${id}-title-field`}>Title</label>
          <input id={`${id}-title-field`} className="textbox" value={title} onChange={(e) => setTitle(e.target.value)} />
          {!linksSaved(tab) && <span className="faint text-[12px]">Save the query first to link it.</span>}
        </div>
        {error && (
          <span role="alert" className="text-[12px] text-bad">
            {error.text}
            <ErrorReportActions reportId={error.reportId} uiSections={{ message: error.text }} />
          </span>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn ghost" onClick={() => close(true)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !ready}>
            Add
          </button>
        </div>
      </form>
    </div>
  );
}
