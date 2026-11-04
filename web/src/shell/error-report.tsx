import { Component, useEffect, useId, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { call } from '../bridge';
import { copyText } from '../results/copy';
import type { ErrorDetails } from '../wire';
import { reportUiError } from './error-capture';
import { errorText } from './errors';
import { formatReportId } from './report-id';
import { SEND_DETAILS_ATTRIBUTE } from './send-details-marker';

/** An error as a component keeps it to show: its text, and the report ID the host gave it, if any. */
export interface Shown {
  text: string;
  reportId?: string;
}

/** What the page itself has of an error, for a report the host no longer keeps. */
export interface UiSections {
  query?: string;
  message: string;
  uiStack?: string;
}

const UI_TITLES: Record<keyof UiSections, string> = { query: 'Query', message: 'Message', uiStack: 'Stack' };

/** Shows "Report ID: K7Q2-M9XD" with a copy button, and "Send details" when this build can send reports. Nothing without an ID. */
export function ErrorReportActions({ reportId, uiSections }: { reportId?: string; uiSections: UiSections }) {
  const [details, setDetails] = useState<ErrorDetails | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!reportId) {
      return;
    }
    let live = true;
    call<ErrorDetails>('errors.details', { reportId }).then(
      (answer) => live && setDetails(answer),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [reportId]);

  if (!reportId) {
    return null;
  }

  // The dashed form is what users quote.
  const copy = () =>
    copyText(formatReportId(reportId)).then(
      () => setCopied(true),
      () => undefined,
    );

  return (
    <span className="inline-flex shrink-0 items-center gap-2 text-[11.5px]">
      <span className="mono faint">Report ID: {formatReportId(reportId)}</span>
      <button type="button" className="text-accent underline" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      {details?.canSend && (
        <button type="button" className="text-accent underline" onClick={() => setOpen(true)}>
          Send details
        </button>
      )}
      {open && <SendDetailsDialog reportId={reportId} uiSections={uiSections} onClose={() => setOpen(false)} />}
    </span>
  );
}

/** Asks the host for the report again as it opens (it may have dropped it since the ID was shown), then shows it. */
export function SendDetailsDialog({ reportId, uiSections, onClose }: { reportId: string; uiSections: UiSections; onClose: () => void }) {
  const [details, setDetails] = useState<ErrorDetails | null>(null);
  useEffect(() => {
    let live = true;
    call<ErrorDetails>('errors.details', { reportId }).then(
      (answer) => live && setDetails(answer),
      () => live && setDetails({ report: null, canSend: true }),
    );
    return () => {
      live = false;
    };
  }, [reportId]);
  return details && <DetailsDialog reportId={reportId} details={details} uiSections={uiSections} onClose={onClose} />;
}

/** Shows what a full report holds, each section with a checkbox and the query editable, and sends what is left checked. */
function DetailsDialog({
  reportId,
  details,
  uiSections,
  onClose,
}: {
  reportId: string;
  details: ErrorDetails;
  uiSections: UiSections;
  onClose: () => void;
}) {
  const id = useId();
  // The host no longer keeps the report: the page offers its own parts, and says so.
  const gone = details.report === null;
  const sections = details.report
    ? details.report.sections
    : (Object.keys(UI_TITLES) as (keyof UiSections)[])
        .filter((key) => uiSections[key] !== undefined)
        .map((key) => ({ key, title: UI_TITLES[key], text: uiSections[key] ?? '', editable: key === 'query' }));
  const [texts, setTexts] = useState(() => Object.fromEntries(sections.map((s) => [s.key, s.text])));
  const [left, setLeft] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const toggle = (key: string, checked: boolean) =>
    setLeft((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  const send = () => {
    setBusy(true);
    setError(null);
    const chosen = Object.fromEntries(sections.filter((s) => !left.has(s.key)).map((s) => [s.key, texts[s.key] ?? '']));
    call<{ sent: boolean }>('errors.send', { reportId, sections: chosen }).then(
      () => setSent(true),
      (e: unknown) => {
        setBusy(false);
        setError(`The report couldn’t be sent: ${errorText(e)}`);
      },
    );
  };

  // In the body, not in the card that opened it: a transformed card would make a fixed dialog relative to itself. Events are
  // stopped here so the opener's own Esc and outside-click handling don't see the dialog's.
  return createPortal(
    <div
      className="fixed inset-0 z-40"
      {...{ [SEND_DETAILS_ATTRIBUTE]: '' }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="scrim" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="card absolute top-[8%] left-1/2 flex max-h-[84vh] w-[600px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-3 overflow-y-auto p-5"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <b id={`${id}-title`} className="text-[14px]">
          Send details · {formatReportId(reportId)}
        </b>
        {sent ? (
          <span className="text-[12.5px]" role="status">
            Sent. Thank you.
          </span>
        ) : (
          <>
            <span className="text-[12px]">
              This report may contain data from your tenant. It goes privately to the Kustodian maintainer’s Application Insights and is kept
              for 90 days. Untick what you don’t want to send; the text shown is exactly what is sent.
            </span>
            {gone && (
              <span className="text-[12px] text-warn" role="status">
                The details are no longer available. This is what the page still has.
              </span>
            )}
            {sections.map((s) => (
              <div key={s.key} className="flex flex-col gap-1">
                <label className="flex items-center gap-2 text-[12.5px] font-medium">
                  <input type="checkbox" checked={!left.has(s.key)} onChange={(e) => toggle(s.key, e.target.checked)} />
                  {s.title}
                </label>
                <textarea
                  aria-label={`${s.title} text`}
                  className="mono h-24 w-full rounded-md border border-line bg-panel2 p-2 text-[11.5px]"
                  readOnly={!s.editable}
                  value={texts[s.key] ?? ''}
                  onChange={(e) => setTexts((prev) => ({ ...prev, [s.key]: e.target.value }))}
                />
              </div>
            ))}
            {error && (
              <span className="text-[12px] text-bad" role="alert">
                {error}
              </span>
            )}
          </>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" autoFocus onClick={onClose}>
            {sent ? 'Close' : 'Cancel'}
          </button>
          {!sent && (
            <button type="button" className="btn primary" disabled={busy || sections.every((s) => left.has(s.key))} onClick={send}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Catches a render error anywhere below, reports it to the host and shows its report ID instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; reportId?: string }> {
  state: { error: Error | null; reportId?: string } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    void reportUiError(error, 'boundary').then((reportId) => this.setState({ reportId }));
  }

  render() {
    const { error, reportId } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 bg-bg p-6 text-text">
        <b>Something went wrong in Kustodian.</b>
        <span className="muted text-[12.5px]">{error.message}</span>
        <ErrorReportActions reportId={reportId} uiSections={{ message: error.message, uiStack: error.stack }} />
        <button type="button" className="btn" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
