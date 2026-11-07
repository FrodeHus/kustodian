import { useEffect, useId, useRef, useState } from 'react';
import { call } from '../bridge';
import { MAX_FOLDER_LENGTH, MAX_NAME_LENGTH } from '../library/saving';
import { errorText } from '../shell/errors';
import { ErrorReportActions, type Shown } from '../shell/error-report';
import { reportIdOf } from '../shell/report-id';
import { inSendDetails } from '../shell/send-details-marker';
import type { Tab } from '../tabs/tab-store';
import type { WorkbookList } from '../wire';
import { saveWorkbook } from './workbook-store';

/**
 * The first Save of a workbook: a name and a folder (one of the workbooks', or a new one typed in). Later saves write without
 * it. What the host refuses (a name too long, a folder with a /) shows in the dialog, which stays open.
 */
export function SaveWorkbookDialog({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const [name, setName] = useState(tab.workbook?.name ?? tab.title);
  const [folder, setFolder] = useState(tab.workbook?.folder ?? '');
  const [folders, setFolders] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Shown | null>(null);
  const id = useId();
  const dialogRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // Once closing, focus may go wherever the caller puts it.
  const closing = useRef(false);
  const close = () => {
    closing.current = true;
    onClose();
  };

  // A modal, as the save dialog is: focus that lands outside the dialog goes back to its name field.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (!closing.current && !inSendDetails(e.target) && (!(e.target instanceof Node) || !dialogRef.current?.contains(e.target))) {
        nameRef.current?.focus();
      }
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  useEffect(() => {
    let live = true;
    call<WorkbookList>('workbook.list').then(
      (list) => live && setFolders(list.folders),
      // Folders are only offered; a new one can still be typed.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  const trimmed = name.trim();

  return (
    <div className="fixed inset-0 z-20">
      <div className="scrim" onClick={close} />
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="card absolute top-1/4 left-1/2 flex w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-3.5 p-5"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed) {
            return;
          }
          setBusy(true);
          setError(null);
          saveWorkbook(tab.id, { name: trimmed, folder: folder.trim() || null }).then(close, (err: unknown) => {
            setBusy(false);
            setError({ text: errorText(err), reportId: reportIdOf(err) });
          });
        }}
      >
        <b id={`${id}-title`} className="text-[14px]">
          Save the workbook
        </b>
        <div className="field">
          <label htmlFor={`${id}-name`}>Name</label>
          <input
            ref={nameRef}
            id={`${id}-name`}
            className="textbox"
            maxLength={MAX_NAME_LENGTH}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
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
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </div>
        {error && (
          <span role="alert" className="text-[12px] text-bad">
            {error.text}
            <ErrorReportActions reportId={error.reportId} uiSections={{ message: error.text }} />
          </span>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !trimmed}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
