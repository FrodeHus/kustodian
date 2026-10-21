import { useEffect, useState } from 'react';
import { call } from '../bridge';
import { useRevisions } from '../library/saving';
import { MOD } from '../shell/keys';
import { useTabs } from '../tabs/tab-store';
import type { LibraryList, SavedQuery } from '../wire';
import { ConfirmDelete, RowMenu } from './row-menu';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Opens a saved query in a new tab, or goes to the tab it is already open in. */
function openSaved(q: SavedQuery) {
  const { tabs, activate, openWith } = useTabs.getState();
  const open = tabs.find((t) => t.savedId === q.id);
  if (open) {
    activate(open.id);
  } else {
    openWith({ source: q.source, title: q.name, text: q.text, savedId: q.id, parameters: q.parameters });
  }
}

function skippedText(n: number): string {
  return n === 1 ? '1 saved query couldn’t be read and was moved aside.' : `${n} saved queries couldn’t be read and were moved aside.`;
}

/**
 * The Saved panel (spec 6.6): the library's folders as groups that fold, then the queries in no folder, with a search. A
 * query opens on click; its menu renames it or deletes it (after asking).
 */
export function SavedPanel() {
  const revision = useRevisions((s) => s.library);
  const [list, setList] = useState<LibraryList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    call<LibraryList>('library.list').then(
      (l) => live && setList(l),
      (e: unknown) => live && setProblem(`The saved queries couldn’t be read: ${errorText(e)}`),
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
    const { id, folder, source, text, parameters } = q;
    call<SavedQuery>('library.save', { query: { id, name: trimmed, folder, source, text, parameters } }).then(
      (saved) => {
        const { tabs, setTitle } = useTabs.getState();
        tabs.filter((t) => t.savedId === saved.id).forEach((t) => setTitle(t.id, saved.name));
        setProblem(null);
        changed();
      },
      (e: unknown) => setProblem(`It couldn’t be renamed: ${errorText(e)}`),
    );
  };

  const remove = (q: SavedQuery) => {
    setDeleting(null);
    call('library.delete', { id: q.id }).then(
      () => {
        setProblem(null);
        changed();
      },
      (e: unknown) => setProblem(`It couldn’t be deleted: ${errorText(e)}`),
    );
  };

  const needle = search.trim().toLowerCase();
  const queries = (list?.queries ?? []).filter((q) => !needle || q.name.toLowerCase().includes(needle));

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
        <button type="button" className="side-open" title={q.text} onClick={() => openSaved(q)}>
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

  const folders = (list?.folders ?? []).map((f) => ({ name: f, queries: queries.filter((q) => q.folder === f) })).filter((f) => f.queries.length > 0);
  const loose = queries.filter((q) => !q.folder || !list?.folders.includes(q.folder));

  return (
    <aside className="side" aria-label="Saved">
      <h2>Saved</h2>
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
            {problem}
          </p>
        )}
        {list && list.skipped > 0 && <p className="m-0 px-[14px] pb-2 text-[12px] text-warn">{skippedText(list.skipped)}</p>}
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
        </ul>
      </div>
    </aside>
  );
}
