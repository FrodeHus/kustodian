import { call } from '../bridge';
import type { FileFilter, ResultColumn, SavedFile } from '../wire';

export type Row = unknown[];

/** A result's columns and rows: what the export, copy and compare functions take. */
export interface ResultTable {
  columns: ResultColumn[];
  rows: Row[];
}

/** A cell as text: empty for null, dynamic values as compact JSON, anything else as itself. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** One CSV field (RFC 4180): quoted, with its quotes doubled, when it holds the separator, a quote, CR or LF. */
function csvField(value: unknown, separator: string): string {
  const text = cellText(value);
  return text.includes(separator) || /["\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * The rows as CSV (RFC 4180): a header line of column names, then one line per row, with CRLF between lines. `bom` starts the
 * text with a UTF-8 byte order mark, which Excel needs to read it as UTF-8. `header: false` leaves the header line out.
 */
export function toCsv(columns: ResultColumn[], rows: Row[], opts: { separator?: string; bom?: boolean; header?: boolean } = {}): string {
  const separator = opts.separator ?? ',';
  const line = (values: unknown[]) => values.map((v) => csvField(v, separator)).join(separator);
  const lines = rows.map(line);
  if (opts.header !== false) {
    lines.unshift(line(columns.map((c) => c.name)));
  }
  return (opts.bom ? '﻿' : '') + lines.join('\r\n');
}

/** A Markdown table cell: its pipes escaped and its line breaks as `<br>`, so the cell stays on its row. */
const markdownCell = (value: unknown) => cellText(value).replaceAll('|', '\\|').replace(/\r\n|\r|\n/g, '<br>');

/** The rows as a Markdown table. `header: false` leaves out the header and its rule line. */
export function toMarkdown(columns: ResultColumn[], rows: Row[], opts: { header?: boolean } = {}): string {
  const line = (values: unknown[]) => `| ${values.map(markdownCell).join(' | ')} |`;
  const lines = rows.map(line);
  if (opts.header !== false) {
    lines.unshift(line(columns.map((c) => c.name)), `| ${columns.map(() => '---').join(' | ')} |`);
  }
  return lines.join('\n');
}

/** The rows as a JSON array of objects keyed by column name. */
export function toJson(columns: ResultColumn[], rows: Row[]): string {
  return JSON.stringify(
    rows.map((row) => Object.fromEntries(columns.map((c, i) => [c.name, row[i] ?? null]))),
    null,
    2,
  );
}

/** Excel's separator for this locale: `;` where numbers are written with a decimal comma, else `,`. */
export function excelSeparator(): string {
  return new Intl.NumberFormat().format(1.5).includes(',') ? ';' : ',';
}

export type ExportFormat = 'csv' | 'excel' | 'json' | 'markdown';

/** What each export is called, as its menu item and command title say. */
export const EXPORT_NAMES: Record<ExportFormat, string> = { csv: 'CSV', excel: 'Excel CSV', json: 'JSON', markdown: 'Markdown' };

export const EXPORT_FORMATS: ExportFormat[] = ['csv', 'excel', 'json', 'markdown'];

const FILES: Record<ExportFormat, { extension: string; filter: FileFilter }> = {
  csv: { extension: 'csv', filter: { name: 'CSV', extensions: ['csv'] } },
  excel: { extension: 'csv', filter: { name: 'CSV', extensions: ['csv'] } },
  json: { extension: 'json', filter: { name: 'JSON', extensions: ['json'] } },
  markdown: { extension: 'md', filter: { name: 'Markdown', extensions: ['md'] } },
};

function content(format: ExportFormat, { columns, rows }: ResultTable): string {
  switch (format) {
    case 'csv':
      return toCsv(columns, rows);
    case 'excel':
      return toCsv(columns, rows, { separator: excelSeparator(), bom: true });
    case 'json':
      return toJson(columns, rows);
    case 'markdown':
      return toMarkdown(columns, rows);
  }
}

/**
 * Exports every row of the result (spec 6.5: not only the rows the grid shows) through the host's save dialog, suggesting
 * `<tab title>.<ext>` (a title that is a `.kql` file name loses that extension). Resolves the file written, or null when the
 * dialog was cancelled.
 */
export function exportResult(format: ExportFormat, title: string, table: ResultTable): Promise<SavedFile | null> {
  const { extension, filter } = FILES[format];
  const name = title.replace(/\.kql$/i, '');
  return call<SavedFile | null>('file.saveAs', { suggestedName: `${name}.${extension}`, filters: [filter], content: content(format, table) });
}
