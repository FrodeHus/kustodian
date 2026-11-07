import { createContext } from 'react';

/** Where a table widget's row details sheet goes: the workbook's own area, so it is as tall as a query tab's; none (in the
 * widget, then) for the editor's preview and a widget in full screen. */
export const SheetHost = createContext<HTMLElement | null>(null);
