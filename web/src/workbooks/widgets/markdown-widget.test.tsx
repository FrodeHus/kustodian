import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownWidget } from './markdown-widget';
import { withValues } from './with-values';

const call = vi.hoisted(() => vi.fn());
vi.mock('../../bridge', () => ({ call }));

beforeEach(() => call.mockReset().mockResolvedValue(null));

describe('MarkdownWidget', () => {
  it('renders headings, emphasis and lists', () => {
    const { container } = render(<MarkdownWidget text={'# Title\n\n**b**\n\n- a'} values={{}} />);
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('strong')?.textContent).toBe('b');
    expect(container.querySelector('li')?.textContent).toBe('a');
  });

  it('ignores raw HTML', () => {
    const { container } = render(<MarkdownWidget text={'<script>alert(1)</script>\n\n<b>x</b>'} values={{}} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });

  it('renders no link for javascript: or http: urls, and no image', () => {
    const { container } = render(<MarkdownWidget text={'[x](javascript:alert(1)) [y](http://a) ![z](https://a/i.png)'} values={{}} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('x');
  });

  it('opens an https link through the host', () => {
    render(<MarkdownWidget text="[docs](https://learn.microsoft.com/)" values={{}} />);
    const link = screen.getByRole('link', { name: 'docs' });
    expect(fireEvent.click(link)).toBe(false);
    expect(call).toHaveBeenCalledWith('app.openLink', { url: 'https://learn.microsoft.com/' });
  });

  it('shows a parameter value as text, never as markup', () => {
    const { container } = render(<MarkdownWidget text="Range {R}" values={{ R: '[y](https://evil)' }} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('Range [y](https://evil)');
  });
});

describe('withValues', () => {
  it('substitutes known names, escaped, and keeps unknown ones', () => {
    expect(withValues('Range {TimeRange}', { TimeRange: '7d' })).toBe('Range 7d');
    expect(withValues('{A}', { A: '[y](https://evil)' })).toBe('\\[y\\]\\(https://evil\\)');
    expect(withValues('{Nope}', {})).toBe('{Nope}');
  });
});
