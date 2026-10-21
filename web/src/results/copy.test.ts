import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFailed, copyText, formatRows } from './copy';

const columns = [
  { name: 'a', type: 'string' },
  { name: 'b', type: 'long' },
];

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('copy', () => {
  it('copy_text_writes_the_clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    await copyText('hello');

    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('copy_text_rejects_without_a_clipboard', async () => {
    await expect(copyText('hello')).rejects.toThrow('the clipboard isn’t available here.');
    expect(copyFailed(new Error('Denied.'))).toBe('Couldn’t copy: Denied.');
  });

  it('format_rows_with_and_without_the_header', () => {
    const rows = [['x', 1]];
    expect(formatRows('csv', columns, rows, true)).toBe('a,b\r\nx,1');
    expect(formatRows('csv', columns, rows, false)).toBe('x,1');
    expect(formatRows('markdown', columns, rows, false)).toBe('| x | 1 |');
    expect(JSON.parse(formatRows('json', columns, rows, true))).toEqual([{ a: 'x', b: 1 }]);
    expect(JSON.parse(formatRows('json', columns, rows, false))).toEqual([['x', 1]]);
  });
});
