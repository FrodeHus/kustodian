import type { ExternalTool, ResultColumn } from '../wire';
import { cellText, type Row } from './export';

/** A `{column}` in a tool's argument, as the host reads it. */
const PLACEHOLDER = /\{([^{}]+)\}/g;

/** The columns a tool's arguments name. */
export const toolColumns = (tool: ExternalTool): string[] => [
  ...new Set(tool.args.flatMap((a) => [...a.matchAll(PLACEHOLDER)].map((m) => m[1] ?? ''))),
];

/** The arguments a tool gets for a row, as the host fills them in. */
export const fillArgs = (tool: ExternalTool, columns: ResultColumn[], row: Row): string[] =>
  tool.args.map((a) => a.replace(PLACEHOLDER, (_, name: string) => cellText(row[columns.findIndex((c) => c.name === name)])));

/** A command line to read: an argument with anything but plain characters in single quotes. The host never runs it as text. */
export const commandLine = (command: string, args: string[]) =>
  [command, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(' ');
