import { createContext } from 'react';

/** How many rows a table widget prints, from the first. */
export const PRINT_ROWS = 500;

/** Print or save as PDF is under way: a table widget renders its rows for paper rather than for its scroll box. */
export const Printing = createContext(false);
