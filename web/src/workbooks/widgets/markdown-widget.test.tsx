import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../../bridge';
import { MarkdownWidget } from './markdown-widget';
import { withValues } from './with-values';

const call = vi.hoisted(() => vi.fn());
vi.mock('../../bridge', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../bridge')>()), call }));

// Braces: a function returned from beforeEach is run as its teardown.
beforeEach(() => {
  call.mockReset().mockResolvedValue(null);
});

describe('MarkdownWidget', () => {
  it('renders headings, emphasis and lists', () => {
    const { container } = render(<MarkdownWidget text={'# Title\n\n**b**\n\n- a'} values={{}} />);
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('strong')?.textContent).toBe('b');
    expect(container.querySelector('li')?.textContent).toBe('a');
  });

  it('renders GFM tables', () => {
    const { container } = render(<MarkdownWidget text={'| Severity | Target |\n| --- | --- |\n| Critical | 95% |'} values={{}} />);
    expect([...container.querySelectorAll('th')].map((c) => c.textContent)).toEqual(['Severity', 'Target']);
    expect([...container.querySelectorAll('td')].map((c) => c.textContent)).toEqual(['Critical', '95%']);
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

  it('opens an https link through the host, on click and on Enter', () => {
    render(<MarkdownWidget text="[docs](https://learn.microsoft.com/)" values={{}} />);
    const link = screen.getByRole('link', { name: 'docs' });
    fireEvent.click(link);
    expect(call).toHaveBeenCalledWith('app.openLink', { url: 'https://learn.microsoft.com/' });
    call.mockClear();
    fireEvent.keyDown(link, { key: 'Enter' });
    expect(call).toHaveBeenCalledWith('app.openLink', { url: 'https://learn.microsoft.com/' });
  });

  it('a link has no href and is not draggable, so the window itself never navigates to it', () => {
    const { container } = render(<MarkdownWidget text="[docs](https://learn.microsoft.com/)" values={{}} />);
    expect(container.querySelector('[href]')).toBeNull();
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link.getAttribute('draggable')).toBe('false');
    expect(link.tabIndex).toBe(0);
  });

  it('says so in the widget when the host will not open a link', async () => {
    call.mockImplementation(() => Promise.reject(new BridgeError('bad_request', "Kustodian can't open links to example.com.")));
    render(<MarkdownWidget text="[x](https://example.com/)" values={{}} />);
    fireEvent.click(screen.getByRole('link', { name: 'x' }));
    expect((await screen.findByRole('alert')).textContent).toBe("Kustodian can't open links to example.com.");
  });

  it('shows a parameter value as text, never as markup', () => {
    const { container } = render(<MarkdownWidget text="Range {R}" values={{ R: '[y](https://evil)' }} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('Range [y](https://evil)');
  });

  it('never autolinks a bare URL from a parameter value', () => {
    const { container } = render(<MarkdownWidget text="See {R}" values={{ R: 'https://evil.example www.evil.example' }} />);
    expect(container.querySelector('[role="link"]')).toBeNull();
  });
});

describe('withValues', () => {
  it('substitutes known names, escaped, and keeps unknown ones', () => {
    expect(withValues('Range {TimeRange}', { TimeRange: '7d' })).toBe('Range 7d');
    expect(withValues('{A}', { A: '[y](https://evil)' })).toBe('\\[y\\]\\(https://evil\\)');
    expect(withValues('{Nope}', {})).toBe('{Nope}');
    expect(withValues('{constructor} {__proto__} {toString}', {})).toBe('{constructor} {__proto__} {toString}');
  });

});
