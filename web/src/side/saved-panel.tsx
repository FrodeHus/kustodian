import { useEffect, useState, type ReactNode } from 'react';
import { call } from '../bridge';
import { openSaved } from '../library/open-library';
import { MAX_NAME_LENGTH, useRevisions } from '../library/saving';
import { errorText } from '../shell/errors';
import { ErrorReportActions, type Shown } from '../shell/error-report';
import { reportIdOf } from '../shell/report-id';
import { MOD } from '../shell/keys';
import { SourceBadge } from '../tabs/source-badge';
import { useTabs } from '../tabs/tab-store';
import type { LibraryList, Pins, SavedQuery, Source, WorkbookList, WorkbookSummary } from '../wire';
import { parseWorkbook } from '../workbooks/model';
import { importWorkbook } from '../workbooks/sharing';
import { useWorkbooks } from '../workbooks/workbook-store';
import { PanelHeading } from './panel-heading';
import { ConfirmDelete, RowMenu } from './row-menu';

function skippedText(n: number): string {
  return n === 1 ? '1 saved query couldn’t be read and was moved aside.' : `${n} saved queries couldn’t be read and were moved aside.`;
}

const LIST_FAILED = 'The saved queries couldn’t be read';
const WORKBOOKS_FAILED = 'The workbooks couldn’t be read';
const NO_PINS: Pins = { queries: [], workbooks: [] };

const prefixOf = (name: string) => {
  const i = name.indexOf(' / ');
  return i > 0 ? name.slice(0, i) : null;
};

/** Queries whose names share a "Prefix / " with another query become a group of that prefix; the rest stay as they are. */
function byPrefix(queries: SavedQuery[]): { groups: [string, SavedQuery[]][]; rest: SavedQuery[] } {
  const groups = new Map<string, SavedQuery[]>();
  for (const q of queries) {
    const p = prefixOf(q.name);
    if (p !== null) {
      groups.set(p, [...(groups.get(p) ?? []), q]);
    }
  }
  const shared = [...groups].filter(([, qs]) => qs.length > 1);
  const grouped = new Set(shared.flatMap(([, qs]) => qs));
  return { groups: shared, rest: queries.filter((q) => !grouped.has(q)) };
}

/**
 * The Saved panel (spec 6.6), in two tabs, Queries and Workbooks, each with a search. Queries: the library's folders as
 * groups that fold, then the queries in no folder; queries named "Prefix / name" that share a prefix fold under it. It lists
 * the queries of the active tab's `source` (spec 6.1), or every source's with "All sources". A query opens on click; its menu
 * pins it, renames it or deletes it (after asking). Workbooks, of every source, in their folders: one opens in a workbook tab on
 * click, and its menu pins it or deletes it (after asking). Pinned items, in the order they were pinned, sit in a Pinned group at
 * the top of their tab instead of in their folder; the pins live in `pins.json` (`pins.get`, `pins.set`).
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
  const [kind, setKind] = useState<'queries' | 'workbooks'>('queries');
  const [pins, setPins] = useState<Pins>(NO_PINS);

  useEffect(() => {
    let live = true;
    call<Pins | null>('pins.get').then(
      (p) => live && setPins(p ?? NO_PINS),
      (e: unknown) => live && setProblem({ text: `The pins couldn’t be read: ${errorText(e)}`, reportId: reportIdOf(e) }),
    );
    return () => {
      live = false;
    };
  }, []);

  /** Pins the query or workbook `id`, at the end of the pinned ones, or unpins it; puts the pins back if they can't be stored. */
  const togglePin = (list: keyof Pins, id: string) => {
    const before = pins;
    const ids = before[list];
    const after = { ...before, [list]: ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id] };
    setPins(after);
    call('pins.set', { pins: after }).then(
      () => setProblem(null),
      (e: unknown) => {
        setPins(before);
        setProblem({ text: `The pins couldn’t be saved: ${errorText(e)}`, reportId: reportIdOf(e) });
      },
    );
  };

  useEffect(() => {
    let live = true;
    // A read that works clears its own earlier failure, not the other read's.
    const cleared = (failed: string) => setProblem((p) => (p?.text.startsWith(failed) ? null : p));
    call<LibraryList>('library.list').then(
      (l) => {
        if (live) {
          setList(l);
          cleared(LIST_FAILED);
        }
      },
      (e: unknown) => live && setProblem({ text: `${LIST_FAILED}: ${errorText(e)}`, reportId: reportIdOf(e) }),
    );
    call<WorkbookList | null>('workbook.list').then(
      (l) => {
        if (live) {
          setWorkbooks(l);
          cleared(WORKBOOKS_FAILED);
        }
      },
      (e: unknown) => live && setProblem({ text: `${WORKBOOKS_FAILED}: ${errorText(e)}`, reportId: reportIdOf(e) }),
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

  const importFile = () =>
    importWorkbook().then(
      () => setProblem(null),
      (e: unknown) => setProblem({ text: `The workbook couldn’t be imported: ${errorText(e)}`, reportId: reportIdOf(e) }),
    );

  const removeWorkbook = (w: WorkbookSummary) => {
    setDeleting(null);
    call('workbook.delete', { id: w.id }).then(
      () => {
        // A tab it is open in stays, unsaved: Ctrl+S must not write the deleted file back.
        for (const t of useTabs.getState().tabs.filter((t) => t.savedId === w.id)) {
          useTabs.getState().forgetSaved(t.id);
          useWorkbooks.getState().markUnsaved(t.id);
        }
        setProblem(null);
        changed();
      },
      (e: unknown) => setProblem({ text: `It couldn’t be deleted: ${errorText(e)}`, reportId: reportIdOf(e) }),
    );
  };

  const needle = search.trim().toLowerCase();
  const queries = (list?.queries ?? []).filter((q) => (all || q.source === source) && (!needle || q.name.toLowerCase().includes(needle)));

  /** `shown` is the name without the prefix of the group it is in. */
  const row = (q: SavedQuery, shown = q.name) => {
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
          <span className="truncate">{shown}</span>
        </button>
        <RowMenu
          name={q.name}
          actions={[
            { label: pins.queries.includes(q.id) ? 'Unpin' : 'Pin', run: () => togglePin('queries', q.id) },
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
          <span className="truncate">{w.name}</span>
        </button>
        <RowMenu
          name={w.name}
          actions={[
            { label: pins.workbooks.includes(w.id) ? 'Unpin' : 'Pin', run: () => togglePin('workbooks', w.id) },
            { label: 'Delete', run: () => setDeleting(w.id) },
          ]}
        />
      </li>
    );
  /** The pinned items among `items`, in the order they were pinned, and the others; a pin whose item is gone is skipped. */
  const pinnedOf = <T extends { id: string }>(items: T[], ids: string[]) => ({
    pinned: ids.flatMap((id) => items.filter((i) => i.id === id)),
    others: items.filter((i) => !ids.includes(i.id)),
  });
  const shownWorkbooks = (workbooks?.workbooks ?? []).filter((w) => !needle || w.name.toLowerCase().includes(needle));
  const { pinned: pinnedWorkbooks, others: otherWorkbooks } = pinnedOf(shownWorkbooks, pins.workbooks);
  // Workbook folders fold as query folders do, keyed apart from them (a query folder and a workbook folder can share a name).
  const workbookFolders = (workbooks?.folders ?? [])
    .map((f) => ({ name: f, key: `workbooks/${f}`, items: otherWorkbooks.filter((w) => w.folder === f) }))
    .filter((f) => f.items.length > 0);
  const looseWorkbooks = otherWorkbooks.filter((w) => !w.folder || !workbooks?.folders.includes(w.folder));

  /** A folder of `count` items that folds, under `key` in the folded state; a search shows its matches in every folder. */
  const folder = (key: string, name: string, count: number, rows: ReactNode[]) => {
    const open = needle !== '' || !folded[key];
    return (
      <li key={`folder:${key}`}>
        <button type="button" className="side-open folder" aria-label={name} aria-expanded={open} onClick={() => setFolded((s) => ({ ...s, [key]: open }))}>
          <svg className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <path d="M9 6l6 6-6 6" />
          </svg>
          <span className="truncate">{name}</span>
          <span className="ty" aria-hidden="true">
            {count}
          </span>
        </button>
        {open && <ul className="side-list ml-[13px] border-l border-line pr-0 pl-1.5">{rows}</ul>}
      </li>
    );
  };
  /** Queries with their shared prefixes folded into groups, keyed under `key`. */
  const grouped = (key: string, qs: SavedQuery[]) => {
    const { groups, rest } = byPrefix(qs);
    return [
      ...groups.map(([p, gs]) => folder(`${key}/${p}`, p, gs.length, gs.map((q) => row(q, q.name.slice(p.length + 3))))),
      ...rest.map((q) => row(q)),
    ];
  };
  const { pinned: pinnedQueries, others: otherQueries } = pinnedOf(queries, pins.queries);
  const folders = (list?.folders ?? []).map((f) => ({ name: f, queries: otherQueries.filter((q) => q.folder === f) })).filter((f) => f.queries.length > 0);
  const loose = otherQueries.filter((q) => !q.folder || !list?.folders.includes(q.folder));
  const tab = (k: typeof kind, label: string, count: number) => (
    <button type="button" role="tab" className="rtab h-8 flex-1" aria-selected={kind === k} onClick={() => setKind(k)}>
      {label} <span className="faint text-[11px] font-normal">{count}</span>
    </button>
  );
  const what = kind === 'queries' ? 'query' : 'workbook';

  return (
    <aside className="side" aria-label="Saved">
      <PanelHeading title="Saved" source={source} all={all} onAll={setAll} />
      <div role="tablist" aria-label="Saved" className="mx-3 mb-2 flex border-b border-line">
        {tab('queries', 'Queries', queries.length)}
        {tab('workbooks', 'Workbooks', shownWorkbooks.length)}
      </div>
      <input
        className="search"
        type="search"
        aria-label={`Find a saved ${what}`}
        placeholder={`Find a saved ${what}`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div role="tabpanel" aria-label={kind === 'queries' ? 'Queries' : 'Workbooks'} className="min-h-0 flex-1 overflow-y-auto pb-3">
        {problem && (
          <p role="alert" className="m-0 px-[14px] pb-2 text-[12px] text-bad">
            {problem.text}
            <ErrorReportActions reportId={problem.reportId} uiSections={{ message: problem.text }} />
          </p>
        )}
        {kind === 'queries' ? (
          <>
            {list && list.skipped > 0 && <p className="m-0 px-[14px] pb-2 text-[12px] text-warn">{skippedText(list.skipped)}</p>}
            {list && queries.length === 0 && (
              <p className="faint m-0 px-[14px] text-[12px]">{needle ? 'No saved query matches.' : `No saved queries yet. Save a query with ${MOD} S.`}</p>
            )}
            <ul className="side-list">
              {pinnedQueries.length > 0 && folder('\0pinned', 'Pinned', pinnedQueries.length, pinnedQueries.map((q) => row(q)))}
              {folders.map((f) => folder(f.name, f.name, f.queries.length, grouped(f.name, f.queries)))}
              {grouped('', loose)}
            </ul>
          </>
        ) : (
          <>
            {workbooks && workbooks.skipped > 0 && (
              <p className="m-0 px-[14px] pb-2 text-[12px] text-warn">
                {workbooks.skipped === 1 ? '1 workbook couldn’t be read and was moved aside.' : `${workbooks.skipped} workbooks couldn’t be read and were moved aside.`}
              </p>
            )}
            {workbooks && shownWorkbooks.length === 0 && (
              <p className="faint m-0 px-[14px] text-[12px]">{needle ? 'No workbook matches.' : 'No workbooks yet.'}</p>
            )}
            <ul className="side-list">
              {pinnedWorkbooks.length > 0 && folder('workbooks/\0pinned', 'Pinned', pinnedWorkbooks.length, pinnedWorkbooks.map(workbookRow))}
              {workbookFolders.map((f) => folder(f.key, f.name, f.items.length, f.items.map(workbookRow)))}
              {looseWorkbooks.map(workbookRow)}
            </ul>
          </>
        )}
      </div>
      {kind === 'workbooks' && (
        <div className="side-foot">
          <button type="button" className="btn" onClick={() => void importFile()}>
            Import workbook…
          </button>
        </div>
      )}
    </aside>
  );
}
