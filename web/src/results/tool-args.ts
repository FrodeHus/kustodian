import type { ExternalTool, ResultColumn } from '../wire';
import { cellText, type Row } from './export';

/** A `{parameter}` in a tool's argument, as the host reads it. */
const PLACEHOLDER = /\{([^{}]+)\}/g;

/** Which column fills each of a tool's parameters; '' while none is chosen. */
export type ColumnMapping = Record<string, string>;

/** The parameters a tool's arguments name. */
export const toolColumns = (tool: ExternalTool): string[] => [
  ...new Set(tool.args.flatMap((a) => [...a.matchAll(PLACEHOLDER)].map((m) => m[1] ?? ''))),
];

/** Each parameter mapped to the column of the same name, else one that differs only in case, else to none. */
export const defaultMapping = (tool: ExternalTool, columns: ResultColumn[]): ColumnMapping =>
  Object.fromEntries(
    toolColumns(tool).map((p) => [
      p,
      columns.find((c) => c.name === p)?.name ?? columns.find((c) => c.name.toLowerCase() === p.toLowerCase())?.name ?? '',
    ]),
  );

/** A tool button's mapping for this result: the saved column for each of the tool's parameters when the result has that
 * column, else what defaultMapping picks. Only the tool's current parameters are keys. */
export const startMapping = (tool: ExternalTool, columns: ResultColumn[], saved: ColumnMapping): ColumnMapping => {
  const picked = defaultMapping(tool, columns);
  return Object.fromEntries(
    Object.entries(picked).map(([p, column]) => [p, columns.some((c) => c.name === saved[p]) ? (saved[p] as string) : column]),
  );
};

/** The arguments a tool gets for a row, as the host fills them in from the mapped columns. */
export const fillArgs = (tool: ExternalTool, columns: ResultColumn[], row: Row, mapping: ColumnMapping): string[] =>
  tool.args.map((a) =>
    a.replace(PLACEHOLDER, (_, name: string) => cellText(row[columns.findIndex((c) => c.name === (mapping[name] || name))])),
  );

/** A command line to read: an argument with anything but plain characters in single quotes. The host never runs it as text. */
export const commandLine = (command: string, args: string[]) =>
  [command, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(' ');
