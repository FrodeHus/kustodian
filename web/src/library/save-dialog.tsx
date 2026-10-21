import { useEffect, useId, useState } from 'react';
import { call } from '../bridge';
import type { Tab } from '../tabs/tab-store';
import type { LibraryList } from '../wire';
import { saveToFile, saveToLibrary } from './saving';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Save (a new tab) and Save as (spec 6.2): a name, a folder (one of the library's, or a new one typed in), then "Save to
 * library" or "Save to file". The library always gets a new query here; Save on a tab already in the library updates it
 * without this dialog. What the host refuses (a name too long, a folder with a /) shows in the dialog, which stays open.
 */
export function SaveDialog({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const [name, setName] = useState(tab.title);
  const [folder, setFolder] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  useEffect(() => {
    let live = true;
    call<LibraryList>('library.list').then(
      (list) => {
        if (!live) {
          return;
        }
        setFolders(list.folders);
        const from = tab.savedId ? list.queries.find((q) => q.id === tab.savedId) : undefined;
        if (from?.folder) {
          setFolder(from.folder);
        }
      },
      // Folders are only offered; a new one can still be typed.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [tab.savedId]);

  const attempt = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    action().then(
      (done) => {
        setBusy(false);
        if (done !== false) {
          onClose();
        }
      },
      (e: unknown) => {
        setBusy(false);
        setError(errorText(e));
      },
    );
  };

  const trimmed = name.trim();

  return (
    <div className="fixed inset-0 z-20">
      <div className="scrim" onClick={onClose} />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="card absolute top-1/4 left-1/2 flex w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-3.5 p-5"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed) {
            attempt(() => saveToLibrary(tab.id, trimmed, folder.trim() || null, true));
          }
        }}
      >
        <b id={`${id}-title`} className="text-[14px]">
          Save the query
        </b>
        <div className="field">
          <label htmlFor={`${id}-name`}>Name</label>
          <input id={`${id}-name`} className="textbox" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-folder`}>Folder</label>
          <input
            id={`${id}-folder`}
            className="textbox"
            list={`${id}-folders`}
            placeholder="No folder"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          />
          <datalist id={`${id}-folders`}>
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </div>
        {error && (
          <span role="alert" className="text-[12px] text-bad">
            {error}
          </span>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={busy || !trimmed} onClick={() => attempt(() => saveToFile(tab.id, { name: trimmed }))}>
            Save to file
          </button>
          <button type="submit" className="btn primary" disabled={busy || !trimmed}>
            Save to library
          </button>
        </div>
      </form>
    </div>
  );
}
