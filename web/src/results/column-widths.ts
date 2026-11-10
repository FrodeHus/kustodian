import type { ResultColumn } from '../wire';
import { cellText, type Row } from './export';

// Approximate pixels per character of the cell font (12px JetBrains Mono) and of the header, plus a cell's side padding.
const CHAR_PX = 7.3;
const HEADER_CHAR_PX = 7.6;
const CELL_PAD = 24 + 16;
const MAX_COL_PX = 480;
// The header's column menu button (⌄) and its gap, when the grid has one.
const MENU_BUTTON_PX = 24;
// shortcut: widths come from the first rows only; a longer value further down is cut with an ellipsis. Scan more if that bites.
const WIDTH_SAMPLE = 2000;

/** A fixed width per column, from its header and its longest value, so scrolling never resizes columns. */
export function columnWidths(columns: ResultColumn[], rows: Row[], statistics = false): Map<string, number> {
  const sample = rows.slice(0, WIDTH_SAMPLE);
  return new Map(
    columns.map((c, i) => {
      const longest = sample.reduce((n, row) => Math.max(n, row[i] === null || row[i] === undefined ? 4 : cellText(row[i]).length), 0);
      return [
        c.name,
        Math.min(
          MAX_COL_PX,
          Math.ceil(Math.max(longest * CHAR_PX, c.name.length * HEADER_CHAR_PX + (statistics ? MENU_BUTTON_PX : 0)) + CELL_PAD),
        ),
      ];
    }),
  );
}
