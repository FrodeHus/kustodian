import { useEffect, useState } from 'react';
import { call } from '../bridge';
import { openSaved } from '../library/open-library';
import { MAX_NAME_LENGTH, useRevisions } from '../library/saving';
import { errorText } from '../shell/errors';
import { ErrorReportActions, type Shown } from '../shell/error-report';
import { reportIdOf } from '../shell/report-id';
import { MOD } from '../shell/keys';
import { SourceBadge, WorkbookIcon } from '../tabs/source-badge';
import { useTabs } from '../tabs/tab-store';
import type { LibraryList, SavedQuery, Source, WorkbookList, WorkbookSummary } from '../wire';
import { parseWorkbook } from '../workbooks/model';
import { PanelHeading } from './panel-heading';
import { ConfirmDelete, RowMenu } from './row-menu';

function skippedText(n: number): string {
  return n === 1 ? '1 saved query couldn’t be read and was moved aside.' : `${n} saved queries couldn’t be read and were moved aside.`;
}

/**
 * The Saved panel (spec 6.6): the library's folders as groups that fold, then the queries in no folder, with a search. It lists
 * the queries of the active tab's `source` (spec 6.1), or every source's with "All sources". A query opens on click; its menu
 * renames it or deletes it (after asking). The workbooks, of every source, follow in a "Workbooks" group: one opens in a
 * workbook tab on click, and its menu deletes it (after asking).
 */
export function SavedPanel({ source = 'graph' }: { source?: Source }) {
  const revision = useRevisions((s) => s.library);
  const [list, setList] = useState<LibraryList | null>(null);
  const [problem, setProblem] = useState<Shown | null>(null);
  const [search, setSearch] = useState('');
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [workbooks, setWorkbooks] = useState<WorkbookList | null>(null);
  const [workbooksFolded, setWorkbooksFolded] = useState(false);

  useEffect(() => {
    let live = true;
    call<LibraryList>('library.list').then(
      (l) => live && setList(l),
      (e: unknown) => live && setProblem({ text: `The saved queries couldn’t be read: ${errorText(e)}`, reportId: reportIdOf(e) }),
    );
    call<WorkbookList | null>('workbook.list').then(
      (l) => live && setWorkbooks(l),
      (e: unknown) => live && setProblem({ text: `The workbooks couldn’t be read: ${errorText(e)}`, reportId: reportIdOf(e) }),
    );
    return () => {
      live = false;
    };
  }, [revision]);

  const changed = () => useRevisions.getState().bump('library');

  const rename = (q: SavedQuery, name: string) => {
    setRenaming(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === q.name) {
      return;
    }
    const { id, folder, text, parameters, options } = q;
    call<SavedQuery>('library.save', { query: { id, name: trimmed, folder, source: q.source, text, parameters, options: options ?? null } }).then(
      (saved) => {
        const { tabs, setTitle } = useTabs.getState();
        tabs.filter((t) => t.savedId === saved.id).forEach((t) => setTitle(t.id, saved.name));
        setProblem(null);
        changed();
      },
      (e: unknown) => setProblem({ text: `It couldn’t be renamed: ${errorText(e)}`, reportId: reportIdOf(e) }),
    );
  };

  const remove = (q: SavedQuery) => {
    setDeleting(null);
    call('library.delete', { id: q.id }).then(
      () => {
        setProblem(null);
        changed();
      },
      (e: unknown) => setProblem({ text: `It couldn’t be deleted: ${errorText(e)}`, reportId: reportIdOf(e) }),
    );
  };

  const openWorkbook = (w: WorkbookSummary) => {
    call<{ workbook: unknown }>('workbook.get', { id: w.id }).then(
      ({ workbook }) => {
        const doc = workbook === null ? 'It no longer exists.' : parseWorkbook(workbook);
        if (typeof doc === 'string') {
          setProblem({ text: `${w.name} couldn’t be opened: ${doc}` });
        } else {
          useTabs.getState().openWorkbook(doc, { savedId: doc.id });
        }
      },
      (e: unknown) => setProblem({ text: `${w.name} couldn’t be opened: ${errorText(e)}`, reportId: reportIdOf(e) }),
    );
  };

  const removeWorkbook = (w: WorkbookSummary) => {
    setDeleting(null);
    call('workbook.delete', { id: w.id }).then(
      () => {
        setProblem(null);
        changed();
      },
      (e: unknown) => setProblem({ text: `It couldn’t be deleted: ${errorText(e)}`, reportId: reportIdOf(e) }),
    );
  };

  const needle = search.trim().toLowerCase();
  const queries = (list?.queries ?? []).filter((q) => (all || q.source === source) && (!needle || q.name.toLowerCase().includes(needle)));

  const row = (q: SavedQuery) => {
    if (deleting === q.id) {
      return (
        <li key={q.id}>
          <ConfirmDelete name={q.name} onDelete={() => remove(q)} onCancel={() => setDeleting(null)} />
        </li>
      );
    }
    if (renaming === q.id) {
      return (
        <li key={q.id} className="px-1.5 py-0.5">
          <input
            className="textbox h-[26px] w-full"
            aria-label={`New name for ${q.name}`}
            maxLength={MAX_NAME_LENGTH}
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onBlur={() => setRenaming(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                rename(q, newName);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setRenaming(null);
              }
            }}
          />
        </li>
      );
    }
    return (
      <li key={q.id} className="side-item">
        <button type="button" className="side-open" aria-label={q.name} title={q.text} onClick={() => openSaved(q)}>
          {all && <SourceBadge source={q.source} titled />}
          <span className="truncate">{q.name}</span>
        </button>
        <RowMenu
          name={q.name}
          actions={[
            {
              label: 'Rename',
              run: () => {
                setNewName(q.name);
                setRenaming(q.id);
              },
            },
            { label: 'Delete', run: () => setDeleting(q.id) },
          ]}
        />
      </li>
    );
  };

  const workbookRow = (w: WorkbookSummary) =>
    deleting === w.id ? (
      <li key={w.id}>
        <ConfirmDelete name={w.name} onDelete={() => removeWorkbook(w)} onCancel={() => setDeleting(null)} />
      </li>
    ) : (
      <li key={w.id} className="side-item">
        <button type="button" className="side-open" aria-label={w.name} onClick={() => openWorkbook(w)}>
          <WorkbookIcon />
          <span className="truncate">{w.name}</span>
        </button>
        <RowMenu name={w.name} actions={[{ label: 'Delete', run: () => setDeleting(w.id) }]} />
      </li>
    );
  const shownWorkbooks = (workbooks?.workbooks ?? []).filter((w) => !needle || w.name.toLowerCase().includes(needle));
  const workbooksOpen = needle !== '' || !workbooksFolded;

  const folders = (list?.folders ?? []).map((f) => ({ name: f, queries: queries.filter((q) => q.folder === f) })).filter((f) => f.queries.length > 0);
  const loose = queries.filter((q) => !q.folder || !list?.folders.includes(q.folder));

  return (
    <aside className="side" aria-label="Saved">
      <PanelHeading title="Saved" source={source} all={all} onAll={setAll} />
      <input
        className="search"
        type="search"
        aria-label="Find a saved query"
        placeholder="Find a saved query"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {problem && (
          <p role="alert" className="m-0 px-[14px] pb-2 text-[12px] text-bad">
            {problem.text}
            <ErrorReportActions reportId={problem.reportId} uiSections={{ message: problem.text }} />
          </p>
        )}
        {list && list.skipped > 0 && <p className="m-0 px-[14px] pb-2 text-[12px] text-warn">{skippedText(list.skipped)}</p>}
        {workbooks && workbooks.skipped > 0 && (
          <p className="m-0 px-[14px] pb-2 text-[12px] text-warn">
            {workbooks.skipped === 1 ? '1 workbook couldn’t be read and was moved aside.' : `${workbooks.skipped} workbooks couldn’t be read and were moved aside.`}
          </p>
        )}
        {list && queries.length === 0 && (
          <p className="faint m-0 px-[14px] text-[12px]">
            {needle ? 'No saved query matches.' : `Nothing saved yet. Save a query with ${MOD} S.`}
          </p>
        )}
        <ul className="side-list">
          {folders.map((f) => {
            // A search shows its matches in every folder.
            const open = needle !== '' || !folded[f.name];
            return (
              <li key={`folder:${f.name}`}>
                <button
                  type="button"
                  className="side-open folder"
                  aria-label={f.name}
                  aria-expanded={open}
                  onClick={() => setFolded((s) => ({ ...s, [f.name]: open }))}
                >
                  <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                  <span className="truncate">{f.name}</span>
                  <span className="ty" aria-hidden="true">
                    {f.queries.length}
                  </span>
                </button>
                {open && <ul className="side-list pl-3">{f.queries.map(row)}</ul>}
              </li>
            );
          })}
          {loose.map(row)}
          {shownWorkbooks.length > 0 && (
            <li>
              <button
                type="button"
                className="side-open folder"
                aria-label="Workbooks"
                aria-expanded={workbooksOpen}
                onClick={() => setWorkbooksFolded(workbooksOpen)}
              >
                <span aria-hidden="true">{workbooksOpen ? '▾' : '▸'}</span>
                <span className="truncate">Workbooks</span>
                <span className="ty" aria-hidden="true">
                  {shownWorkbooks.length}
                </span>
              </button>
              {workbooksOpen && <ul className="side-list pl-3">{shownWorkbooks.map(workbookRow)}</ul>}
            </li>
          )}
        </ul>
      </div>
    </aside>
  );
}
