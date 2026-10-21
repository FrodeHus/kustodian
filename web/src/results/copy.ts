import { errorText } from '../shell/errors';
import type { DiagnosticEntry, ResultColumn } from '../wire';
import { toCsv, toJson, toMarkdown, type Row } from './export';

export type CopyFormat = 'csv' | 'markdown' | 'json';

export const COPY_FORMATS: { format: CopyFormat; name: string }[] = [
  { format: 'csv', name: 'CSV' },
  { format: 'markdown', name: 'Markdown' },
  { format: 'json', name: 'JSON' },
];

/**
 * Rows as text to copy. With `header` (rows) CSV and Markdown start with the column names and JSON is objects keyed by them;
 * without it (cells) only the values are copied, and JSON is an array of arrays.
 */
export function formatRows(format: CopyFormat, columns: ResultColumn[], rows: Row[], header: boolean): string {
  switch (format) {
    case 'csv':
      return toCsv(columns, rows, { header });
    case 'markdown':
      return toMarkdown(columns, rows, { header });
    case 'json':
      return header ? toJson(columns, rows) : JSON.stringify(rows.map((r) => columns.map((_, i) => r[i] ?? null)), null, 2);
  }
}

/** Puts `text` on the clipboard. Rejects when the webview has no clipboard or refuses to write it. */
export async function copyText(text: string): Promise<void> {
  // A webview outside a secure context has no `navigator.clipboard`.
  const clipboard = (navigator as { clipboard?: Clipboard }).clipboard;
  if (!clipboard?.writeText) {
    throw new Error('the clipboard isn’t available here.');
  }
  await clipboard.writeText(text);
}

/** The notice for a copy that failed. */
export const copyFailed = (e: unknown) => `Couldn’t copy: ${errorText(e)}`;

/** One entry as a line of text: `+{atMs}ms {kind} {status?} {detail} {durationMs?}ms {bytes?}B`, leaving out what it lacks. */
export function entryText(e: DiagnosticEntry): string {
  return [
    `+${e.atMs}ms`,
    e.kind,
    e.status ?? null,
    e.detail,
    e.durationMs === null ? null : `${e.durationMs}ms`,
    e.bytes === null ? null : `${e.bytes}B`,
  ]
    .filter((part) => part !== null && part !== '')
    .join(' ');
}

/** The log as text for a bug report: one line per entry. */
export const diagnosticsText = (entries: DiagnosticEntry[]) => entries.map(entryText).join('\n');
