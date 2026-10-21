import { describe, expect, it } from 'vitest';
import { blockAt } from './block-at';

const text = ['// first', 'applications', '| take 3', '', 'users', '| count', '', ''].join('\n');

describe('blockAt', () => {
  it('blockAt_returns_lines_between_blank_lines', () => {
    expect(blockAt(text, 2)).toEqual({ start: 1, end: 3, text: '// first\napplications\n| take 3' });
    expect(blockAt(text, 6)).toEqual({ start: 5, end: 6, text: 'users\n| count' });
  });

  it('blockAt_on_blank_line_takes_block_above', () => {
    expect(blockAt(text, 4)).toEqual({ start: 1, end: 3, text: '// first\napplications\n| take 3' });
    // Two blank lines below the last block: still the block above.
    expect(blockAt(text, 8)).toEqual({ start: 5, end: 6, text: 'users\n| count' });
    // A line of spaces counts as blank.
    expect(blockAt('a\n   \nb', 2)).toEqual({ start: 1, end: 1, text: 'a' });
  });

  it('blockAt_reads_crlf_line_endings', () => {
    const crlf = 'applications\r\n| take 3\r\n\r\nusers\r\n| count';
    expect(blockAt(crlf, 2)).toEqual({ start: 1, end: 2, text: 'applications\n| take 3' });
    expect(blockAt(crlf, 3)).toEqual({ start: 1, end: 2, text: 'applications\n| take 3' });
    expect(blockAt(crlf, 5)).toEqual({ start: 4, end: 5, text: 'users\n| count' });
  });

  it('blockAt_on_a_last_line_with_text_takes_its_block', () => {
    const last = 'applications\n\nusers\n| where accountEnabled\n| count';
    expect(blockAt(last, 5)).toEqual({ start: 3, end: 5, text: 'users\n| where accountEnabled\n| count' });
  });

  it('blockAt_single_block_returns_all', () => {
    const single = 'applications\n| where displayName startswith "C"\n| take 10';
    expect(blockAt(single, 2)).toEqual({ start: 1, end: 3, text: single });
    // A blank first line with nothing above takes the block below.
    expect(blockAt('\nusers', 1)).toEqual({ start: 2, end: 2, text: 'users' });
  });
});
