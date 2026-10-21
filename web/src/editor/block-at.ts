export interface Block {
  /** The block's first line, counting from 1. */
  start: number;
  /** The block's last line, inclusive. */
  end: number;
  text: string;
}

const isBlank = (line: string) => line.trim() === '';

/**
 * The block Run runs (spec 6.2): the lines around `line` (counting from 1) up to the blank lines on either side, as in Kusto
 * Explorer. On a blank line it is the nearest block above, or the one below when there is nothing above.
 */
export function blockAt(text: string, line: number): Block {
  const lines = text.split(/\r?\n/);
  let at = Math.min(Math.max(line, 1), lines.length) - 1;

  if (isBlank(lines[at] ?? '')) {
    let above = at;
    while (above >= 0 && isBlank(lines[above] ?? '')) {
      above--;
    }
    if (above >= 0) {
      at = above;
    } else {
      let below = at;
      while (below < lines.length && isBlank(lines[below] ?? '')) {
        below++;
      }
      if (below >= lines.length) {
        return { start: line, end: line, text: '' };
      }
      at = below;
    }
  }

  let start = at;
  while (start > 0 && !isBlank(lines[start - 1] ?? '')) {
    start--;
  }
  let end = at;
  while (end < lines.length - 1 && !isBlank(lines[end + 1] ?? '')) {
    end++;
  }
  return { start: start + 1, end: end + 1, text: lines.slice(start, end + 1).join('\n') };
}
